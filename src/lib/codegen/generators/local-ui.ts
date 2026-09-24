import { gunzipSync, gzipSync } from 'fflate';
import type { Manifest } from '@core';
import { routeSetVersion, collectTunableNumbers } from '@core';
import { commandActionNames, commandDispatchLines } from './mqtt';

/**
 * Local UI — the operator dashboard served from the device itself (topology flag
 * local.ui). Replaces the stock ESPHome web_server v3 page: networking.ts emits a
 * bare web_server_base instead, and this package registers the maji_local_ui
 * component on it.
 *
 * Two artifacts:
 *   - local-ui.yaml      — the maji_local_ui config + the on_boot glue that installs
 *                          the asset table + the command/automations handlers (they
 *                          need id() access, so they are generated here, not baked
 *                          into the component).
 *   - local-ui-assets.h  — the device-mode app (npm run build:device →
 *                          dist/device/browser + device-ui-manifest.json) as a
 *                          flat table of gzipped PROGMEM assets (LOCAL_UI_ASSETS /
 *                          LOCAL_UI_ASSETS_COUNT, one maji_localui::LocalUiAsset per
 *                          file), plus a /topology.json entry carrying the site
 *                          topology. When the manifest is absent/unreadable —
 *                          tests, a fresh checkout, a failed fetch in the browser —
 *                          a placeholder page is embedded as the "/" entry instead,
 *                          so codegen never requires an Angular build.
 *
 * Serving contract (component side in firmware/components/maji_local_ui):
 *   exact path match → the file (Content-Encoding: gzip, the table's Content-Type);
 *   "/" is the index; "/index.html" and unmatched extension-less GETs fall back to
 *   it (SPA deep-links); immutable entries (content-hashed names) get a year-long
 *   Cache-Control, everything else no-cache; "/local" and unknown /local/* stay
 *   strict 404s.
 *
 * Endpoint contract (shared with the app side):
 *   GET  /local/state       — SSE stream of the ControllerSnapshot JSON: the exact
 *                             bytes publish_snapshot builds for the MQTT state topic
 *                             (the script calls id(local_ui).push_snapshot, so the SSE
 *                             cadence IS the snapshot cadence, broker down or not).
 *   POST /local/command     — the MQTT command envelope, dispatched by the SAME body
 *                             as the MQTT handler (commandDispatchLines in mqtt.ts):
 *                             same record_outcome, same publish_snapshot fast-path.
 *                             The synchronous gate checks envelope + action only;
 *                             the issued_at TTL is enforced by the dispatch body on
 *                             the main loop (a stale command is accepted here, then
 *                             recorded STALE via record_outcome — as on MQTT).
 *                             200 {"command_id":...} on accept; 400 {"error":...} on
 *                             bad JSON / unknown action. Outcomes flow back via the
 *                             snapshot, as on MQTT.
 *                             firmware_update is NOT exposed here (unauthenticated LAN).
 *                             config_set IS exposed here ONLY: { key, value } writes one
 *                             runtime tunable (clamped to its min/max, persisted via
 *                             restore_value); the MQTT lane rejects it — remote config
 *                             stays server-mediated via the retained /config.
 *   POST /local/automations — raw automation wire blob (application/octet-stream):
 *                             validated with the pure kernel on a scratch table, then
 *                             id(autos).apply_set on the main loop (which persists to
 *                             NVS). 200 on APPLY_OK/APPLY_CLEARED, 400 otherwise.
 */

/** Indent each non-empty C++ line to a column (YAML block-scalar body). */
const indent = (lines: string[], n: number) =>
  lines.map(l => (l === '' ? '' : ' '.repeat(n) + l)).join('\n');

/** YAML package — the maji_local_ui config + the on_boot handler-install glue. */
export function generateLocalUiYaml(m: Manifest): string {
  // Synchronous gate (httpd task, read-only): well-formed envelope + known
  // action — then the dispatch is marshalled to the main loop, where the shared
  // dispatch body re-parses and enforces the issued_at TTL (commandDispatchLines
  // in mqtt.ts). No TTL read here: id(sntp_time)/id(time_trusted) are main-loop
  // state and must not be touched cross-thread. The action allow-list comes
  // from the same emitter as the dispatch body, so the two can't drift.
  // allowConfigSet: the local lane accepts config_set (operator at the panel);
  // the MQTT lane rejects it (remote config stays server-mediated, migration 37).
  const tunables = collectTunableNumbers(m);
  const actionGate = commandActionNames({ allowOta: false, allowConfigSet: true })
    .map(a => `strcmp(action, "${a}") != 0`)
    .join(' && ');
  const commandGlue = [
    'id(local_ui).set_command_handler([](const std::string &body, std::string &reply) -> uint16_t {',
    '  std::string command_id;',
    '  const char *reject = nullptr;',
    '  bool ok = json::parse_json(body, [&](JsonObject x) -> bool {',
    '    command_id = x["command_id"] | "";',
    '    const char *action = x["action"] | "";',
    '    if (command_id.empty()) { reject = "MISSING_COMMAND_ID"; return false; }',
    `    if (${actionGate}) { reject = "UNKNOWN_ACTION"; return false; }`,
    '    return true;',
    '  });',
    '  if (!ok) {',
    '    reply = std::string("{\\"error\\":\\"") + (reject != nullptr ? reject : "BAD_JSON") + "\\"}";',
    '    return 400;',
    '  }',
    '  // Accepted: dispatch on the main loop (the route engine / claims / automation',
    '  // table are loop-thread only — see the no-lock note in maji_automations.h). The',
    '  // body is the SAME one the MQTT handler runs (commandDispatchLines in mqtt.ts,',
    '  // allowOta=false + the tunable allow-list for config_set) — including the',
    '  // issued_at TTL gate — re-parsed inside a void lambda so its early returns',
    '  // compile.',
    '  id(local_ui).defer_to_loop([body]() {',
    '    json::parse_json(body, [&](JsonObject x) -> bool {',
    '      [&]() {',
    ...commandDispatchLines({ allowOta: false, configSetTunables: tunables }).map(l => (l === '' ? '' : '        ' + l)),
    '      }();',
    '      return true;',
    '    });',
    '  });',
    '  // Escape into a stack buffer (json_esc_to) — json_esc\'s shared static buffer is',
    '  // main-loop-only; this handler runs on the httpd task while the snapshot builder',
    '  // escapes through the same buffer on the main loop.',
    '  char cid_esc[96];',
    '  maji_ctl::json_esc_to(cid_esc, sizeof(cid_esc), command_id.c_str());',
    '  reply = std::string("{\\"command_id\\":\\"") + cid_esc + "\\"}";',
    '  return 200;',
    '});',
  ];
  const automationsGlue = [
    'id(local_ui).set_automations_handler([](const uint8_t *data, size_t len) -> uint16_t {',
    '  // Validate with the PURE kernel on a scratch table (no shared state — the httpd',
    '  // task services requests sequentially, so the static scratch is safe), then apply',
    '  // on the main loop: tick() reads the live table there, and apply_set persists to',
    '  // NVS. A refused blob keeps the last-good set, exactly as on the MQTT lane.',
    '  static maji_auto::RuntimeAutomation scratch[maji_auto::MAX_AUTOMATIONS];',
    '  static char scratch_ids[maji_auto::MAX_AUTOMATIONS][maji_auto::AUTOMATION_ID_BYTES];',
    '  uint8_t count = 0;',
    `  auto r = maji_auto::apply_set(data, len, ${routeSetVersion(m)}, scratch, scratch_ids, count);`,
    '  if (r != maji_auto::APPLY_OK && r != maji_auto::APPLY_CLEARED) return 400;',
    '  std::string blob((const char *) data, len);',
    '  id(local_ui).defer_to_loop([blob]() { id(autos).apply_set((const uint8_t *) blob.data(), blob.size()); });',
    '  return 200;',
    '});',
  ];
  const bootBody = [
    'id(local_ui).set_assets(LOCAL_UI_ASSETS, LOCAL_UI_ASSETS_COUNT);',
    ...commandGlue,
    ...automationsGlue,
  ];

  return `# =============================================================================
# MajiFlow — Local UI (operator dashboard served from the device)
# =============================================================================
# AUTO-GENERATED. Emitted when the topology's local.ui flag is on; replaces the
# stock ESPHome web_server v3 page (networking.ts emits a bare web_server_base
# instead — captive_portal is unaffected, it depends only on web_server_base).
#
# Endpoints (shared web_server_base, port 80):
#   GET  /                   — the device-mode app index (local-ui-assets.h: a flat
#                              table of gzipped PROGMEM files). Exact asset paths
#                              serve their file; extension-less navigation GETs
#                              outside /local/ fall back to this index (SPA routes).
#                              Hashed assets are served cache-immutable, the index
#                              no-cache. "/local" itself and unknown /local/* stay
#                              strict 404s.
#   GET  /local/state        — SSE stream of the ControllerSnapshot JSON: the same
#                              bytes publish_snapshot builds for the MQTT state topic
#                              (the script calls id(local_ui).push_snapshot, so the
#                              SSE cadence IS the snapshot cadence — even when the
#                              broker is down, which is the point of the local UI)
#   POST /local/command      — the MQTT command envelope, dispatched by the SAME body
#                              as the MQTT handler (installed below): same
#                              record_outcome, same publish_snapshot fast-path. The
#                              synchronous gate checks envelope + action only; the
#                              issued_at TTL is enforced by the dispatch body on the
#                              main loop (stale → recorded STALE via record_outcome).
#                              200 {"command_id":...} on accept, 400 {"error":...}
#                              otherwise; outcomes ride the snapshot.
#                              firmware_update is NOT exposed here — this endpoint is
#                              unauthenticated LAN HTTP, the MQTT lane is cert-pinned.
#                              config_set IS exposed here ONLY: { key, value } writes
#                              one runtime tunable (allow-listed, clamped to min/max,
#                              persisted via restore_value); the MQTT lane rejects it —
#                              remote config stays server-mediated via /config.
#   POST /local/automations  — raw automation wire blob (application/octet-stream):
#                              validated with the pure kernel, then applied via
#                              id(autos).apply_set on the main loop (persists to NVS).
#                              200 on APPLY_OK/APPLY_CLEARED, 400 otherwise.
#
# Both POSTs parse + gate synchronously on the httpd task (read-only) and marshal
# the mutation to the main loop via defer_to_loop() (Component::defer is protected)
# — the route engine, claims registry, and automation table are loop-thread only.
# =============================================================================

maji_local_ui:
  id: local_ui
  control_id: control
  autos_id: autos

esphome:
  on_boot:
    # Install the asset table + both POST handlers before the network comes up
    # (any on_boot priority beats the first HTTP request).
    - priority: 800
      then:
        - lambda: |-
${indent(bootBody, 12)}
`;
}

/** Minimal HTML-escape for the baked device name (it lands inside the page). */
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- Device-app manifest reading ---------------------------------------------
// The device-mode Angular build (npm run build:device → dist/device/browser) is
// packaged by scripts/build-device.mjs: every servable file is gzipped (level 9)
// and described by device-ui-manifest.json (path / file / contentType /
// immutable). Codegen TRUSTS the manifest — skip lists, content types, and the
// immutable heuristic are applied at build time; here we only read the bytes.
// Two read paths, same header output:
//   - Node (emit-bundle, tests): the manifest + its .gz files are read from disk
//     (default dist/device/browser anchored at the repo root, DEVICE_UI_DIST
//     override). process.getBuiltinModule keeps node:fs out of the static import
//     graph so the browser bundle never sees it.
//   - Browser (in-app firmware download): no node:fs → the same manifest is
//     fetched from /device-ui/, where the server hosts the dist; each asset's
//     file is fetched relative to the manifest URL.

/** Manifest emitted by scripts/build-device.mjs next to the gzipped app dist. */
export interface DeviceUiManifest {
  version: number;
  assets: Array<{
    path: string; // URL path in the table; the root index is "/"
    file: string; // sibling of the manifest, already gzipped (level 9)
    contentType: string;
    immutable: boolean; // content-hashed name → year-long cache header
  }>;
}

/** One asset queued for embedding — `gz` bytes are ALREADY gzipped. */
interface EmbeddedAsset {
  servePath: string;
  gz: Uint8Array;
  contentType: string;
  immutable: boolean;
  raw?: number; // uncompressed size, when known (placeholder/topology — we gzip those ourselves)
}

const DEVICE_UI_DIST_ENV = 'DEVICE_UI_DIST';
const DEVICE_UI_MANIFEST = 'device-ui-manifest.json';
/**
 * The device build's browser output (angular.json outputPath dist/device → the
 * application builder's browser/ subdir, where build-device.mjs also writes the
 * manifest), anchored at the repo root — the default must not resolve against
 * the process CWD or codegen run from another directory would silently embed
 * the placeholder. This file is src/lib/codegen/generators/local-ui.ts, so the
 * root is four levels up.
 */
const DEFAULT_DEVICE_UI_DIST = new URL('../../../../dist/device/browser', import.meta.url).pathname;
/** Where the server hosts the device dist for the in-browser codegen path. */
const DEVICE_UI_BASE_URL = '/device-ui/';
/** Warn when the embedded payload passes this gzip total (ESP32 flash budget). */
const GZ_WARN_BYTES = 700 * 1024;

/**
 * Stable versioning material for a generated asset header. Everything before
 * the first blob is comments/includes and contains the environment-specific
 * source path (`/device-ui/...` in-browser, an absolute dist path under Node).
 * The blob arrays + lookup table are the bytes and metadata that actually land
 * in firmware, so only that section should participate in its version hash.
 */
export function localUiFirmwareMaterial(header: string): string {
  const marker = 'static const uint8_t LOCAL_UI_ASSET_0[]';
  const start = header.indexOf(marker);
  return start >= 0 ? header.slice(start) : header;
}

/** Parse + shape-check the manifest — trusted, but a malformed one must not poison the flash image. */
function parseManifest(raw: string): DeviceUiManifest | null {
  try {
    const m = JSON.parse(raw) as DeviceUiManifest;
    if (m?.version !== 1 || !Array.isArray(m.assets)) return null;
    return m;
  } catch {
    return null;
  }
}

// Structural minimums of node:fs/node:path — the app tsconfig has no node types,
// and a static node: import would leak into the browser bundle.
interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
interface PathLike {
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
}

interface NodeModules {
  fs: FsLike;
  path: PathLike;
  env: Record<string, string | undefined>;
}

/** node:fs/node:path/env under Node, null in the browser bundle. */
function nodeModules(): NodeModules | null {
  const proc = (globalThis as {
    process?: { env?: Record<string, string | undefined>; getBuiltinModule?: (m: string) => unknown };
  }).process;
  const fs = proc?.getBuiltinModule?.('node:fs') as FsLike | undefined;
  const path = proc?.getBuiltinModule?.('node:path') as PathLike | undefined;
  if (!fs || !path || !proc?.env) return null;
  return { fs, path, env: proc.env };
}

const manifestAssets = (m: DeviceUiManifest, read: (file: string) => Uint8Array): EmbeddedAsset[] =>
  m.assets.map(a => ({ servePath: a.path, gz: read(a.file), contentType: a.contentType, immutable: a.immutable }));

/** Node path: read the manifest + its .gz files from the dist dir, or null when absent/broken. */
function readFromDisk(node: NodeModules): { source: string; assets: EmbeddedAsset[] } | null {
  const { fs, path, env } = node;
  // The env override is an explicit pointer, so CWD resolution is fine for it;
  // the default is anchored at the repo root (see DEFAULT_DEVICE_UI_DIST).
  const override = env[DEVICE_UI_DIST_ENV];
  const dir = override ? path.resolve(override) : DEFAULT_DEVICE_UI_DIST;
  const manifestPath = path.join(dir, DEVICE_UI_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = parseManifest(new TextDecoder().decode(fs.readFileSync(manifestPath)));
  if (!manifest) {
    console.warn(
      `local.ui: ${manifestPath} is missing/unparseable — not a device build, embedding placeholder` +
        ' (run npm run build:device -- <config>)',
    );
    return null;
  }
  try {
    return { source: dir, assets: manifestAssets(manifest, f => new Uint8Array(fs.readFileSync(path.join(dir, f)))) };
  } catch (err) {
    // A file listed in the manifest but missing/unreadable — a broken dist must
    // not break the whole bundle generation.
    console.warn(
      `local.ui: failed to read ${dir} (${err instanceof Error ? err.message : String(err)}), embedding placeholder` +
        ' (run npm run build:device -- <config>)',
    );
    return null;
  }
}

/**
 * Browser path: fetch the manifest, then each asset file relative to the
 * manifest URL. Exported (and fetch-injectable) so tests can drive it without a
 * server. Returns null on any failure — the caller embeds the placeholder.
 */
export async function fetchDeviceUiAssets(
  fetchImpl: typeof fetch,
  baseUrl = DEVICE_UI_BASE_URL,
): Promise<{ source: string; assets: EmbeddedAsset[] } | null> {
  const manifestUrl = baseUrl + DEVICE_UI_MANIFEST;
  // cache: 'no-cache' on every fetch — a stale cached .gz from a previous deploy
  // mixes two app builds into one bundle (caught by the index-consistency guard,
  // but better to never fetch the stale bytes in the first place).
  const fresh: RequestInit = { cache: 'no-cache' };
  try {
    const res = await fetchImpl(manifestUrl, fresh);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = parseManifest(await res.text());
    if (!manifest) throw new Error('unparseable manifest');
    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    const assets: EmbeddedAsset[] = [];
    for (const a of manifest.assets) {
      const r = await fetchImpl(base + a.file, fresh);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${a.file}`);
      assets.push({
        servePath: a.path,
        gz: new Uint8Array(await r.arrayBuffer()),
        contentType: a.contentType,
        immutable: a.immutable,
      });
    }
    return { source: manifestUrl, assets };
  } catch (err) {
    console.warn(
      `local.ui: failed to fetch the device app from ${manifestUrl} (${err instanceof Error ? err.message : String(err)}),` +
        ' embedding placeholder — the server must host the build:device dist at /device-ui/',
    );
    return null;
  }
}

/** Manifest-driven assets, from disk under Node or over HTTP in the browser. */
async function readDeviceUiAssets(): Promise<{ source: string; assets: EmbeddedAsset[] } | null> {
  const node = nodeModules();
  if (node) return readFromDisk(node);
  const fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof fetchImpl !== 'function') return null;
  return fetchDeviceUiAssets(fetchImpl);
}

/** Placeholder page — embedded as the "/" entry when the manifest is absent. */
function placeholderIndex(m: Manifest): Uint8Array {
  const name = escapeHtml(m.device.friendly_name);
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${name}</title>`,
    '<style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:40rem}code{background:#eee;padding:0 .25rem}</style>',
    '</head><body>',
    `<h1>${name}</h1>`,
    '<p>The MajiFlow local operator UI will live here.</p>',
    '<p>Endpoints: <code>GET /local/state</code> (SSE snapshot stream),',
    '<code>POST /local/command</code>, <code>POST /local/automations</code>.</p>',
    '</body></html>',
  ].join('');
  return new TextEncoder().encode(html);
}

const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;

/**
 * C++ header — the app as a flat table of gzipped PROGMEM assets. Every manifest
 * asset becomes a static byte array (bytes straight from the .gz files — no
 * re-gzip); LOCAL_UI_ASSETS maps serve paths to them (the index is the "/"
 * entry). The site's raw topology JSON is gzipped here and appended as
 * /topology.json (the dashboard boots from it even with the broker down).
 * Missing manifest/failed fetch → the placeholder page as the "/" entry (plus
 * /topology.json when the topology is available), so codegen never requires an
 * Angular build.
 */
/**
 * Consistency guard: every script/style the index references must be in the
 * asset set. A bundle whose index points at assets that were never embedded
 * boots to a blank page on the device (the browser can't fetch the main
 * bundle) — that is what a mixed-build dist does (stale cache, mid-deploy).
 * Hard-fail here instead of shipping a dead UI. Only covers eager refs
 * (main/styles/preloaded chunks); lazy chunks are runtime-fetched by main.
 */
function assertIndexReferencesResolve(assets: EmbeddedAsset[]): void {
  const index = assets.find(a => a.servePath === '/');
  if (!index) return;
  const html = new TextDecoder().decode(gunzipSync(index.gz));
  const refs = new Set(html.match(/(?:main|styles|chunk)-[A-Z0-9]+\.(?:js|css)/g) ?? []);
  const have = new Set(assets.map(a => a.servePath.slice(1)));
  const missing = [...refs].filter(r => !have.has(r));
  if (missing.length > 0)
    throw new Error(
      `local.ui: index.html references ${missing.join(', ')} — not in the device-ui manifest ` +
        '(mixed app builds; rebuild with npm run build:device or hard-refresh and retry)',
    );
}

export async function generateLocalUiAssetsHeader(m: Manifest, topologyJson?: string): Promise<string> {
  const dist = await readDeviceUiAssets();
  let assets: EmbeddedAsset[];
  let source: string;
  if (dist) {
    assets = dist.assets;
    source = dist.source;
    if (!assets.some(a => a.servePath === '/'))
      console.warn(`local.ui: ${dist.source} has no "/" asset — GET / will 404 (run npm run build:device -- <config>)`);
    else
      assertIndexReferencesResolve(assets);
  } else {
    console.warn(
      'local.ui: device app manifest not found, embedding placeholder — run npm run build:device -- <config> first',
    );
    const raw = placeholderIndex(m);
    assets = [{ servePath: '/', gz: gzipSync(raw, { level: 9 }), contentType: 'text/html', immutable: false, raw: raw.length }];
    source = 'placeholder page (no device-ui manifest)';
  }

  // Topology injection — gzipped here (the manifest assets arrive pre-gzipped;
  // this one originates in codegen, so codegen compresses it).
  if (topologyJson !== undefined) {
    const raw = new TextEncoder().encode(topologyJson);
    assets = [
      ...assets,
      {
        servePath: '/topology.json',
        gz: gzipSync(raw, { level: 9 }),
        contentType: 'application/json',
        immutable: false,
        raw: raw.length,
      },
    ];
    source += ' + site topology';
  }

  const arrays: string[] = [];
  const entries: string[] = [];
  let totalRaw = 0;
  let rawKnown = true;
  let totalGz = 0;
  assets.forEach((a, i) => {
    totalGz += a.gz.length;
    if (a.raw === undefined) rawKnown = false;
    else totalRaw += a.raw;
    const sizeNote = a.raw === undefined ? `${a.gz.length} B gz` : `${a.raw} B raw → ${a.gz.length} B gz`;
    const bytes: string[] = [];
    for (let o = 0; o < a.gz.length; o += 12) {
      bytes.push(
        '  ' + Array.from(a.gz.subarray(o, o + 12), b => '0x' + b.toString(16).padStart(2, '0')).join(', ') + ',',
      );
    }
    arrays.push(`// ${a.servePath} (${sizeNote})\nstatic const uint8_t LOCAL_UI_ASSET_${i}[] PROGMEM = {\n${bytes.join('\n')}\n};`);
    entries.push(
      `  {"${a.servePath}", LOCAL_UI_ASSET_${i}, sizeof(LOCAL_UI_ASSET_${i}), "${a.contentType}", ${a.immutable}},`,
    );
  });

  const sizeSummary = rawKnown ? `${kb(totalRaw)} raw → ${kb(totalGz)} gz` : `${kb(totalGz)} gz`;
  console.log(`local.ui: embedded ${assets.length} asset(s), ${sizeSummary} (${source})`);
  if (totalGz > GZ_WARN_BYTES)
    console.warn(`local.ui: embedded assets total ${kb(totalGz)} gz — above the 700KB flash budget warning line`);

  return `// =============================================================================
// MajiFlow — Local UI assets (local-ui-assets.h)
// =============================================================================
// AUTO-GENERATED. The device-mode operator app as a flat table of gzipped PROGMEM
// assets, served by the maji_local_ui component (routing rules in its core.h):
// exact path match → the file (Content-Encoding: gzip + the table Content-Type);
// "/" is the index, and "/index.html" / extension-less navigation GETs outside
// /local fall back to it (SPA deep-links); immutable entries (content-hashed
// names) are served with Cache-Control: max-age=31536000, immutable, everything
// else no-cache. /topology.json carries the site topology this bundle was
// generated from.
// Wired via id(local_ui).set_assets in local-ui.yaml.
// Source: ${source}
// Embedded: ${assets.length} file(s), ${rawKnown ? `${totalRaw} B raw → ${totalGz} B gz` : `${totalGz} B gz`}
// =============================================================================

#include "esphome/core/hal.h"  // PROGMEM (no-op on esp-idf — the blobs stay in flash rodata)
#include "esphome/components/maji_local_ui/core.h"  // maji_localui::LocalUiAsset

${arrays.join('\n\n')}

static const maji_localui::LocalUiAsset LOCAL_UI_ASSETS[] = {
${entries.join('\n')}
};
static const size_t LOCAL_UI_ASSETS_COUNT = sizeof(LOCAL_UI_ASSETS) / sizeof(LOCAL_UI_ASSETS[0]);
`;
}
