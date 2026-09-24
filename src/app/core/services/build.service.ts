import { Injectable, inject } from '@angular/core';
import type { RecordModel } from 'pocketbase';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
  buildGraph,
  deriveRoutes,
  parseTopology,
  topologyToManifestForController,
  listAutomatableRoutes,
  routeSetVersion,
  CURRENT_SCHEMA_VERSION,
} from '@core';
import type { ExpansionBoardCatalog, DeploymentMode } from '@core';
import {
  generateEsphome,
  generateDefaultSecrets,
  generateLocalUiAssetsHeader,
  localUiFirmwareMaterial,
  type GeneratedFile,
  type SecretsMap,
  type GenerationMetadata,
} from '@core/codegen';
import { validateAll } from '@core/rules';
import type {
  Controller,
  ValidateRequest,
  ValidationResult,
  GenerateResult,
  SiteTopology,
  VersionEntry,
  CommitResult,
  SiteFullPayload,
  BoardDef,
} from '../models/backend-api';
import { BackendService } from './backend.service';
import { BoardService } from './board.service';
import { sha256Hex } from '../util/hash';

/** Firmware app version stamped into generation metadata (fleet provenance). */
const APP_VERSION = '1.0.0';

/** An OTA firmware release row (subset the Deploy page reads). */
export interface FirmwareRelease {
  id: string;
  version: string;
  md5: string;
  size?: number;
  status?: 'uploaded' | 'deployed' | 'confirmed' | 'failed';
  deployed_at?: string;
  created?: string;
}

/** Firmware deployment config (server-level): where devices reach the broker. */
interface DeploymentConfig {
  brokerAddress: string;
  brokerPort: number;
  mode: DeploymentMode;
  /** Device connects over TLS (managed cloud). Local on-site brokers stay plain. */
  brokerTls: boolean;
  /** PEM of the CA to pin in firmware when brokerTls; empty otherwise. */
  brokerCa: string;
}

/**
 * BuildService — the firmware/build pipeline: validation, ESPHome generation,
 * provisioning, deployment resolution, zipping, and the immutable commit/version
 * history. Split out of {@link BackendService} so the heavy toolchain it pulls
 * (`@core/codegen`, `@core/rules`, `fflate`) lands only in the lazy editor/deploy
 * chunks — never in the eager bundle the public/customer pages download.
 *
 * Reachable ONLY from lazy admin routes (editor, deploy). It reuses
 * BackendService for the shared PocketBase client and the light reads it needs
 * (siteLoad / boardLoad / expansionCatalog).
 */
@Injectable({ providedIn: 'root' })
export class BuildService {
  private backend = inject(BackendService);
  private boardCatalog = inject(BoardService);
  private get pb() {
    return this.backend.pb;
  }

  // --- Domain operations (run in-browser via @core) ---------------

  async deriveRoutes(
    topology: SiteTopology,
  ): Promise<Array<{ key: string; name: string }>> {
    const graph = buildGraph(topology.nodes, topology.pipes);
    return deriveRoutes(graph).map((r) => ({
      key: r.key,
      name: `${r.source} → ${r.destination}`,
    }));
  }

  async validate(request: ValidateRequest): Promise<ValidationResult> {
    let topo: SiteTopology;
    let board: BoardDef;
    let mode: DeploymentMode;
    const controllerId = request.controllerId;

    if (request.kind === 'live') {
      topo = request.topology;
      board = request.board;
      mode = request.mode ?? 'managed';
    } else {
      const loaded = await this.loadTopology(request.siteId);
      topo = loaded.topo;
      const ctrl = topo.controllers.find((c) => c.id === controllerId);
      if (!ctrl) throw new Error(`Controller "${controllerId}" not found in site.`);
      board = (await this.backend.boardLoad(ctrl.board)).board;
      mode = loaded.site.deployment?.mode ?? 'managed';
    }

    const manifest = topologyToManifestForController(topo, controllerId);
    const expansionBoards = await this.boardCatalog.expansionDefs();
    // Validate against the site's chosen mode (online→managed, local), the same
    // mode generation bakes, so the editor surfaces exactly the cross-controller
    // errors generation enforces. Unchosen sites default to managed (online).
    return validateAll(topo, manifest, board, { expansionBoards, mode });
  }

  /**
   * Generate the ESPHome bundle for a single controller entirely in-browser,
   * zip it (with `fflate`), and return a downloadable object URL plus a file
   * manifest. The bundle is only config text + a `compile.sh` helper — no build
   * artifacts — so it stays a few KB.
   */
  async generate(
    siteId: string,
    controllerId: string,
  ): Promise<GenerateResult> {
    const { topo, site, topologyRaw } = await this.loadTopology(siteId);
    const ctrl = topo.controllers.find((c) => c.id === controllerId);
    if (!ctrl) throw new Error(`Controller "${controllerId}" not found in site.`);

    // Deployment (broker host/port + mode) is the site's saved Online/Local
    // choice; identity secrets are per-controller. Provision mints a fresh MQTT
    // token (rotated each build, only its hash stored) and a stable OTA password
    // (minted once, reused so OTA keeps working across rebuilds). Both are baked
    // into this build's secrets.yaml; wifi is NOT baked (captive portal → NVS).
    const deployment = await this.resolveDeployment(site);
    const prov = await this.provision(siteId, ctrl);
    const provisioned: SecretsMap = { ota_password: prov.ota_password, mqtt_token: prov.token, udp_key: prov.udp_key };

    const expansionBoards = await this.boardCatalog.expansionDefs();
    const built = await this.buildController(topo, ctrl, siteId, expansionBoards, deployment, provisioned, topologyRaw);
    const downloadUrl = URL.createObjectURL(this.zipBundle(built.files, true));

    return {
      files: built.files.map((f) => ({
        path: f.relativePath,
        description: f.description,
        lines: f.content.split('\n').length,
      })),
      downloadUrl,
      version: built.version,
    };
  }

  // --- Versioning / commit -------------------------------------------------

  /**
   * Commit the whole site: generate every controller's bundle, zip them
   * together, and store an immutable `topology_versions` row with the topology
   * snapshot. De-duplicated by `source_hash` — a no-op commit (inputs unchanged
   * since the latest version) returns that version without creating a new one.
   */
  async commit(siteId: string, note?: string): Promise<CommitResult> {
    const { topo, site, topologyRaw } = await this.loadTopology(siteId);

    const expansionBoards = await this.boardCatalog.expansionDefs();
    const deployment = await this.resolveDeployment(site);
    const allFiles: GeneratedFile[] = [];
    const hashParts: string[] = [];
    for (const ctrl of topo.controllers) {
      const built = await this.buildController(topo, ctrl, siteId, expansionBoards, deployment, undefined, topologyRaw);
      allFiles.push(...built.files);
      hashParts.push(built.hashPart);
    }
    const sourceHash = await sha256Hex(hashParts.join('|'));

    const prev = await this.latestVersion(siteId);
    if (prev && prev['source_hash'] === sourceHash) {
      return { id: prev['id'], version: prev['version'], deduped: true };
    }

    const nextVersion = ((prev?.['version'] as number) ?? 0) + 1;
    const blob = this.zipBundle(allFiles);

    const referenced = new Set<string>();
    for (const ctrl of topo.controllers) {
      referenced.add(ctrl.board);
      for (const p of ctrl.io_providers ?? []) referenced.add(p.type);
    }
    const boardVersions = await this.boardVersions(referenced);

    const fd = new FormData();
    fd.set('site', siteId);
    fd.set('version', String(nextVersion));
    fd.set('topology', JSON.stringify(topo));
    fd.set('board_versions', JSON.stringify(boardVersions));
    fd.set('source_hash', sourceHash);
    fd.set('committed_by', this.pb.authStore.record?.id ?? '');
    if (note) fd.set('note', note);
    fd.set('bundle', new File([blob], `bundle-v${nextVersion}.zip`, { type: 'application/zip' }));

    const rec = await this.pb.collection('topology_versions').create(fd);

    // Automations were already re-aligned per controller inside buildController (the
    // shared build funnel), so the whole-site commit needs no extra re-stamp here.
    return { id: rec['id'], version: nextVersion, deduped: false };
  }

  /**
   * Re-align ONE controller's automation rows to the route table just baked for it.
   * route_key is the stable identity; route_index + route_set_version are derived from
   * the manifest, so they're refreshed whenever routes change.
   *
   * Every row is stamped with the controller's current route_set_version, including
   * rows whose route_key has vanished: the device gates the WHOLE retained set on a
   * single version (the server copies the first row's value into the wire header), so
   * one lone stale row would otherwise make it refuse every automation on the
   * controller. A vanished route can't run, so its row is paused; its now-meaningless
   * index is left as-is (a disabled row's index is never used on-device).
   *
   * Called from buildController so EVERY firmware build (the per-controller Generate
   * and the whole-site Commit alike) re-aligns automations to the exact route table it
   * bakes. The device keeps its last-good set until reflashed to this build, so
   * publishing the re-stamp ahead of the flash is safe.
   */
  private async restampAutomations(siteId: string, topo: SiteTopology, controllerId: string): Promise<void> {
    const ver = routeSetVersion(topologyToManifestForController(topo, controllerId));
    const byKey = new Map(
      listAutomatableRoutes(topo)
        .filter((r) => r.controllerId === controllerId)
        .map((r) => [r.routeKey, r] as const),
    );
    const rows = await this.pb.collection('automations').getFullList({
      filter: this.pb.filter('site = {:s} && controller = {:c}', { s: siteId, c: controllerId }),
      requestKey: `automations:restamp:${siteId}:${controllerId}`,
    });
    for (const row of rows) {
      const patch: Record<string, unknown> = {};
      if (row['route_set_version'] !== ver) patch['route_set_version'] = ver;
      const match = byKey.get(row['route_key']);
      if (match) {
        if (row['route_index'] !== match.routeIndex) patch['route_index'] = match.routeIndex;
      } else if (row['enabled']) {
        patch['enabled'] = false; // route gone from this controller — pause it
      }
      if (Object.keys(patch).length) await this.pb.collection('automations').update(row['id'], patch);
    }
  }

  /** List a site's committed versions, newest first. */
  async listVersions(siteId: string): Promise<VersionEntry[]> {
    const records = await this.pb.collection('topology_versions').getFullList({
      filter: this.pb.filter('site = {:s}', { s: siteId }),
      sort: '-version',
      requestKey: `versions:${siteId}`,
    });
    return records.map((r) => ({
      id: r['id'],
      version: r['version'],
      sourceHash: r['source_hash'],
      note: r['note'] ?? '',
      committedAt: r['committed_at'] ?? r['created'] ?? '',
      bundleUrl: r['bundle'] ? this.pb.files.getURL(r, r['bundle']) : '',
    }));
  }

  /**
   * Roll the working draft back to a committed version's snapshot. Per the
   * versioning model this is non-destructive: it restores `draft_topology`;
   * re-committing then produces a new version.
   */
  async rollback(siteId: string, versionId: string): Promise<void> {
    const v = await this.pb.collection('topology_versions').getOne(versionId);
    await this.pb.collection('sites').update(siteId, {
      draft_topology: v['topology'],
    });
  }

  // --- Generation internals ------------------------------------------------

  private async loadTopology(siteId: string): Promise<{ topo: SiteTopology; site: SiteFullPayload['site']; topologyRaw: SiteFullPayload['topology'] }> {
    const { topology, site } = await this.backend.siteLoad(siteId);
    if (!topology) throw new Error('Site has no topology to generate from.');
    return { topo: parseTopology(topology), site, topologyRaw: topology };
  }

  /**
   * Provision a controller's runtime identity. The server (re)registers the
   * controller (`device_id == controller.id`, the wire `{ctrl}` segment / broker
   * username), mints a fresh MQTT token (storing only its bcrypt hash, which the
   * broker checks on connect), and returns a stable OTA password (minted once,
   * reused across builds so OTA keeps authenticating). Both are baked into this
   * build's `secrets.yaml`.
   */
  private async provision(siteId: string, ctrl: Controller): Promise<{ token: string; ota_password: string; udp_key: string }> {
    const res = await this.pb.send<{ token?: string; ota_password?: string; udp_key?: string }>('/api/farmon/provision', {
      method: 'POST',
      body: {
        site: siteId,
        controller: ctrl.id,
        name: ctrl.friendlyName ?? ctrl.id,
        board_type: ctrl.board,
      },
    });
    if (!res.token || !res.ota_password || !res.udp_key) throw new Error('Provisioning did not return the device secrets.');
    return { token: res.token, ota_password: res.ota_password, udp_key: res.udp_key };
  }

  /**
   * Upload a manually-built firmware binary for one controller. Authorized by the
   * admin's session (the server's requireSiteAccess) — NEVER a device secret. The
   * server computes the md5 and records a `firmware_releases` row (status
   * `uploaded`); nothing reaches the device until {@link deployFirmware}.
   */
  async uploadFirmware(siteId: string, controllerId: string, version: string, file: File): Promise<FirmwareRelease> {
    const fd = new FormData();
    fd.set('site', siteId);
    fd.set('controller', controllerId);
    fd.set('version', version);
    fd.set('firmware_bin', file);
    return this.pb.send<FirmwareRelease>('/api/farmon/firmware', { method: 'POST', body: fd });
  }

  /**
   * Tell the device to pull + flash a previously-uploaded release. The server mints
   * a short-lived download token, publishes the firmware_update command over MQTT,
   * and marks the release `deployed`; the device confirms by re-reporting the version.
   */
  async deployFirmware(siteId: string, controllerId: string, releaseId: string): Promise<{ command_id: string; status: string }> {
    return this.pb.send('/api/farmon/firmware/deploy', {
      method: 'POST',
      body: { site: siteId, controller: controllerId, release_id: releaseId },
    });
  }

  /** Latest firmware release for a controller — drives the Deploy page status chip. */
  async latestRelease(controllerId: string): Promise<FirmwareRelease | null> {
    const list = await this.pb.collection('firmware_releases').getList(1, 1, {
      // Param-bound (not string-interpolated) so an exotic controller id can't break
      // or inject into the filter.
      filter: this.pb.filter('controller = {:c}', { c: controllerId }),
      sort: '-created',
    });
    return (list.items[0] as unknown as FirmwareRelease) ?? null;
  }

  /**
   * Firmware deployment config (broker host/port + mode) — server-level, fetched
   * once and cached for the session. Devices bake `brokerAddress:brokerPort` to
   * reach the broker; `MAJI_MQTT_PUBLIC_HOST` on the server must point at a host
   * the device can actually reach (its LAN IP / public name).
   */
  private cloudDefaults?: { host: string; port: number; tls: boolean; ca: string };
  /** The managed-cloud broker defaults (mqtt.majiflow.io:8883 TLS) — the Online
   *  autofill source, plus the CA the firmware pins when TLS. Cached per session. */
  async cloudBrokerDefaults(): Promise<{ host: string; port: number; tls: boolean; ca: string }> {
    if (this.cloudDefaults) return this.cloudDefaults;
    const res = await this.pb.send<{
      broker_address?: string;
      broker_port?: number;
      broker_tls?: boolean;
      broker_ca?: string;
    }>('/api/farmon/deployment', { method: 'GET' });
    this.cloudDefaults = {
      host: res.broker_address ?? '',
      port: res.broker_port ?? 8883,
      tls: res.broker_tls ?? true,
      ca: res.broker_ca ?? '',
    };
    return this.cloudDefaults;
  }

  /**
   * Resolve a site's effective deployment for generation/validation from its
   * saved choice. Managed (or unchosen) → the cloud broker defaults; local →
   * the site's own broker address (port falls back to the cloud default).
   */
  private async resolveDeployment(site: SiteFullPayload['site']): Promise<DeploymentConfig> {
    const cloud = await this.cloudBrokerDefaults();
    const d = site.deployment;
    if (!d || d.mode === 'managed') {
      return {
        mode: 'managed',
        brokerAddress: cloud.host,
        brokerPort: cloud.port,
        brokerTls: cloud.tls,
        brokerCa: cloud.ca,
      };
    }
    // Local on-site brokers stay plain (no CA); local-site TLS is a separate feature.
    return {
      mode: 'local',
      brokerAddress: d.brokerHost,
      brokerPort: d.brokerPort || cloud.port,
      brokerTls: false,
      brokerCa: '',
    };
  }

  /** Build one controller's ESPHome files + its contribution to the source hash. */
  private async buildController(
    topo: SiteTopology,
    ctrl: Controller,
    siteId: string,
    expansionBoards: ExpansionBoardCatalog,
    deployment: DeploymentConfig,
    secrets?: SecretsMap,
    topologyRaw?: SiteFullPayload['topology'],
  ): Promise<{ files: GeneratedFile[]; hashPart: string; version: string }> {
    // Hard guard: an empty broker host bakes `broker: ""` into device.yaml, and
    // the device boots into "Couldn't resolve IP address for ''" forever. Refuse
    // to generate instead of shipping an unreachable firmware.
    if (!deployment.brokerAddress.trim()) {
      throw new Error(
        deployment.mode === 'local'
          ? `Cannot generate "${ctrl.friendlyName ?? ctrl.id}": no on-site server address. ` +
            `Set it under “How your controllers connect” on the site (My own server → server address).`
          : `Cannot generate "${ctrl.friendlyName ?? ctrl.id}": the MajiFlow Cloud broker is not ` +
            `configured on the server (MAJI_MQTT_PUBLIC_HOST is empty). Set it and retry.`,
      );
    }

    // A TLS broker with no CA would bake an empty `certificate_authority` — devices
    // couldn't verify it and would never connect. Refuse rather than ship that.
    if (deployment.brokerTls && !deployment.brokerCa.trim()) {
      throw new Error(
        `Cannot generate "${ctrl.friendlyName ?? ctrl.id}": the broker uses TLS but the server ` +
          `returned no CA. Enable TLS with a mounted cert (MAJI_MQTT_TLS_ENABLED + ` +
          `/certs/fullchain.pem) so the firmware can pin it.`,
      );
    }

    const { board } = await this.backend.boardLoad(ctrl.board);
    const manifest = topologyToManifestForController(topo, ctrl.id);

    const topologyJson = topologyRaw !== undefined ? JSON.stringify(topologyRaw) : undefined;
    // Build the local UI once, before versioning, so a UI-only release changes
    // the firmware version. Previously the hash covered only manifest + board;
    // OTA then answered ALREADY and skipped firmware whose embedded app changed.
    // Hash only the emitted blob/table section: the header's Source comment is
    // environment-specific and does not become firmware data.
    const localUiAssetsHeader = manifest.device.local?.ui === true
      ? await generateLocalUiAssetsHeader(manifest, topologyJson)
      : undefined;
    const localUiHash = localUiAssetsHeader
      ? await sha256Hex(localUiFirmwareMaterial(localUiAssetsHeader))
      : '';

    // Deterministic hash over topology-derived inputs, board, and the exact
    // embedded local UI. Secrets and build time remain excluded so rebuilding
    // identical firmware doesn't churn the version.
    const hashPart = JSON.stringify(manifest) + JSON.stringify(board) + localUiHash;
    const sourceHash = await sha256Hex(hashPart);
    const metadata: GenerationMetadata = {
      configSha: sourceHash,
      version: sourceHash.slice(0, 8),
      siteId,
      controllerId: ctrl.id,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      buildTimestamp: Math.floor(Date.now() / 1000),
      appVersion: APP_VERSION,
      mode: deployment.mode,
      brokerAddress: deployment.brokerAddress,
      brokerPort: deployment.brokerPort,
      brokerTls: deployment.brokerTls,
      brokerCa: deployment.brokerCa,
    };

    // Validate against the deployment mode BEFORE emitting anything — never ship
    // a config that can't work. In particular, managed mode rejects
    // cross-controller routes/imports (those need local-mode peer coordination,
    // which is not yet built); without this, such a site silently generated
    // firmware referencing the removed Home Assistant services. Refuse with the
    // diagnostics instead.
    const validation = validateAll(topo, manifest, board, { expansionBoards, mode: metadata.mode });
    if (!validation.ok) {
      throw new Error(
        `Cannot generate "${ctrl.friendlyName ?? ctrl.id}" in ${metadata.mode} mode:\n- ` +
          validation.errors.join('\n- '),
      );
    }

    const files = await generateEsphome(
      manifest,
      board,
      siteId,
      secrets ?? generateDefaultSecrets(),
      metadata,
      expansionBoards,
      // The raw draft topology — baked into the local-UI bundle as
      // /topology.json so the on-device dashboard boots from this exact site.
      topologyJson !== undefined || localUiAssetsHeader !== undefined
        ? { topologyJson, localUiAssetsHeader }
        : undefined,
    );
    // Re-align this controller's automations to the route table just baked
    // (route_index + route_set_version) so the device accepts the retained set once
    // this build is flashed. Here in the shared build funnel so BOTH the per-controller
    // Generate and the whole-site Commit re-stamp — they previously diverged (only
    // Commit did), so a Generate-and-flash stranded the rows on a stale version and the
    // device refused them. Best effort: a re-stamp failure must not fail the build.
    await this.restampAutomations(siteId, topo, ctrl.id).catch((e) => console.warn('automation re-stamp failed', e));
    return { files, hashPart, version: metadata.version };
  }

  /**
   * Resolve `{ model → version }` for the given board models (controller main
   * boards + expansion provider types). Non-board references (e.g. the built-in
   * `modbus_controller` provider) are skipped. Recorded into the committed
   * version for board-revision traceability.
   */
  private async boardVersions(models: Set<string>): Promise<Record<string, number>> {
    if (models.size === 0) return {};
    const all = await this.pb.collection('boards').getFullList({ requestKey: 'boards:versions' });
    const out: Record<string, number> = {};
    for (const r of all) {
      if (models.has(r['model'])) out[r['model']] = (r['version'] as number) ?? 0;
    }
    return out;
  }

  private async latestVersion(siteId: string): Promise<RecordModel | undefined> {
    const list = await this.pb.collection('topology_versions').getList(1, 1, {
      filter: this.pb.filter('site = {:s}', { s: siteId }),
      sort: '-version',
      requestKey: `versions:latest:${siteId}`,
    });
    return list.items[0];
  }

  /**
   * Zip a generated bundle into a Blob (text files only — stays tiny).
   *
   * `rebase` strips the shared `sites/{id}/esphome/` scaffolding so the archive
   * opens straight onto the device folder (`{device}/compile.sh`) instead of
   * burying it four levels deep — used for single-controller downloads. The
   * whole-site commit bundle keeps its full paths to disambiguate controllers.
   *
   * `compile.sh` (and any `.sh`) is stamped with Unix `0o755` so it extracts
   * already executable (`./compile.sh`), not just `bash compile.sh`.
   */
  private zipBundle(files: GeneratedFile[], rebase = false): Blob {
    const strip = rebase ? commonDirPrefix(files.map((f) => f.relativePath)) : '';
    const entries: Zippable = {};
    for (const f of files) {
      const path = f.relativePath.slice(strip.length);
      const data = strToU8(f.content);
      entries[path] = path.endsWith('.sh') ? [data, { os: 3, attrs: 0o755 << 16 }] : data;
    }
    const zipped = zipSync(entries, { level: 6 });
    // Copy into a fresh ArrayBuffer-backed view so the Blob owns its bytes.
    return new Blob([zipped.slice()], { type: 'application/zip' });
  }
}

/**
 * Longest shared directory prefix to strip so a zip opens onto the deepest
 * folder every file shares (kept as the archive root). For one controller's
 * files — all under `sites/{id}/esphome/{device}/…` — this returns
 * `sites/{id}/esphome/`, leaving `{device}/…` as the single top-level folder.
 * Returns `''` when nothing meaningful is shared (no flattening).
 */
function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  // Common prefix of each path's directory segments (filename dropped).
  let common = paths[0].split('/').slice(0, -1);
  for (const p of paths.slice(1)) {
    const segs = p.split('/').slice(0, -1);
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  // Drop the last shared segment so it survives as the archive's root folder.
  return common.length > 1 ? common.slice(0, -1).join('/') + '/' : '';
}
