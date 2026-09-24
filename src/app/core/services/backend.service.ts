import { Injectable } from '@angular/core';
import PocketBase, { type RecordModel } from 'pocketbase';
import {
  createEmptySiteTopology,
  parseTopology,
  parseBoardDef,
  parseExpansionBoardDef,
  parseSiteImport,
} from '@core';
import type { ExpansionBoardCatalog, ExpansionBoardDef, CommandAction, StoredSiteTopology } from '@core';
import { HOSTING_DEVICE_CAP } from '@core';
import type {
  SiteCatalogItem,
  SiteListEntry,
  SiteFullPayload,
  SiteSavePayload,
  BoardListEntry,
  BoardLoadResult,
  BoardDef,
  Controller,
  SiteTopology,
  DeviceEntry,
  CustomerEntry,
  AppConfig,
  AppConfigRecord,
  AccountProfile,
  LeadEntry,
  DocEntry,
  DocDraft,
  SiteDiagrams,
  BoardBundle,
} from '../models/backend-api';
import { sha256Hex } from '../util/hash';
import type { Attribution } from './tracking.service';

/**
 * PocketBase base URL. When the SPA is served by maji-server it is same-origin;
 * a dev override can be injected on `window` (e.g. when running `ng serve`
 * against a local backend on :8090).
 */
const PB_URL: string =
  (globalThis as { __MAJI_PB_URL__?: string }).__MAJI_PB_URL__ ?? '/';

/**
 * BackendService — the light gateway from the Angular app to the MajiFlow
 * backend: site/customer/device/lead/doc persistence, auth, the board catalog,
 * and runtime commands, all over PocketBase. It stays free of the heavy firmware
 * toolchain so it can sit in the eager bundle; validation, ESPHome generation,
 * provisioning and versioning live in the lazy {@link BuildService}.
 */
@Injectable({ providedIn: 'root' })
export class BackendService {
  readonly pb = new PocketBase(PB_URL);
  /** Multiple shell/page consumers often need the same site during navigation.
   * PocketBase auto-cancels duplicate requests, so share one in-flight load
   * instead of letting the loser fall back to a raw record id. */
  private siteLoads = new Map<string, Promise<SiteFullPayload>>();

  // --- Sites ---------------------------------------------------------------

  async siteList(): Promise<RecordModel[]> {
    return this.pb.collection('sites').getFullList({
      sort: 'name',
      requestKey: 'sites:list',
    });
  }

  siteLoad(id: string): Promise<SiteFullPayload> {
    const active = this.siteLoads.get(id);
    if (active) return active;
    const request = this.loadSite(id).finally(() => {
      if (this.siteLoads.get(id) === request) this.siteLoads.delete(id);
    });
    this.siteLoads.set(id, request);
    return request;
  }

  private async loadSite(id: string): Promise<SiteFullPayload> {
    // Expand `owner` to a contact directory — name + email for each co-owner the
    // viewer may read (same-site, per migration 32). Best-effort: records the rule
    // hides simply don't appear; the activity feed falls back to the owner-id set.
    const r = await this.pb.collection('sites').getOne(id, { expand: 'owner' });
    const owners = (r['owner'] ?? []) as string[];
    const ownerRecords = ((r['expand'] as Record<string, RecordModel[]> | undefined)?.['owner'] ?? []);
    const people = ownerRecords.map((u) => ({ id: u['id'] as string, name: u['name'] as string | undefined, email: u['email'] as string | undefined }));
    const mode = r['mode'];
    const deployment = (mode === 'managed' || mode === 'local')
      ? {
          mode,
          brokerHost: (r['broker_host'] ?? '') as string,
          brokerPort: (r['broker_port'] ?? 0) as number,
          brokerTls: !!r['broker_tls'],
        }
      : undefined;
    return {
      site: { id: r.id, friendlyName: r['name'], deployment, owners, people, commenceDate: (r['commence_date'] ?? '') as string, display_timezone: (r['display_timezone'] ?? '') as string },
      topology: (r['draft_topology'] ?? null) as SiteFullPayload['topology'],
    };
  }

  async siteSave(payload: SiteSavePayload): Promise<void> {
    const d = payload.site.deployment;
    await this.pb.collection('sites').update(payload.site.id, {
      name: payload.site.friendlyName,
      draft_topology: payload.topology,
      ...(d
        ? { mode: d.mode, broker_host: d.brokerHost, broker_port: d.brokerPort, broker_tls: d.brokerTls }
        : {}),
    });
  }

  async siteCreate(slug: string, friendlyName: string, topology?: StoredSiteTopology): Promise<{ id: string }> {
    const me = this.pb.authStore.record?.id;
    const r = await this.pb.collection('sites').create({
      name: friendlyName,
      slug,
      draft_topology: topology ?? createEmptySiteTopology(),
      owner: me ? [me] : [],
    });
    return { id: r.id };
  }

  async siteRename(id: string, friendlyName: string): Promise<void> {
    await this.pb.collection('sites').update(id, { name: friendlyName });
  }

  /** Customers an admin can hand a site to (users with role=customer). */
  async customerList(): Promise<CustomerEntry[]> {
    const records = await this.pb.collection('users').getFullList({
      filter: this.pb.filter('role = {:r}', { r: 'customer' }),
      sort: 'name',
      requestKey: 'users:customers',
    });
    return records.map((r) => this.toCustomerEntry(r));
  }

  /** Create a customer account, optionally emailing a set-password invite.
   *  `invited` is false when the invite was skipped (`invite: false`, e.g. lead
   *  conversion, which leaves invites to a later admin step) or when the email
   *  send failed (e.g. SMTP not configured); either way the account exists and
   *  customerInvite can send it. Admin-only server-side. */
  async customerCreate(
    input: { name: string; email: string; phone?: string },
    opts: { invite?: boolean } = {},
  ): Promise<{ customer: CustomerEntry; invited: boolean }> {
    const password = this.randomPassword(); // never used by the customer; they set their own via the invite
    const me = this.pb.authStore.record?.id;
    const myRole = this.pb.authStore.record?.['role'];
    const myPartner = this.pb.authStore.record?.['partner'];
    const r = await this.pb.collection('users').create({
      name: input.name,
      email: input.email,
      phone: input.phone ?? '',
      emailVisibility: true,
      password,
      passwordConfirm: password,
      role: 'customer',
      ...(myRole === 'partner' && myPartner ? { partner: myPartner } : {}),
    });
    const customer = this.toCustomerEntry(r);
    if (opts.invite === false) return { customer, invited: false };
    let invited = true;
    try {
      await this.pb.collection('users').requestPasswordReset(input.email);
    } catch {
      invited = false;
    }
    return { customer, invited };
  }

  async customerUpdate(id: string, patch: { name: string; email: string; phone: string }): Promise<void> {
    await this.pb.collection('users').update(id, patch);
  }

  async customerDelete(id: string): Promise<void> {
    await this.pb.collection('users').delete(id);
  }

  /** (Re)send a customer their set-password invite email. */
  async customerInvite(email: string): Promise<void> {
    await this.pb.collection('users').requestPasswordReset(email);
  }

  private toCustomerEntry(r: RecordModel): CustomerEntry {
    return {
      id: r['id'],
      name: (r['name'] ?? '') as string,
      email: (r['email'] ?? '') as string,
      phone: (r['phone'] ?? '') as string,
      verified: !!r['verified'],
      created: (r['created'] ?? '') as string,
    };
  }

  /** A throwaway password that satisfies the min-length rule; the customer never
   *  sees it (they set their own via the invite link). */
  private randomPassword(): string {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) + 'A1';
  }

  /** Set a site's full co-owner set (admin-only; the owner-change guard rejects
   *  non-admins server-side). Pass the complete list — it replaces the current set. */
  async siteSetOwners(siteId: string, userIds: string[]): Promise<void> {
    await this.pb.collection('sites').update(siteId, { owner: userIds });
  }

  async siteDelete(id: string): Promise<void> {
    await this.pb.collection('sites').delete(id);
  }

  async siteExport(id: string): Promise<{ json: string }> {
    const payload = await this.siteLoad(id);
    return { json: JSON.stringify(payload, null, 2) };
  }

  async siteImport(text: string): Promise<{ id: string }> {
    // Validate + migrate the payload via core (throws on malformed JSON/graph)
    // instead of trusting a raw cast.
    const parsed = parseSiteImport(JSON.parse(text));
    const me = this.pb.authStore.record?.id;
    const r = await this.pb.collection('sites').create({
      name: parsed.friendlyName,
      slug: this.slugify(parsed.friendlyName),
      draft_topology: parsed.topology,
      owner: me ? [me] : [],
    });
    return { id: r['id'] };
  }

  // --- Leads (public marketing form) --------------------------------------

  /**
   * Persist a pricing-page enquiry. Unauthenticated: the `leads` collection's
   * create rule is public (consent + honeypot enforced server-side). The
   * estimate snapshot rides along so followup has the visitor's configuration.
   */
  async leadCreate(input: {
    name: string;
    phone: string;
    email: string;
    consent: boolean;
    estimate: unknown;
    hp: string;
    attrib?: Attribution;
  }): Promise<void> {
    await this.pb.collection('leads').create({
      name: input.name,
      phone: input.phone,
      email: input.email,
      consent: input.consent,
      estimate: input.estimate,
      source: 'pricing',
      hp: input.hp,
      // First-touch marketing attribution (UTMs / landing page / referrer),
      // captured by TrackingService; undefined keys are dropped by the SDK.
      ...input.attrib,
    });
  }

  // --- Devices (registered controllers) + global config -------------------
  //
  // A "device" is a `controllers` collection row — the provisioned identity
  // minted at /provision, distinct from the design-time controllers in a site's
  // topology. The Devices fleet view manages these; the firmware page surfaces a
  // single device's registration status. Update/delete are admin-only (collection
  // rules); read is admin-or-site-owner.

  /** Admin-tunable global settings; falls back to the core default if unset. */
  async getConfig(): Promise<AppConfig> {
    const r = await this.pb.send<{ hostingDeviceCap?: number }>('/api/farmon/config', { method: 'GET' });
    return { hostingDeviceCap: r.hostingDeviceCap ?? HOSTING_DEVICE_CAP };
  }

  async accountProfile(): Promise<AccountProfile> {
    const r = await this.pb.send<AccountProfile>('/api/farmon/account', { method: 'GET' });
    const role = r.role === 'admin' || r.role === 'partner' ? r.role : 'customer';
    return {
      id: r.id,
      name: r.name ?? '',
      email: r.email ?? '',
      phone: r.phone ?? '',
      role,
    };
  }

  async accountSave(patch: { name: string; phone: string }): Promise<AccountProfile> {
    const r = await this.pb.send<AccountProfile>('/api/farmon/account', {
      method: 'PATCH',
      body: patch,
    });
    const role = r.role === 'admin' || r.role === 'partner' ? r.role : 'customer';
    return {
      id: r.id,
      name: r.name ?? '',
      email: r.email ?? '',
      phone: r.phone ?? '',
      role,
    };
  }

  async sendTestNotification(input: { number: string; countryCode: string }): Promise<{ chatId: string }> {
    const r = await this.pb.send<{ chat_id: string }>('/api/farmon/alerts/test', {
      method: 'POST',
      body: {
        number: input.number,
        country_code: input.countryCode,
      },
    });
    return { chatId: r.chat_id };
  }

  /** Every registered device across all sites the caller can see, with site names. */
  async deviceList(): Promise<DeviceEntry[]> {
    const records = await this.pb
      .collection('controllers')
      .getFullList({ sort: 'name', expand: 'site', requestKey: 'controllers:list' });
    return records.map((r) => this.toDeviceEntry(r));
  }

  /** Registered devices for one site (the per-site slice). */
  async deviceListForSite(siteId: string): Promise<DeviceEntry[]> {
    const records = await this.pb.collection('controllers').getFullList({
      filter: this.pb.filter('site = {:s}', { s: siteId }),
      sort: 'name',
      expand: 'site',
      requestKey: `controllers:by-site:${siteId}`,
    });
    return records.map((r) => this.toDeviceEntry(r));
  }

  /** Registry status of one device by its device_id (== controller record id), or
   *  null if its design has not been saved yet (no controllers row). */
  async deviceStatus(deviceId: string): Promise<DeviceEntry | null> {
    try {
      const r = await this.pb.collection('controllers').getOne(deviceId, { expand: 'site' });
      return this.toDeviceEntry(r);
    } catch {
      return null; // 404 → not yet registered
    }
  }

  async deviceRename(id: string, name: string): Promise<void> {
    await this.pb.collection('controllers').update(id, { name });
  }

  /** Deregister a device: marks it inactive (active=false) so the broker rejects
   *  its connection and a hosting-cap slot frees. The row, history and secrets are
   *  kept — reversible via deviceReactivate. The physical box keeps its firmware
   *  until reflashed. */
  async deviceDeregister(id: string): Promise<void> {
    await this.pb.collection('controllers').update(id, { active: false });
  }

  /** Reactivate a deregistered device. Subject to the hosting device cap on
   *  managed sites (enforced server-side), so it can fail with a cap error. */
  async deviceReactivate(id: string): Promise<void> {
    await this.pb.collection('controllers').update(id, { active: true });
  }

  /** Clear a controller's hardware binding after a flagged MAC conflict — use when
   *  the board was legitimately replaced (RMA). The next board to connect re-binds
   *  `first_mac` fresh. Admin-only (controllers UpdateRule). */
  async deviceClearMacBinding(id: string): Promise<void> {
    await this.pb
      .collection('controllers')
      .update(id, { first_mac: '', mac_conflict: false, conflict_mac: '' });
  }

  /** The editable app_config singleton (admin settings page). Reads the row
   *  directly (admin-gated collection) since editing needs the record id. */
  async configForEdit(): Promise<AppConfigRecord> {
    const r = await this.pb.collection('app_config').getFirstListItem('id != ""');
    return { id: r['id'], hostingDeviceCap: (r['hosting_device_cap'] ?? HOSTING_DEVICE_CAP) as number };
  }

  async configSave(id: string, patch: { hostingDeviceCap: number }): Promise<void> {
    await this.pb.collection('app_config').update(id, { hosting_device_cap: patch.hostingDeviceCap });
  }

  // --- Leads (admin pipeline) ---------------------------------------------

  /** Captured pricing enquiries, newest first (admin-only collection). */
  async leadList(): Promise<LeadEntry[]> {
    const records = await this.pb.collection('leads').getFullList({ sort: '-created', requestKey: 'leads:list' });
    return records.map((r) => ({
      id: r['id'],
      name: (r['name'] ?? '') as string,
      phone: (r['phone'] ?? '') as string,
      email: (r['email'] ?? '') as string,
      consent: !!r['consent'],
      source: (r['source'] ?? '') as string,
      status: (r['status'] ?? '') as string,
      estimate: (r['estimate'] || null) as LeadEntry['estimate'],
      created: (r['created'] ?? '') as string,
    }));
  }

  async leadSetStatus(id: string, status: string): Promise<void> {
    await this.pb.collection('leads').update(id, { status });
  }

  /** Close a lead and record the site it was converted into. The link rides the
   *  estimate JSON (no dedicated column); the current estimate is merged so its
   *  snapshot + profile are preserved. */
  async leadMarkConverted(id: string, siteId: string, estimate: LeadEntry['estimate']): Promise<void> {
    await this.pb.collection('leads').update(id, {
      status: 'closed',
      estimate: { ...(estimate ?? {}), convertedSiteId: siteId },
    });
  }

  async leadDelete(id: string): Promise<void> {
    await this.pb.collection('leads').delete(id);
  }

  // --- Controllers ("systems") --------------------------------------------
  //
  // Controllers live inside `sites.draft_topology`. `systemCreateBlank` mints a
  // Controller that the workspace appends to the topology and persists via
  // `siteSave`. The topology removal itself is recorded by the subsequent
  // `siteSave`; `systemDelete` additionally deregisters the controller's
  // provisioned device row (minted at /provision) so it doesn't outlive the design.

  async systemCreateBlank(
    _siteId: string,
    friendlyName: string,
    board: string,
  ): Promise<Controller> {
    return {
      id: this.newControllerId(friendlyName),
      board,
      friendlyName,
    };
  }

  async systemDelete(_siteId: string, systemId: string): Promise<void> {
    // The topology removal is persisted by the workspace's subsequent siteSave().
    // Here we also deregister the controller's provisioned device (the `controllers`
    // registry row) so it doesn't outlive the design — otherwise it lingers as a
    // ghost on the Devices fleet, keeps consuming a hosting-cap slot, and the broker
    // keeps accepting it. Deregister (not delete): the row, history and secrets are
    // kept and reactivatable from the Devices page. The editor is admin-only, so the
    // admin-only `controllers` update rule is satisfied by the SDK call directly.
    try {
      await this.deviceDeregister(systemId);
    } catch (err) {
      // A never-provisioned (design-only) controller has no registry row (404) —
      // nothing to deregister. Re-throw anything else so a real failure surfaces.
      if ((err as { status?: number })?.status !== 404) throw err;
    }
  }

  // --- Controller config (runtime tunables / calibration) -----------------

  /**
   * Write desired tunables / calibration to the server-owned config. This is the
   * cloud half of the SINGLE config write path (the device build overrides it with
   * per-key `config_set` commands over /local/command): upsert the controller's
   * `desired` key→value bag into the `controller_config` collection, and a server
   * Register hook recomputes the canonical payload + sha256 `version` and
   * republishes the retained /config message (the device applies it and round-trips
   * the version back as the snapshot `config_version`). The client never hashes and
   * never sends a per-key command — convergence is the server's desired-vs-applied
   * reconcile, and the shadow heals the displayed value once the device re-publishes
   * the applied numbers. One row per controller, joined on the `controller` text id
   * (unique index); `desired` is the only field a client writes. The caller passes
   * the site id for the first-write create (a designed-but-never-provisioned
   * controller has no `controllers` registry row to read it from — that lookup
   * used to 404 the first write).
   */
  async writeControllerConfig(siteId: string, controller: string, patch: Record<string, number>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const existing = await this.pb
      .collection('controller_config')
      .getFirstListItem(this.pb.filter('controller = {:c}', { c: controller }))
      .catch(() => null);
    if (existing) {
      const desired = { ...(existing['desired'] as Record<string, number> | null ?? {}), ...patch };
      await this.pb.collection('controller_config').update(existing.id, { desired });
    } else {
      // First-ever write for this controller: the new row needs its `site` for
      // the collection rules — the caller has it (the route param).
      await this.pb.collection('controller_config').create({
        site: siteId,
        controller,
        desired: patch,
      });
    }
  }

  // --- Boards (DB catalog) ------------------------------------------------
  //
  // The `boards` collection is the source of truth. Records are keyed by
  // `model` (the id controllers reference); `def` holds the parsed board
  // definition (imported from board.json) and `svg` an optional diagram file.

  async boardList(): Promise<BoardListEntry[]> {
    const records = await this.pb
      .collection('boards')
      .getFullList({ sort: 'label', requestKey: 'boards:list' });
    return records.map((r) => ({
      id: r['id'],
      model: r['model'],
      label: r['label'] || r['model'],
      kind: r['kind'] === 'expansion' ? 'expansion' : 'main',
    }));
  }

  async boardLoad(model: string): Promise<BoardLoadResult> {
    const r = await this.pb
      .collection('boards')
      .getFirstListItem(this.pb.filter('model = {:m}', { m: model }), { requestKey: `board-def:${model}` });
    return {
      board: r['def'] as BoardDef,
      svg: r['svg'] ? this.pb.files.getURL(r, r['svg']) : null,
    };
  }

  /**
   * Expansion-board catalog (`{ model → def }`) for the codegen provider
   * factory and the editor's expansion-board picker. Replaces the former
   * hardcoded `BUILTIN_EXPANSION_BOARDS` map — the set is now DB data.
   */
  async expansionCatalog(): Promise<ExpansionBoardCatalog> {
    const records = await this.pb
      .collection('boards')
      .getFullList({ filter: this.pb.filter('kind = {:k}', { k: 'expansion' }), requestKey: 'boards:expansion' });
    const catalog: ExpansionBoardCatalog = {};
    for (const r of records) {
      catalog[r['model']] = r['def'] as ExpansionBoardDef;
    }
    return catalog;
  }

  /** True when the signed-in user may mutate the board catalog (admin-only). */
  get isAdmin(): boolean {
    return this.pb.authStore.record?.['role'] === 'admin';
  }

  /**
   * Import a board into the DB catalog from a JSON definition. The def is
   * validated by core (`parseBoardDef` / `parseExpansionBoardDef`) before any
   * write, so malformed boards are rejected up front. Main controller boards
   * additionally require an SVG diagram (the canvas renders pin overlays on it);
   * expansion boards are pure data. Server-side rule restricts this to admins.
   */
  async boardImport(
    defText: string,
    kind: 'main' | 'expansion',
    svg?: File,
  ): Promise<{ id: string }> {
    const raw: unknown = JSON.parse(defText);
    if (kind === 'expansion') {
      const def = parseExpansionBoardDef(raw);
      const r = await this.pb.collection('boards').create({
        model: def.model, label: def.label, kind: 'expansion', version: 1, def,
      });
      return { id: r['id'] };
    }
    const def = parseBoardDef(raw);
    if (!svg) throw new Error('Main controller boards require an SVG diagram file.');
    const r = await this.pb.collection('boards').create({
      model: def.model, label: def.label, kind: 'main', version: 1, def, svg,
    });
    return { id: r['id'] };
  }

  // --- Documentation -------------------------------------------------------
  //
  // The `docs` collection holds product narrative + node-type prose (board
  // reference docs live in the board `def`). The per-site document is assembled
  // in-browser from live topology + cached diagrams + these rows. Read is
  // authed; writes are admin-only (collection rules).

  /** All docs, ordered. */
  async docList(): Promise<DocEntry[]> {
    const records = await this.pb.collection('docs').getFullList({ sort: 'order,slug', requestKey: 'docs:list' });
    return records.map((r) => this.toDocEntry(r));
  }

  async docCreate(d: DocDraft): Promise<{ id: string }> {
    const r = await this.pb.collection('docs').create({
      slug: d.slug, title: d.title, category: d.category, order: d.order, body: d.body,
    });
    return { id: r['id'] };
  }

  async docSave(id: string, d: DocDraft): Promise<void> {
    await this.pb.collection('docs').update(id, {
      slug: d.slug, title: d.title, category: d.category, order: d.order, body: d.body,
    });
  }

  async docDelete(id: string): Promise<void> {
    await this.pb.collection('docs').delete(id);
  }

  /** The site's cached documentation diagrams (empty when never published). */
  async loadSiteDiagrams(siteId: string): Promise<SiteDiagrams> {
    const r = await this.pb.collection('sites').getOne(siteId, { fields: 'doc_diagrams' });
    const d = (r['doc_diagrams'] ?? null) as Partial<SiteDiagrams> | null;
    return {
      composite: d?.composite ?? '',
      controllers: d?.controllers ?? {},
      boardPinouts: d?.boardPinouts ?? {},
      topoHash: d?.topoHash,
      generatedAt: d?.generatedAt,
    };
  }

  /** Cache the admin-rendered diagrams on the site (for the customer view),
   *  stamped with the topology hash they were rendered from and the time. */
  async saveSiteDiagrams(siteId: string, topo: SiteTopology, diagrams: SiteDiagrams): Promise<void> {
    const topoHash = await sha256Hex(JSON.stringify(topo));
    const generatedAt = new Date().toISOString();
    await this.pb.collection('sites').update(siteId, { doc_diagrams: { ...diagrams, topoHash, generatedAt } });
  }

  /** Publication status of a site's docs for the deploy page: when they were last
   *  generated, whether anything is published, and whether the topology has
   *  changed since (stale — customer sees no diagrams until regenerated). The
   *  stale check needs Web Crypto; if it's unavailable it's skipped, never wrong. */
  async docStatus(siteId: string): Promise<{ generatedAt?: string; published: boolean; stale: boolean }> {
    const d = await this.loadSiteDiagrams(siteId);
    const published = !!(d.topoHash || d.composite || Object.keys(d.controllers).length > 0);
    let stale = false;
    if (published && d.topoHash) {
      try {
        const topo = await this.siteTopology(siteId);
        stale = (await sha256Hex(JSON.stringify(topo))) !== d.topoHash;
      } catch { /* can't compare (e.g. non-secure context) → don't claim stale */ }
    }
    return { generatedAt: d.generatedAt, published, stale };
  }

  /**
   * Assemble the site's documentation HTML in the browser: live topology +
   * cached (or caller-supplied) diagrams + board/node/narrative docs, with
   * `{{slot}}` values filled live. Pass `override.diagrams` on the admin side to
   * use freshly-rendered diagrams; the customer path uses the stored ones.
   */
  async buildSiteDoc(siteId: string, override?: { diagrams?: SiteDiagrams }): Promise<string> {
    const { topology, site } = await this.siteLoad(siteId);
    if (!topology) throw new Error('This site has no topology to document yet.');
    const topo = parseTopology(topology);
    let diagrams = override?.diagrams ?? (await this.loadSiteDiagrams(siteId));
    // Stored diagrams are structural — if the topology has changed since they were
    // published, drop them rather than show a diagram that no longer matches.
    if (!override?.diagrams) {
      const currentHash = await sha256Hex(JSON.stringify(topo));
      if (diagrams.topoHash !== currentHash) {
        const neverPublished = !diagrams.topoHash && Object.keys(diagrams.controllers).length === 0;
        console.warn(
          `[site-docs] no diagrams shown for site ${siteId}: ` +
          (neverPublished
            ? 'none have been published yet — open the deploy page and click "Generate docs".'
            : `the cached diagrams are stale (topology changed since they were published) — regenerate from the deploy page.`),
        );
        diagrams = { composite: '', controllers: {}, boardPinouts: {} };
      }
    }
    const boards = await this.boardDefsForModels(new Set(topo.controllers.map((c) => c.board)));
    const docs = await this.docList();
    const devices = await this.deviceListForSite(siteId);
    // Lazy: pulls the assembler + micromustache + marked into a dynamic chunk,
    // keeping them out of the initial bundle.
    const { assembleSiteDoc } = await import('@core/docs');
    return assembleSiteDoc({
      siteName: site.friendlyName,
      siteId,
      commenceDate: site.commenceDate ?? '',
      topo, diagrams, boards, docs,
      devices: devices.map((d) => ({
        deviceId: d.deviceId, board: d.boardType, firmware: d.firmwareVersion,
        online: d.online, lastSeen: d.lastSeen,
      })),
    });
  }

  /** The site's parsed topology (for offscreen diagram rendering on the admin side). */
  async siteTopology(siteId: string): Promise<SiteTopology> {
    const { topology } = await this.siteLoad(siteId);
    if (!topology) throw new Error('This site has no topology yet.');
    return parseTopology(topology);
  }

  /** Resolve `{ model → BoardDef }` for the given board models (skips any missing). */
  async boardDefsForModels(models: Set<string>): Promise<Record<string, BoardDef>> {
    const out: Record<string, BoardDef> = {};
    for (const model of models) {
      try { out[model] = (await this.boardLoad(model)).board; } catch { /* board not in catalog — skip */ }
    }
    return out;
  }

  /**
   * Fetch a board's SVG diagram as raw markup. The catalog stores it as a
   * protected file (collection ViewRule = authed), so we mint a short-lived file
   * token and download it. Returns '' when the board has no diagram. The board
   * def's own `svg` field is only the source filename, not the markup.
   */
  async boardSvg(model: string): Promise<string> {
    try {
      const r = await this.pb
        .collection('boards')
        .getFirstListItem(this.pb.filter('model = {:m}', { m: model }), { requestKey: `board-svg:${model}` });
      if (!r['svg']) return '';
      const token = await this.pb.files.getToken();
      const res = await fetch(this.pb.files.getURL(r, r['svg'] as string, { token }));
      if (!res.ok) return '';
      const text = await res.text();
      return text.includes('<svg') ? text : '';
    } catch { return ''; }
  }

  /** `{ model → { def, svg } }` with each board's SVG fetched as raw markup, for pinout rendering. */
  async boardBundles(models: Set<string>): Promise<Record<string, BoardBundle>> {
    const out: Record<string, BoardBundle> = {};
    for (const model of models) {
      try {
        out[model] = { def: (await this.boardLoad(model)).board, svg: await this.boardSvg(model) };
      } catch { /* board not in catalog — skip */ }
    }
    return out;
  }

  private toDocEntry(r: RecordModel): DocEntry {
    return {
      id: r['id'],
      slug: (r['slug'] ?? '') as string,
      title: (r['title'] ?? '') as string,
      category: (r['category'] ?? 'narrative') as DocEntry['category'],
      order: (r['order'] ?? 0) as number,
      body: (r['body'] ?? '') as string,
      updated: (r['updated'] ?? '') as string,
    };
  }

  // --- Commands (runtime) --------------------------------------------------

  /**
   * Send an operator command to a controller. The server authorizes it, records
   * it for audit, and publishes it over MQTT; the device's shadow / transition
   * log reflects the outcome (the dashboard reconciles from there — there is no
   * reply channel). Returns the command id for correlation.
   */
  async sendCommand(
    siteId: string,
    controller: string,
    action: CommandAction,
    args: { routeId?: number; nodeId?: string; on?: boolean; key?: string; value?: number; commandId?: string; reclaim?: boolean;
      override_mask?: number; ov_source_min_pct?: number; ov_dest_max_pct?: number;
      ov_max_runtime_min?: number; ov_target_duration_s?: number; ov_target_volume_l?: number } = {},
  ): Promise<string> {
    const res = await this.pb.send<{ command_id?: string }>('/api/farmon/command', {
      // No auto-cancellation: commands fan out concurrently (e.g. a stop-all then a
      // route start), and they'd otherwise share the method+path auto-key and abort
      // each other ("request was autocancelled"). Every command must reach the server,
      // so opt this request out entirely.
      requestKey: null,
      method: 'POST',
      body: {
        site: siteId,
        controller,
        action,
        route_id: args.routeId,
        node_id: args.nodeId,
        on: args.on,
        key: args.key,
        value: args.value,
        // route_start StopSpec override (server forwards them; absent ⇒ route defaults).
        override_mask: args.override_mask,
        ov_source_min_pct: args.ov_source_min_pct,
        ov_dest_max_pct: args.ov_dest_max_pct,
        ov_max_runtime_min: args.ov_max_runtime_min,
        ov_target_duration_s: args.ov_target_duration_s,
        ov_target_volume_l: args.ov_target_volume_l,
        // A reclaim re-asserts an existing hold's command_id as a publish-only
        // keepalive: the server republishes it (fresh issued_at) to refresh the
        // device dead-man lease, but records no new audit row.
        command_id: args.commandId,
        reclaim: args.reclaim,
      },
    });
    if (!res.command_id) throw new Error('Command was not accepted.');
    return res.command_id;
  }

  // --- Helpers -------------------------------------------------------------

  private toDeviceEntry(r: RecordModel): DeviceEntry {
    const site = r['expand']?.['site'] as RecordModel | undefined;
    return {
      id: r['id'],
      deviceId: r['id'] as string, // the record id IS the device_id
      name: (r['name'] ?? '') as string,
      siteId: (r['site'] ?? '') as string,
      siteName: (site?.['name'] ?? '') as string,
      boardType: (r['board_type'] ?? '') as string,
      firmwareVersion: (r['firmware_version'] ?? '') as string,
      active: !!r['active'],
      online: !!r['online'],
      lastSeen: (r['last_seen'] ?? '') as string,
      created: (r['created'] ?? '') as string,
      macConflict: !!r['mac_conflict'],
      conflictMac: (r['conflict_mac'] ?? '') as string,
    };
  }

  /** Mint a globally-unique controller id (the provision PK / MQTT identity).
   *  Shared by the Expert blank-system flow and Easy Mode, so neither produces a
   *  colliding id. */
  newControllerId(friendlyName: string): string {
    const base = this.slugify(friendlyName) || 'controller';
    // Suffix is a slice of a v4 UUID (crypto, secure context) so two controllers
    // sharing a friendly name still get distinct ids — the id is the MQTT username
    // and PK, and /provision find-or-creates by it, so a collision would silently
    // merge two designs into one identity.
    return `${base}-${crypto.randomUUID().slice(0, 8)}`;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}
