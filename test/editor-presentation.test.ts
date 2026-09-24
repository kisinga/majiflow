import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let passed = 0;
let failed = 0;
function assert(ok: unknown, name: string): void {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}
const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

console.log('Editor presentation contract\n============================');

const editor = source('src/app/pages/editor/topology-x6-tab/topology-x6-tab.component.ts');
const canvas = source('src/app/pages/editor/topology-x6-tab/x6-canvas.ts');
const shapes = source('src/app/pages/editor/topology-x6-tab/scada-shape.ts');
const sidebar = source('src/app/pages/editor/shared/topology-sidebar.component.ts');
const editorShell = source('src/app/pages/editor/editor.component.ts');
const workflow = source('src/app/pages/editor/workspace-rail.component.ts');

assert(editor.includes('class="design-toolbar"') && editor.includes('class="toolbar-actions"'), 'editor has a dedicated responsive tool bar');
assert(!editor.includes('btn btn-ghost btn-xs'), 'primary editor toolbar contains no undersized legacy controls');
assert(editor.includes('grid-template-columns: minmax(0, 1fr) clamp(18rem, 22vw, 21rem)'), 'canvas and inspector use a bounded responsive grid');
assert(editor.includes('background: rgb(255 255 255 / .92)') && !editor.includes('rgba(15,23,42,0.92)'), 'component legend is a light operational surface');
assert(editor.includes('min-height: 44px') && editor.includes('Component legend'), 'editor controls and legend retain semantic sizing and labeling');
assert(canvas.includes("{ color: '#edf2ee' }") && canvas.includes("color: '#cbd8cf'"), 'X6 editor canvas uses the light canvas and grid palette');
assert(shapes.includes(".replaceAll(UI_COLORS.bg, '#ffffff')") && shapes.includes(".replaceAll(UI_COLORS.text, '#152019')"), 'editor nodes remain legible on the light canvas');
assert(sidebar.includes('class="route-key" [title]="route.key"') && sidebar.includes('text-overflow: ellipsis'), 'long derived route keys truncate without widening the page');
assert(canvas.includes('highlight(selection: Selection | null') && canvas.includes('private highlightEdge('), 'presentation rewrite preserves the existing X6 highlight layer');
assert(editorShell.includes('<div class="system-workflow"><app-workspace-rail /></div>') && !editorShell.includes('\n      <app-workspace-rail />'), 'System workflow is contextual header control, not a second site navbar');
assert(workflow.includes('border-radius:12px') && workflow.includes('System workflow'), 'System sections remain a labelled compact segmented control');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
