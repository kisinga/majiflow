/** Structural guard for the authenticated visual system.
 *
 * The shell owns the operational palette. Feature pages may consume its tokens,
 * but must not quietly restore the retired green-grey theme locally.
 */
import { readFileSync } from 'node:fs';

const read = (path: string): string => readFileSync(path, 'utf8');
const appCss = read('src/app/app.css');
const globalCss = read('src/styles.css');
const appHtml = read('src/app/app.html');
const appTs = read('src/app/app.ts');
const dashboard = read('src/app/pages/dashboard/dashboard.component.ts');
const editor = read('src/app/pages/editor/editor.component.ts');
const automations = read('src/app/pages/automations/automations.component.ts');
const billing = read('src/app/pages/billing/billing-shell.component.ts');
const operator = read('src/app/pages/dashboard/operator-workspace.component.ts');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(
  ['--op-navy:', '--op-brand:', '--op-cyan:', '--op-amber-soft:', '--op-red-soft:'].every((token) => appCss.includes(token)),
  'shell defines the complete blue-led semantic palette',
);
assert(
  ![dashboard, editor, automations, billing].some((source) => /:host\{--op-(?:shell|panel|border|ink|muted):#/.test(source)),
  'feature shells inherit the shared palette instead of redeclaring it',
);
assert(appCss.includes('linear-gradient(180deg, var(--op-navy)') && appCss.includes('.rail-link.is-active::before'), 'navigation has a stable navy frame and a clear active marker');
assert(globalCss.includes('.authenticated-shell .btn-primary') && globalCss.includes('.authenticated-shell :where(.input, .select, .textarea):focus'), 'buttons and fields share the same importance and focus hierarchy');
assert(globalCss.includes('.toggle:checked') && globalCss.includes('background-color: var(--op-surface)'), 'checked toggles stay restrained instead of becoming a competing solid color');
assert(appHtml.match(/showPressRipple\(\$event\)/g)?.length === 2 && appTs.includes("ripple.className = 'ui-ripple'"), 'public and authenticated controls receive delegated press feedback');
assert(operator.includes('class="entity-row" data-no-ripple'), 'hold-to-act safety controls keep their progress feedback instead of a misleading click ripple');

console.log('ui-theme: shared palette and interaction hierarchy OK');
