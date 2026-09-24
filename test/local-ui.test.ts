/**
 * Local UI (maji_local_ui) — pins the gated emission on the topology flag
 * local.ui: the package + assets-header files, the device-YAML wiring (package
 * include + esphome includes), the web_server ↔ web_server_base swap (with
 * captive_portal retained in both modes), the snapshot push hook in mqtt.yaml,
 * the shared command dispatch (MQTT-identical body, minus firmware_update), and
 * the asset-table header: placeholder fallback when the device-ui manifest is
 * absent/broken, manifest-driven embedding (content types, immutable flags,
 * bytes straight from the .gz files — no re-gzip), /topology.json injection,
 * and the browser fetch path via a stub fetch.
 *
 * Usage: npx tsx test/local-ui.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { gunzipSync, gzipSync } from "fflate";
import { parseTopology, topologyToManifestForController, type Manifest } from "@core";
import { generateAll, createTestMetadata, generateBoardPackage, generateLocalUiAssetsHeader, localUiFirmwareMaterial, fetchDeviceUiAssets, type GeneratedFile } from "@core/codegen";
import { makeAsserter, loadBoard } from "./helpers";

const { assert, done } = makeAsserter();

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const KC868_DIR = path.join(ROOT, "defaults", "boards", "kc868-a16");
const KC868_CONFIG = path.join(ROOT, "defaults", "configs", "kc868-a16-controller.yaml");

// Never let the tests slurp a real dist/device: default to a missing dir so
// the placeholder path is exercised unless a test points at its fixture.
const MISSING_DIST = path.join(os.tmpdir(), "local-ui-no-such-dist");
process.env.DEVICE_UI_DIST = MISSING_DIST;

const kc868 = loadBoard(KC868_DIR);

function manifestWithUi(ui: boolean): Manifest {
  const raw = parseYaml(fs.readFileSync(KC868_CONFIG, "utf-8")) as Record<string, unknown>;
  (raw.controllers as Array<Record<string, unknown>>)[0].local = ui ? { ui: true } : undefined;
  const topo = parseTopology(raw);
  return topologyToManifestForController(topo, topo.controllers[0].id);
}

const get = (files: GeneratedFile[], suffix: string) => files.find(f => f.relativePath.endsWith(suffix));
const deviceYaml = (files: GeneratedFile[]) =>
  files.find(f => f.relativePath.endsWith(".yaml") && !f.relativePath.includes("packages/") && !f.relativePath.includes("common/"))!;

/** Extract the bytes of one named asset array out of the generated header. */
function arrayBytes(hdr: string, name: string): number[] {
  // Anchor on the closing "\n};" — a gzip byte 0x7d ('}') inside the blob would
  // truncate a naive [^}]* match.
  const body = hdr.match(new RegExp(name + "\\[\\] PROGMEM = \\{([\\s\\S]*?)\\n\\};"))?.[1] ?? "";
  return (body.match(/0x[0-9a-f]{2}/g) ?? []).map(h => parseInt(h, 16));
}

/** Gunzip one named asset array out of the generated header. */
function gunzipArray(hdr: string, name: string): string {
  return new TextDecoder().decode(gunzipSync(new Uint8Array(arrayBytes(hdr, name))));
}

/** The LOCAL_UI_ASSETS table entry for a serve path: {name, contentType, immutable}. */
function tableEntry(hdr: string, servePath: string) {
  const m = hdr.match(
    new RegExp(
      `\\{"${servePath.replace(/[/.]/g, "\\$&")}", (LOCAL_UI_ASSET_\\d+), sizeof\\(\\1\\), "([^"]+)", (true|false)\\}`,
    ),
  );
  return m ? { name: m[1], contentType: m[2], immutable: m[3] === "true" } : null;
}

// async main: generateAll is async (manifest-driven local-UI assets).
const main = async () => {
const offManifest = manifestWithUi(false);
const onManifest = manifestWithUi(true);
assert(onManifest.device.local?.ui === true, "local.ui threads topology → manifest");
assert(!offManifest.device.local?.ui, "default topology has no local.ui");

const offFiles = await generateAll(offManifest, kc868, "test-site", undefined, createTestMetadata(), {});
const onFiles = await generateAll(onManifest, kc868, "test-site", undefined, createTestMetadata(), {});

const offDevice = deviceYaml(offFiles).content;
const onDevice = deviceYaml(onFiles).content;
const offBoard = get(offFiles, "common/board.yaml")!.content;
const onBoard = get(onFiles, "common/board.yaml")!.content;
const offMqtt = get(offFiles, "packages/mqtt.yaml")!.content;
const onMqtt = get(onFiles, "packages/mqtt.yaml")!.content;

// --- Gated OFF: behavior unchanged ------------------------------------------------

assert(!get(offFiles, "packages/local-ui.yaml"), "off: no local-ui.yaml in the bundle");
assert(!get(offFiles, "packages/local-ui-assets.h"), "off: no local-ui-assets.h in the bundle");
assert(!offDevice.includes("local-ui"), "off: device YAML references no local-ui package/header");
assert(offBoard.includes("web_server:"), "off: stock web_server dashboard emitted");
assert(offBoard.includes("port: 80"), "off: web_server stays on port 80");
assert(!offBoard.includes("web_server_base:"), "off: no bare web_server_base");
assert(offMqtt.includes("if (!mc->is_connected()) return;"), "off: snapshot still gated on broker connection");
assert(!offMqtt.includes("push_snapshot"), "off: no SSE fan-out in the snapshot script");

// --- Gated ON: package + header files, device-YAML wiring -------------------------

const onPkg = get(onFiles, "packages/local-ui.yaml");
const onHdr = get(onFiles, "packages/local-ui-assets.h");
assert(!!onPkg, "on: bundle carries packages/local-ui.yaml");
assert(!!onHdr, "on: bundle carries packages/local-ui-assets.h");
assert(onDevice.includes("local_ui: !include packages/local-ui.yaml"), "on: device YAML includes the package");
assert(onDevice.includes("- packages/local-ui-assets.h"), "on: esphome includes carries the assets header");
assert(onDevice.includes("- packages/time-sync.h"), "on: time-sync include retained");

// --- web_server ↔ web_server_base swap, captive_portal retained -------------------

assert(!onBoard.includes("web_server:"), "on: stock web_server dashboard NOT emitted");
assert(onBoard.includes("web_server_base:"), "on: bare web_server_base emitted instead");
// kc868 defaults to ethernet (no captive_portal either way) — check the wifi
// transport, where the AP setup page must survive the swap in BOTH modes.
const wifiOff = generateBoardPackage(kc868, { mode: "dhcp", transport: "wifi" }, false);
const wifiOn = generateBoardPackage(kc868, { mode: "dhcp", transport: "wifi" }, true);
assert(wifiOff.includes("captive_portal"), "off (wifi): captive_portal retained");
assert(wifiOff.includes("web_server:"), "off (wifi): web_server emitted");
assert(wifiOn.includes("captive_portal"), "on (wifi): captive_portal retained (depends only on web_server_base)");
assert(wifiOn.includes("web_server_base:") && !wifiOn.includes("web_server:"), "on (wifi): swap applies on wifi too");
assert(wifiOn.includes("improv_serial"), "on (wifi): improv_serial untouched");

// --- Snapshot fan-out in mqtt.yaml -------------------------------------------------

assert(onMqtt.includes("id(local_ui).push_snapshot(buf);"), "on: snapshot script feeds the SSE stream");
assert(onMqtt.includes('if (mc->is_connected()) mc->publish("majiflow/test-site/'), "on: MQTT publish stays connection-gated");
assert(!onMqtt.includes("if (!mc->is_connected()) return;"), "on: snapshot builds even with the broker down (the no-server path)");

// --- Endpoint glue in local-ui.yaml ------------------------------------------------

const pkg = onPkg!.content;
assert(pkg.includes("maji_local_ui:"), "pkg: maji_local_ui config emitted");
assert(pkg.includes("id: local_ui"), "pkg: component id matches the mqtt push_snapshot reference");
assert(pkg.includes("control_id: control") && pkg.includes("autos_id: autos"), "pkg: control/autos wired");
assert(pkg.includes("set_assets(LOCAL_UI_ASSETS, LOCAL_UI_ASSETS_COUNT)"), "pkg: asset table wired from the header");
assert(pkg.includes("set_command_handler("), "pkg: command handler installed");
assert(pkg.includes("set_automations_handler("), "pkg: automations handler installed");
assert(pkg.includes("id(autos).apply_set("), "pkg: automations blob applied via apply_set (persists to NVS)");
assert(!pkg.includes('reject = "STALE"'), "pkg: no TTL read on the httpd task (cross-thread read removed)");
assert(pkg.includes('record_outcome(command_id, "REFUSED", "STALE")'), "pkg: issued_at TTL enforced in the main-loop dispatch body");
assert(pkg.includes('reject = "UNKNOWN_ACTION"'), "pkg: unknown actions refused before dispatch");
assert(pkg.includes("id(local_ui).defer_to_loop("), "pkg: dispatch marshalled to the main loop (defer_to_loop — Component::defer is protected)");

// --- Shared dispatch parity with the MQTT lane -------------------------------------

// One emitter feeds both lanes: a distinctive line of the dispatch body must appear
// verbatim in both the MQTT handler and the local-UI deferred lambda.
const dispatchLine = "int rc = id(control).start_route(route_id, command_id, spec, maji_ctl::ORIGIN_MANUAL, actor);";
assert(onMqtt.includes(dispatchLine), "parity: MQTT handler carries the dispatch body");
assert(pkg.includes(dispatchLine), "parity: local-UI glue carries the SAME dispatch body");
assert(onMqtt.includes('"firmware_update"'), "parity: MQTT lane keeps firmware_update (cert-pinned)");
assert(!pkg.includes('"firmware_update"'), "parity: local lane drops firmware_update (unauthenticated LAN)");
// config_set is the mirror image: local-lane-only. The local gate + dispatch carry
// it (allow-listed, min/max-clamped, make_call/set_value applied); the MQTT lane
// has no branch for it — one arriving there falls to the unknown-action gate.
assert(pkg.includes('strcmp(action, "config_set")'), "parity: local lane accepts config_set (on-device tunable write)");
assert(!onMqtt.includes('strcmp(action, "config_set")'), "parity: MQTT lane rejects config_set (remote config stays server-mediated)");
assert(pkg.includes('id(flow_watchdog_s).make_call().set_value('), "parity: config_set applies via the make_call/set_value idiom");
assert(pkg.includes('"REFUSED", applied ? "" : "UNKNOWN_KEY"') || pkg.includes('applied ? "APPLIED" : "REFUSED"'), "parity: config_set records per-key outcome");
assert(!pkg.includes("route_set_version"), "pkg: automation route_set_version is baked as a number, not a config key");

// --- Assets header: placeholder table when the manifest is absent -------------

const hdr = onHdr!.content;
assert(hdr.includes('#include "esphome/components/maji_local_ui/core.h"'), "hdr: asset struct pulled from the component core");
assert(hdr.includes("static const uint8_t LOCAL_UI_ASSET_0[] PROGMEM"), "hdr: PROGMEM gzip blob emitted");
assert(hdr.includes("static const maji_localui::LocalUiAsset LOCAL_UI_ASSETS[]"), "hdr: asset table emitted");
assert(hdr.includes("static const size_t LOCAL_UI_ASSETS_COUNT"), "hdr: table count emitted");
assert(hdr.includes("0x1f, 0x8b"), "hdr: blob starts with the gzip magic");
const idxEntry = tableEntry(hdr, "/");
assert(!!idxEntry && idxEntry.contentType === "text/html" && !idxEntry.immutable,
  "hdr: placeholder is the single \"/\" entry (text/html, not immutable)");
assert((hdr.match(/\{\"\//g) ?? []).length === 1, "hdr: placeholder table has exactly one entry");
assert(!tableEntry(hdr, "/topology.json"), "hdr: no /topology.json without a topology");
const page = gunzipArray(hdr, idxEntry!.name);
assert(page.includes(onManifest.device.friendly_name), "hdr: placeholder page names the device");
assert(page.includes("local operator UI will live here"), "hdr: placeholder page text");
assert(await generateLocalUiAssetsHeader(onManifest) === hdr, "hdr: generator is deterministic for the same manifest");

// Placeholder + topology → /topology.json rides along (the dashboard boots from it).
const TOPO_JSON = JSON.stringify({ site: "Test Site", controllers: [{ id: "ctrl-1", board: "kc868-a16" }] });
const warnsPh: string[] = [];
const origWarnPh = console.warn;
console.warn = (...args: unknown[]) => warnsPh.push(args.map(String).join(" "));
const hdrTopo = await generateLocalUiAssetsHeader(onManifest, TOPO_JSON);
console.warn = origWarnPh;
const topoEntryPh = tableEntry(hdrTopo, "/topology.json");
assert(!!topoEntryPh && topoEntryPh.contentType === "application/json" && !topoEntryPh.immutable,
  "placeholder: /topology.json embedded (application/json, not immutable)");
assert(gunzipArray(hdrTopo, topoEntryPh?.name ?? "LOCAL_UI_ASSET_X") === TOPO_JSON,
  "placeholder: /topology.json gunzips to the exact topology JSON");
assert(!!tableEntry(hdrTopo, "/"), "placeholder: index retained alongside /topology.json");
assert(warnsPh.some(w => w.includes("embedding placeholder") && w.includes("npm run build:device -- <config>")),
  "placeholder: missing manifest warns and names the fix");

// --- Assets header: real manifest via DEVICE_UI_DIST --------------------------

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "local-ui-dist-"));
const gz = (s: string) => gzipSync(new TextEncoder().encode(s), { level: 9 });
const INDEX_HTML = "<!doctype html><title>fixture app</title>";
const MAIN_JS = "console.log('fixture bundle');";
const STYLES_CSS = "body{color:#000}";
fs.writeFileSync(path.join(fixture, "index.html.gz"), gz(INDEX_HTML));
fs.writeFileSync(path.join(fixture, "main-ABC123XY.js.gz"), gz(MAIN_JS));
fs.writeFileSync(path.join(fixture, "styles.css.gz"), gz(STYLES_CSS));
// The producer's manifest (scripts/build-device.mjs) — codegen trusts it: no
// re-walking, no re-gzipping, no skip logic.
fs.writeFileSync(
  path.join(fixture, "device-ui-manifest.json"),
  JSON.stringify({
    version: 1,
    assets: [
      { path: "/", file: "index.html.gz", contentType: "text/html", immutable: false },
      { path: "/main-ABC123XY.js", file: "main-ABC123XY.js.gz", contentType: "text/javascript", immutable: true },
      { path: "/styles.css", file: "styles.css.gz", contentType: "text/css", immutable: false },
    ],
  }),
);
process.env.DEVICE_UI_DIST = fixture;

const logs: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
const real = await generateLocalUiAssetsHeader(onManifest, TOPO_JSON);
console.log = origLog;
process.env.DEVICE_UI_DIST = MISSING_DIST;

assert(logs.some(l => l.includes("embedded 4 asset(s)") && l.includes(fixture)),
  "fixture: embed summary logs the count + the dist source");

const jsEntry = tableEntry(real, "/main-ABC123XY.js");
assert(!!jsEntry, "fixture: hashed js embedded");
assert(jsEntry?.contentType === "text/javascript", "fixture: js content-type");
assert(jsEntry?.immutable === true, "fixture: hashed js is immutable");
assert(gunzipArray(real, jsEntry?.name ?? "LOCAL_UI_ASSET_X") === MAIN_JS,
  "fixture: js array gunzips to the real bytes");
// Bytes come STRAIGHT from the .gz files — a re-gzip would differ byte-for-byte.
const fixtureGz = Array.from(fs.readFileSync(path.join(fixture, "main-ABC123XY.js.gz")));
assert(JSON.stringify(arrayBytes(real, jsEntry?.name ?? "LOCAL_UI_ASSET_X")) === JSON.stringify(fixtureGz),
  "fixture: embedded bytes are the exact .gz file bytes (no re-gzip)");
assert((real.match(/0x1f, 0x8b/g) ?? []).length >= 4, "fixture: every array starts with the gzip magic");

const realIdx = tableEntry(real, "/");
assert(realIdx?.contentType === "text/html" && realIdx.immutable === false, "fixture: index is text/html, not immutable");
assert(gunzipArray(real, realIdx?.name ?? "LOCAL_UI_ASSET_X") === INDEX_HTML, "fixture: index gunzips");

const cssEntry = tableEntry(real, "/styles.css");
assert(cssEntry?.contentType === "text/css" && cssEntry.immutable === false, "fixture: unhashed css is not immutable");
assert(gunzipArray(real, cssEntry?.name ?? "LOCAL_UI_ASSET_X") === STYLES_CSS, "fixture: css gunzips");

const topoEntry = tableEntry(real, "/topology.json");
assert(!!topoEntry && topoEntry.contentType === "application/json" && !topoEntry.immutable,
  "fixture: /topology.json injected alongside the manifest assets");
assert(gunzipArray(real, topoEntry?.name ?? "LOCAL_UI_ASSET_X") === TOPO_JSON,
  "fixture: /topology.json gunzips to the exact topology JSON");
assert(/Embedded: 4 file\(s\)/.test(real), "fixture: header comment reports the embedded file count");
process.env.DEVICE_UI_DIST = fixture;
assert(await generateLocalUiAssetsHeader(onManifest, TOPO_JSON) === real, "fixture: generator is deterministic");
process.env.DEVICE_UI_DIST = MISSING_DIST;

// Firmware versioning consumes the actual blob/table, not the environment-specific
// Source comment. A changed embedded byte must change that material; a different
// source path must not.
const differentSource = real.replace(/^\/\/ Source:.*$/m, "// Source: /some/other/build/path");
assert(localUiFirmwareMaterial(differentSource) === localUiFirmwareMaterial(real),
  "version material: ignores the environment-specific asset source path");
const changedAsset = real.replace("0x1f, 0x8b", "0x1e, 0x8b");
assert(localUiFirmwareMaterial(changedAsset) !== localUiFirmwareMaterial(real),
  "version material: changes when an embedded asset byte changes");

// The prebuilt table is passed through verbatim. BuildService relies on this to
// hash and emit one snapshot even if a deployment changes while codegen runs.
const preloadedFiles = await generateAll(
  onManifest,
  kc868,
  "test-site",
  undefined,
  createTestMetadata(),
  {},
  { topologyJson: TOPO_JSON, localUiAssetsHeader: real },
);
assert(get(preloadedFiles, "packages/local-ui-assets.h")?.content === real,
  "preloaded assets: versioned header is emitted verbatim without a second read");

// Mixed-build guard: the index references an asset the manifest doesn't carry
// (stale cache / mid-deploy fetch) — the bundle must hard-fail, not ship a UI
// that boots to a blank page on the device.
{
  const mixed = fs.mkdtempSync(path.join(os.tmpdir(), "local-ui-mixed-"));
  fs.writeFileSync(path.join(mixed, "index.html.gz"), gz('<!doctype html><script src="/main-DEADBEEF.js"></script>'));
  fs.writeFileSync(path.join(mixed, "main-ABC123XY.js.gz"), gz(MAIN_JS));
  fs.writeFileSync(
    path.join(mixed, "device-ui-manifest.json"),
    JSON.stringify({
      version: 1,
      assets: [
        { path: "/", file: "index.html.gz", contentType: "text/html", immutable: false },
        { path: "/main-ABC123XY.js", file: "main-ABC123XY.js.gz", contentType: "text/javascript", immutable: true },
      ],
    }),
  );
  process.env.DEVICE_UI_DIST = mixed;
  let threw = "";
  try {
    await generateLocalUiAssetsHeader(onManifest, TOPO_JSON);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  process.env.DEVICE_UI_DIST = MISSING_DIST;
  assert(threw.includes("main-DEADBEEF.js") && threw.includes("mixed app builds"),
    "mixed build: index referencing a missing asset hard-fails, naming the file");
  fs.rmSync(mixed, { recursive: true, force: true });
}

// An unparseable manifest → placeholder, with a warning naming the manifest.
const badManifest = fs.mkdtempSync(path.join(os.tmpdir(), "local-ui-badman-"));
fs.writeFileSync(path.join(badManifest, "device-ui-manifest.json"), "{not json");
const warns: string[] = [];
const origWarn = console.warn;
console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
process.env.DEVICE_UI_DIST = badManifest;
const badManifestHdr = await generateLocalUiAssetsHeader(onManifest);
assert(badManifestHdr === hdr, "bad manifest: unparseable device-ui-manifest.json falls back to the placeholder");
assert(warns.some(w => w.includes("device-ui-manifest.json") && w.includes("npm run build:device -- <config>")),
  "bad manifest: warning names the fix");

// A manifest pointing at a missing .gz file → placeholder, not a crash.
warns.length = 0;
fs.writeFileSync(
  path.join(badManifest, "device-ui-manifest.json"),
  JSON.stringify({ version: 1, assets: [{ path: "/", file: "gone.html.gz", contentType: "text/html", immutable: false }] }),
);
const missingFileHdr = await generateLocalUiAssetsHeader(onManifest);
console.warn = origWarn;
process.env.DEVICE_UI_DIST = MISSING_DIST;
assert(missingFileHdr === hdr, "missing asset: unreadable .gz falls back to the placeholder");
assert(warns.some(w => w.includes("failed to read")), "missing asset: warning names the failure");
fs.rmSync(badManifest, { recursive: true, force: true });

// Missing manifest (env restored above) → placeholder again, still a valid header.
const backToPlaceholder = await generateLocalUiAssetsHeader(onManifest);
assert(backToPlaceholder === hdr, "fixture: missing manifest falls back to the placeholder table");

fs.rmSync(fixture, { recursive: true, force: true });

// --- Browser path: fetchDeviceUiAssets with a stub fetch -----------------------

{
  const manifestJson = JSON.stringify({
    version: 1,
    assets: [
      { path: "/", file: "index.html.gz", contentType: "text/html", immutable: false },
      { path: "/main-HASH1234.js", file: "main-HASH1234.js.gz", contentType: "text/javascript", immutable: true },
    ],
  });
  const bodies = new Map<string, Uint8Array | string>([
    ["/device-ui/device-ui-manifest.json", manifestJson],
    ["/device-ui/index.html.gz", gz(INDEX_HTML)],
    ["/device-ui/main-HASH1234.js.gz", gz(MAIN_JS)],
  ]);
  const okFetch = (async (url: string) => {
    const body = bodies.get(url);
    if (body === undefined) return { ok: false, status: 404 } as Response;
    return {
      ok: true,
      text: async () => (typeof body === "string" ? body : new TextDecoder().decode(body)),
      arrayBuffer: async () => (typeof body === "string" ? new TextEncoder().encode(body).buffer : body.buffer),
    } as Response;
  }) as typeof fetch;

  const fetched = await fetchDeviceUiAssets(okFetch);
  assert(fetched?.source === "/device-ui/device-ui-manifest.json", "browser: source is the manifest URL");
  assert(fetched?.assets.length === 2, "browser: every manifest asset fetched");
  assert(fetched?.assets[0].servePath === "/" && fetched.assets[0].contentType === "text/html",
    "browser: index entry from the manifest");
  assert(fetched?.assets[1].immutable === true, "browser: immutable flag from the manifest");
  assert(new TextDecoder().decode(gunzipSync(fetched!.assets[1].gz)) === MAIN_JS,
    "browser: asset bytes are the fetched .gz (no re-gzip)");

  // Failed fetch → null (the caller embeds the placeholder) + a loud warning.
  const failFetch = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch;
  const fetchWarns: string[] = [];
  const origFetchWarn = console.warn;
  console.warn = (...args: unknown[]) => fetchWarns.push(args.map(String).join(" "));
  const failed = await fetchDeviceUiAssets(failFetch);
  console.warn = origFetchWarn;
  assert(failed === null, "browser: failed fetch returns null (placeholder fallback)");
  assert(fetchWarns.some(w => w.includes("/device-ui/") && w.includes("placeholder")),
    "browser: failed fetch warns and names the hosting requirement");
}

done();
};
void main();
