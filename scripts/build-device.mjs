#!/usr/bin/env node
/**
 * Device-mode app build — the bundle hosted by the server at /device-ui/ so the
 * browser-side firmware codegen can fetch the pre-gzipped assets (and their
 * manifest) at bundle-generation time and embed them into local-ui-assets.h.
 *
 * Usage:
 *   npm run build:device
 *
 * No site config anymore: the topology is NOT baked into the app — the device
 * serves /topology.json (injected into the firmware asset table at generation
 * time) and the app fetches it at runtime.
 *
 * Output (dist/device/browser):
 *   - every surviving asset plus a `<name>.gz` sibling (gzip level 9)
 *   - device-ui-manifest.json — the asset table contract:
 *       { version: 1, assets: [{ path, file, contentType, immutable }] }
 *     `path` is the URL path on the device ("/" is the index); `file` is the
 *     gzipped sibling of the manifest. `immutable` marks content-hashed names.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = 'dist/device/browser';

/** Files that never ship to the device (single source of truth — the codegen
 *  consumer trusts this manifest, it does not re-filter). */
const skip = (r) =>
  r.endsWith('.map') || // source maps never ship
  r === 'index.csr.html' || // SSR artifact; renamed to index.html below
  r.startsWith('marketing/') || // landing imagery — dead weight on flash
  r.startsWith('icons/') || // PWA install icons
  r.startsWith('fonts/') || // self-hosted fonts; the device runs system fonts
  r === 'manifest.webmanifest' ||
  r === 'robots.txt' ||
  r === 'sitemap.xml' ||
  // Service-worker files — device mode disables the SW; pure dead flash.
  r === 'ngsw-worker.js' ||
  r === 'ngsw.json' ||
  r === 'safety-worker.js' ||
  r === 'worker-basic.min.js' ||
  r === 'device-build.json'; // legacy build marker, superseded by the manifest

/** extension → MIME — keep in sync with content_type_for in maji_local_ui/core.cpp. */
const CONTENT_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
};
const contentTypeFor = (p) => CONTENT_TYPES[p.slice(p.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

/** Angular emits content-hashed names as `name-HASH.ext` (8 upper-alnum chars). */
const HASHED_NAME = /-[A-Z0-9]{8}\.[^/]+$/;

/** Serve paths are plain ASCII URL paths — anything else can't be matched over HTTP. */
const SERVABLE_PATH = /^\/([A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*)?$/;

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

/**
 * Pack a device-app browser dist: apply the skip list, gzip every surviving
 * file (level 9) to a `<name>.gz` sibling, and write device-ui-manifest.json.
 * Returns the manifest's assets array (exported for tests).
 */
export function packDeviceUiDist(dist) {
  const assets = [];
  let totalRaw = 0;
  let totalGz = 0;
  const walk = (rel) => {
    const entries = readdirSync(rel ? join(dist, rel) : dist, { withFileTypes: true })
      // Bytewise, not localeCompare — the manifest must be identical on every machine.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(r);
        continue;
      }
      if (!e.isFile()) continue;
      if (skip(r)) continue;
      const servePath = r === 'index.html' ? '/' : `/${r}`;
      if (!SERVABLE_PATH.test(servePath)) {
        console.warn(`build:device: skipping ${r} — path can't be served by the flat asset table`);
        continue;
      }
      const raw = readFileSync(join(dist, r));
      const gz = gzipSync(raw, { level: 9 });
      writeFileSync(join(dist, `${r}.gz`), gz);
      totalRaw += raw.length;
      totalGz += gz.length;
      assets.push({
        path: servePath,
        file: `${r}.gz`,
        contentType: contentTypeFor(r),
        immutable: HASHED_NAME.test(r),
      });
    }
  };
  walk('');

  writeFileSync(join(dist, 'device-ui-manifest.json'), JSON.stringify({ version: 1, assets }, null, 2) + '\n');
  console.log(`packed ${assets.length} asset(s), ${kb(totalRaw)} raw → ${kb(totalGz)} gz (${dist})`);
  return assets;
}

function main() {
  // Device builds are release artifacts, not watch builds. Mark the child as CI
  // so Angular disables its local LMDB cache; on macOS that native cache can
  // abort while reopening the second (file-replaced) build target. The normal
  // cloud/watch workflow keeps its cache.
  const run = (cmd, args) => execFileSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, CI: '1' },
  });

  // Invoke the CLI's JS entry directly: spawning the ng.cmd shim throws EINVAL
  // under Node ≥18.20's CVE-2024-27980 hardening on win32.
  run('node', ['node_modules/@angular/cli/bin/ng.js', 'build', '--configuration', 'device']);

  // The device router is hash-location based and the firmware serves index.html
  // for every navigation GET — but the SSR-flavored build names the CSR shell
  // index.csr.html. Rename it so it can be embedded as the "/" entry.
  if (!existsSync(`${DIST}/index.csr.html`))
    throw new Error('dist/device/browser/index.csr.html missing — unexpected device build output');
  renameSync(`${DIST}/index.csr.html`, `${DIST}/index.html`);

  packDeviceUiDist(DIST);
  console.log(`device build ready: ${DIST}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
