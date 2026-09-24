import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
let failed = 0;

function assert(ok: unknown, name: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

console.log('Authenticated page width contract\n=================================');

const styles = source('src/styles.css');
assert(styles.includes('--page-content-max: 80rem'), 'one shared content width token');
assert(styles.includes('--page-gutter: clamp('), 'one responsive page gutter token');
assert(/\.content-pane,\s*\n\.page-container\s*\{/.test(styles), 'legacy and current page containers share one rule');
assert(/\.workspace-page\s*\{[^}]*max-width:\s*none/s.test(styles), 'full-bleed workspaces are an explicit exception');
assert(styles.includes('--motion-press: 130ms') && styles.includes('--motion-panel: 230ms'), 'shared motion timings are design tokens');
assert(styles.includes('@keyframes op-page-enter') && styles.includes('@keyframes op-popover-enter') && styles.includes('@keyframes op-attention-enter'), 'page, overlay and attention motion use shared keyframes');
assert(/prefers-reduced-motion:\s*reduce/.test(styles) && styles.includes('--motion-camera: 0ms'), 'reduced motion disables interaction and camera timing');

const standardPages = [
  'src/app/pages/home/home.component.ts',
  'src/app/pages/account/account-page.component.ts',
  'src/app/pages/overview/overview.component.ts',
  'src/app/pages/customers/customers-page.component.ts',
  'src/app/pages/devices/devices-page.component.ts',
  'src/app/pages/boards/boards-page.component.ts',
  'src/app/pages/leads/leads-page.component.ts',
  'src/app/pages/settings/settings-page.component.ts',
  'src/app/pages/docs/docs-page.component.ts',
  'src/app/pages/partner/partner-home.component.ts',
  'src/app/pages/partner/partner-org.component.ts',
  'src/app/pages/partner/partner-customer-wizard.component.ts',
  'src/app/pages/automations/automations.component.ts',
  'src/app/pages/billing/billing-shell.component.ts',
  'src/app/pages/editor/site-panel/site-panel.component.ts',
  'src/app/pages/editor/config-tab/config-tab.component.ts',
  'src/app/pages/editor/remotes-tab/remotes-tab.component.ts',
  'src/app/pages/deploy/deploy-page.component.ts',
];

for (const path of standardPages) {
  const text = source(path);
  assert(/\b(?:content-pane|page-container)\b/.test(text), `${path} uses the standard content container`);
}

const obsoleteOuterWidths = [
  /max-w-4xl\s+mx-auto\s+w-full\s+px-6\s+py-8/,
  /max-w-6xl\s+mx-auto\s+w-full\s+px-6\s+py-6/,
  /width:\s*min\(1180px,\s*100%\)/,
  /--content-max:\s*72rem/,
];
const authenticatedSources = standardPages.map(source).join('\n');
assert(!obsoleteOuterWidths.some((pattern) => pattern.test(authenticatedSources)), 'obsolete page-specific outer widths are absent');

const operator = source('src/app/pages/dashboard/operator-workspace.component.ts');
const editor = source('src/app/pages/editor/editor.component.ts');
assert(operator.includes('workspace workspace-page'), 'Operate declares its full-bleed workspace');
assert(editor.includes('system-shell workspace-page'), 'System/Design declares its full-bleed workspace');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
