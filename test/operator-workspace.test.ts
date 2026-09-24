/**
 * Structural regressions for the fixed operator workspace.
 *
 * These checks intentionally pin the two integration seams that caused the
 * desktop/mobile collapse: DaisyUI owns the generic `dock` class, and X6 cannot
 * be initialized below a `display:none` mobile map because it keeps its fallback
 * 800×600 surface.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = readFileSync(
  join(root, 'src/app/pages/dashboard/operator-workspace.component.ts'),
  'utf8',
);
const routeCard = readFileSync(
  join(root, 'src/app/pages/dashboard/widgets/route-card.component.ts'),
  'utf8',
);
const liveMap = readFileSync(
  join(root, 'src/app/pages/dashboard/canvas/live-map.component.ts'),
  'utf8',
);
const entityIcon = readFileSync(
  join(root, 'src/app/pages/dashboard/operator-entity-icon.component.ts'),
  'utf8',
);
const manualState = readFileSync(
  join(root, 'src/app/pages/dashboard/manual-control-state.ts'),
  'utf8',
);
const automationDialog = readFileSync(
  join(root, 'src/app/pages/automations/route-automations-dialog.component.ts'),
  'utf8',
);
const automationManager = readFileSync(
  join(root, 'src/app/pages/automations/automations-manager.component.ts'),
  'utf8',
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(!/class="[^"]*\bdock\b/.test(workspace), 'operator rail must not reuse DaisyUI\'s reserved dock class');
assert(workspace.includes('class="operator-rail"'), 'workspace keeps a dedicated operator rail');
assert(workspace.includes('class="rail-tabs"') && workspace.includes("railMode()==='routes'") && workspace.includes("railMode()==='manual'"), 'route and manual modes are persistent secondary tabs');
assert(workspace.includes('grid-template-columns:320px minmax(0,1fr)') && workspace.includes('grid-template-columns:280px minmax(0,1fr)'), 'route rail keeps readable desktop and tablet widths');
assert(workspace.includes('<app-operator-entity-icon [kind]="entity.kind" />'), 'entity controls use shared topology symbols');
assert(entityIcon.includes("kind() === 'valve'") && entityIcon.includes('<circle cx="30" cy="30" r="24"'), 'shared symbols distinguish valve and centrifugal pump geometry');
assert(!workspace.includes('◇') && !workspace.includes('◉'), 'manual controls contain no generic placeholder glyphs');
assert(!workspace.includes('entity-panel') && !workspace.includes('inspectorOpen'), 'boolean manual controls do not open a secondary inspector');
assert(workspace.includes('role="switch"') && workspace.includes('manualArmed'), 'manual actuation has an explicit local arm gate');
assert(workspace.includes('HOLD_MS = 900') && workspace.includes('startHold($event,entity)'), 'manual state changes require a 900ms hold');
assert((workspace.match(/this\.entityToggle\.emit\(entity\);/g) ?? []).length === 1, 'one completed hold emits exactly one actuator command');
assert(manualState.includes('!entity.routeControlled') && manualState.includes("entity.state !== 'on'"), 'inline controls do not imply ownership of a route-controlled/running actuator');
assert(workspace.includes("this.railMode.set('manual')") && workspace.includes("this.showMobileView('controls')"), 'map selection routes to the one manual-control surface');
assert(workspace.includes("'Stop all'") && workspace.includes('hasActiveControls'), 'workspace exposes a global stop for routes and manual state');
assert(/\.map-pane\.hidden-mobile\{position:absolute;[^}]*visibility:hidden;pointer-events:none/.test(workspace), 'inactive phone map remains laid out but inert');
assert(routeCard.includes(':host { display: block; width: 100%; min-width: 0; }'), 'route-card host must fill the rail');
assert(routeCard.includes('class="rc-action') && routeCard.includes('(click)="action.emit(view().action)"'), 'only the explicit left route action dispatches hardware commands');
assert(routeCard.includes('class="rc-automation"') && routeCard.includes('readonly automationCount = input(0)'), 'route cards expose a distinct automation counter action');
assert(workspace.includes('<app-route-automations-dialog') && !workspace.includes("navigate(['/site'"), 'route automation management stays in the operator workspace');
assert(routeCard.includes('[class.is-automation-selected]="automationSelected()"'), 'the route remains visibly selected while its automation surface is open');
assert(automationDialog.includes('dialog.showModal()') && automationDialog.includes('(cancel)="cancel($event)"'), 'route automation dialog uses native focus containment and Escape dismissal');
assert(automationDialog.includes('event.clientX < rect.left') && automationDialog.includes('this.closed.emit()'), 'route automation dialog dismisses reliably from its real backdrop and reports closure once');
assert(automationDialog.includes('@media(max-width:767.98px)') && automationDialog.includes('width:100%;height:100%'), 'automation modal becomes a deliberate full-screen phone editor');
assert(automationManager.includes('focusRouteKey') && automationManager.includes('stampRoute(d, route)'), 'the shared manager filters and prefills the selected route');
assert(!routeCard.includes('[class.opacity-60]="!online()"'), 'offline cards preserve readable information hierarchy');
assert(liveMap.includes('this.resizeObs.observe(frame)'), 'X6 resize follows its layout frame');
assert(liveMap.includes('refreshLayout(): void'), 'live map exposes an explicit reveal-time resize');
assert(workspace.includes("this.liveMap()?.refreshLayout()"), 'Map tab reveal immediately synchronises X6');

const liveCanvas = readFileSync(
  join(root, 'src/app/pages/dashboard/canvas/live-canvas.ts'),
  'utf8',
);
assert(liveCanvas.includes('this.narrow = w < 520'), '730px tablet fits the complete topology; phone keeps readable scale');
assert(!liveCanvas.includes('this.graph.clearCells()') && liveCanvas.includes('desiredNodes') && liveCanvas.includes('desiredPipes'), 'operator topology refresh reconciles stable X6 cells instead of rebuilding the graph');
assert(!liveCanvas.includes('materialResize'), 'ordinary resize preserves the operator camera');
assert(liveCanvas.includes("modifiers: ['ctrl']"), 'desktop trackpad pinch zoom is enabled without hijacking wheel scroll');
assert(liveCanvas.includes("addEventListener('touchstart'") && liveCanvas.includes('event.touches.length !== 2') && liveCanvas.includes('this.graph.zoom(nextScale'), 'phone pinch has an explicit two-touch zoom path');
assert(liveCanvas.includes("replaceAll(UI_COLORS.bg, '#ffffff')") && !liveCanvas.includes('[data-part=body] { fill: #ffffff !important'), 'light glyph theming preserves semantic SVG fills such as the tank shell');
assert(liveCanvas.includes('.live-glyph [data-part=body]'), 'live data-part styling is scoped to the live glyph surface');
assert(!liveCanvas.includes('?? [...this.selectableNodeIds].find'), 'idle mobile map must not focus an arbitrary actuator');
assert(liveCanvas.includes('setSafeViewportInsets'), 'canvas exposes inspector-aware safe viewport insets');
assert(liveCanvas.includes('this.graph.translateBy(dx, dy)'), 'entity reveal minimally pans instead of resetting the camera');
assert(liveCanvas.indexOf('this.applyRuntime(); // newly added nodes need current state') < liveCanvas.indexOf('this.applyFlow();'), 'runtime is restored before route styling after topology reconciliation');
assert(liveCanvas.indexOf('this.applyFlow();') < liveCanvas.indexOf('this.applySelection();'), 'selection is layered after route styling');

console.log('operator-workspace: structural responsive guards OK');
