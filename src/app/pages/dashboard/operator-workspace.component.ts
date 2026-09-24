import { Component, computed, input, output, signal, viewChild, type OnDestroy } from '@angular/core';
import type { CommandPhase, NodeRuntime, RouteControl, RuntimeState, StopSpecOverride } from '@core';
import type { SiteTopology } from '../../core/models/topology.model';
import type { ActivePath, CanvasViewportInsets } from './canvas/live-canvas';
import { LiveMapComponent } from './canvas/live-map.component';
import { RouteCardComponent, type RouteAction } from './widgets/route-card.component';
import type { RunProgress } from './run-progress';
import { OperatorEntityIconComponent } from './operator-entity-icon.component';
import { resolveManualControl } from './manual-control-state';
import { RouteAutomationsDialogComponent } from '../automations/route-automations-dialog.component';

export interface OperatorRouteView {
  controller: string;
  controllerName: string;
  route: RouteControl;
  automationKey: string;
  automationCount: number;
  state: { token: string; reason: string; origin?: string; initiator?: { label: string; support: boolean; title: string } };
  flowRate: number | null;
  progress: RunProgress | null;
  online: boolean;
  phase: CommandPhase | null;
  phaseReason: string;
}

export interface OperatorEntityView {
  id: string;
  controller: string;
  controllerName: string;
  name: string;
  kind: 'valve' | 'pump';
  state: RuntimeState;
  value: number | null;
  unit: string | null;
  online: boolean;
  held: boolean;
  routeControlled: boolean;
  phase: CommandPhase | null;
  phaseReason: string;
}

export interface OperatorRouteAction { controller: string; route: RouteControl; action: RouteAction; }
export interface OperatorRouteRun { controller: string; route: RouteControl; stopSpec: StopSpecOverride; }

/**
 * Fixed operator surface. Selection is always inert. Manual actuation is an
 * inline, armed interaction: hold to acquire or release the manual claim.
 */
@Component({
  selector: 'app-operator-workspace',
  standalone: true,
  imports: [LiveMapComponent, RouteCardComponent, OperatorEntityIconComponent, RouteAutomationsDialogComponent],
  host: { class: 'operator-workspace-host' },
  styles: [`
    :host{display:block;flex:1;min-width:0;min-height:0}app-route-card{--color-primary:var(--op-blue,#196ca6);--color-primary-content:#fff}button{font:inherit}button:focus-visible{outline:3px solid color-mix(in srgb,var(--op-blue,#196ca6) 34%,transparent);outline-offset:2px}
    .workspace{--line:var(--op-border,#d7ded8);position:relative;display:grid;grid-template-columns:320px minmax(0,1fr);width:100%;height:100%;min-height:31rem;overflow:hidden;border-top:1px solid var(--line);background:var(--op-canvas,#edf2ee);color:var(--op-ink,#152019)}
    .operator-rail{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);border-right:1px solid var(--line);background:var(--op-panel,#f3f6f2)}
    .rail-header{min-width:0;padding:12px 14px 14px;border-bottom:1px solid var(--line)}.rail-tabs{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border:1px solid var(--line);border-radius:13px;background:var(--op-panel-strong,#e8eee9)}.rail-tab{min-height:44px;padding:0 10px;display:flex;align-items:center;justify-content:center;gap:7px;border-radius:9px;color:var(--op-muted,#68756d);font-size:12px;font-weight:800;transition:background var(--motion-selection,170ms) var(--ease-standard,ease),color var(--motion-selection,170ms) var(--ease-standard,ease),box-shadow var(--motion-selection,170ms) var(--ease-standard,ease)}.rail-tab svg{width:17px;height:17px;flex:none}.rail-tab.is-active{background:#fff;color:var(--op-blue,#196ca6);box-shadow:0 1px 3px rgb(21 32 25/.1)}
    .eyebrow{color:var(--op-muted,#68756d);font-size:10px;line-height:1;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.rail-title{display:flex;align-items:flex-end;gap:8px;margin-top:15px}.rail-title-copy{min-width:0}.rail-title h2{margin:7px 0 0;font-size:19px;line-height:1.2;font-weight:800}.rail-title>span{margin-left:auto;padding-bottom:2px;color:var(--op-muted,#68756d);font-size:12px;white-space:nowrap}
    .manual-gate{box-sizing:border-box;width:100%;min-height:62px;margin-top:13px;padding:8px 11px;display:flex;align-items:center;gap:11px;border:1px solid var(--line);border-radius:12px;background:#fff;text-align:left;transition:border-color var(--motion-selection,170ms) var(--ease-standard,ease),background var(--motion-selection,170ms) var(--ease-standard,ease),transform var(--motion-press,130ms) var(--ease-standard,ease)}.manual-gate:hover:not(:disabled){border-color:color-mix(in srgb,var(--op-muted,#68756d) 45%,var(--line))}.manual-gate:active:not(:disabled){transform:scale(.992)}.manual-gate.is-armed{border-color:color-mix(in srgb,var(--op-amber,#a85c0e) 48%,var(--line));background:#fff8eb}.manual-gate:disabled{cursor:not-allowed}.gate-icon{width:36px;height:36px;flex:none;display:grid;place-items:center;border-radius:10px;background:var(--op-panel-strong,#e8eee9);color:var(--op-muted,#68756d);transition:background var(--motion-selection,170ms) var(--ease-standard,ease),color var(--motion-selection,170ms) var(--ease-standard,ease)}.gate-icon svg{width:18px;height:18px}.manual-gate.is-armed .gate-icon{background:#fff1d6;color:var(--op-amber,#a85c0e)}.gate-copy{min-width:0;flex:1}.gate-copy strong{display:block;font-size:12px;line-height:1.25}.gate-copy span{display:block;margin-top:3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--op-muted,#68756d);font-size:9px;line-height:1.35}.gate-switch{position:relative;width:40px;height:24px;flex:none;border-radius:999px;background:var(--op-panel-strong,#e8eee9);box-shadow:inset 0 0 0 1px var(--line);transition:background var(--motion-selection,170ms) var(--ease-standard,ease),box-shadow var(--motion-selection,170ms) var(--ease-standard,ease)}.gate-switch::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgb(21 32 25/.25);transition:transform var(--motion-selection,170ms) var(--ease-standard,ease)}.manual-gate.is-armed .gate-switch{background:var(--op-amber,#a85c0e);box-shadow:none}.manual-gate.is-armed .gate-switch::after{transform:translateX(16px)}
    .stop-all{min-height:48px;width:100%;margin-top:14px;padding:0 12px;border:1px solid color-mix(in srgb,var(--op-red,#b42318) 62%,transparent);border-radius:11px;color:var(--op-red,#b42318);background:#fff;font-size:13px;font-weight:800;transition:background var(--motion-press,130ms) var(--ease-standard,ease),transform var(--motion-press,130ms) var(--ease-standard,ease)}.stop-all:hover:not(:disabled){background:color-mix(in srgb,var(--op-red,#b42318) 6%,#fff)}.stop-all:active:not(:disabled){transform:scale(.985)}.stop-all:disabled{color:color-mix(in srgb,var(--op-red,#b42318) 42%,var(--op-muted,#68756d));border-color:var(--line);background:transparent;cursor:not-allowed}
    .rail-scroll{min-width:0;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;align-items:stretch;gap:10px;scrollbar-gutter:stable}.route-controller,.entity-group{margin:7px 3px -2px;color:var(--op-muted,#68756d);font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.empty{margin:auto;padding:24px 12px;color:var(--op-muted,#68756d);text-align:center;font-size:13px;line-height:1.45}
    .entity-row{min-height:58px;width:100%;padding:8px 12px;display:flex;align-items:center;gap:12px;border:1px solid var(--line);border-radius:12px;background:#fff;text-align:left;touch-action:pan-y;transition:border-color var(--motion-selection,170ms) var(--ease-standard,ease),background var(--motion-selection,170ms) var(--ease-standard,ease),transform var(--motion-press,130ms) var(--ease-standard,ease),box-shadow var(--motion-selection,170ms) var(--ease-standard,ease)}.entity-row:hover,.entity-row.is-selected{border-color:color-mix(in srgb,var(--op-green,#147448) 55%,var(--line));background:var(--op-green-surface,#e0f2e8)}.entity-row:active{transform:scale(.995)}.entity-row.is-held{border-color:color-mix(in srgb,var(--op-blue,#196ca6) 55%,var(--line));background:var(--op-blue-surface,#e0f0fb)}.entity-row.is-pending,.entity-row.is-warning{border-color:color-mix(in srgb,var(--op-amber,#a85c0e) 48%,var(--line));background:#fff8eb}.entity-row.is-fault{border-color:color-mix(in srgb,var(--op-red,#b42318) 45%,var(--line));background:#fef3f2}.entity-row.is-offline{background:var(--op-shell,#fbfcfa)}.entity-row.is-disabled{cursor:default}.entity-row:focus-visible{outline:3px solid color-mix(in srgb,var(--op-blue,#196ca6) 34%,transparent);outline-offset:2px}
    .entity-row-copy{min-width:0;flex:1}.entity-row-copy strong{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px}.entity-row-copy span{display:block;margin-top:3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--op-muted,#68756d);font-size:10px}.entity-reading{font-variant-numeric:tabular-nums}.entity-state{max-width:62px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--op-muted,#68756d);font-size:10px;font-weight:700}.entity-state.is-live{color:var(--op-blue,#196ca6)}.entity-row.is-pending .entity-state,.entity-row.is-warning .entity-state{color:var(--op-amber,#a85c0e)}.entity-row.is-fault .entity-state{color:var(--op-red,#b42318)}
    .entity-control{position:relative;width:36px;height:36px;flex:none;display:grid;place-items:center;overflow:hidden;border:1px solid var(--line);border-radius:50%;background:#fff;color:var(--op-muted,#68756d);transition:border-color var(--motion-selection,170ms) var(--ease-standard,ease),color var(--motion-selection,170ms) var(--ease-standard,ease),background var(--motion-selection,170ms) var(--ease-standard,ease)}.entity-control svg{position:relative;z-index:2;width:22px;height:22px;overflow:visible}.entity-control.can-start{border-color:color-mix(in srgb,var(--op-green,#147448) 42%,var(--line));color:var(--op-green,#147448);background:var(--op-green-surface,#e0f2e8)}.entity-control.release{border-color:color-mix(in srgb,var(--op-blue,#196ca6) 48%,var(--line));color:var(--op-blue,#196ca6);background:var(--op-blue-surface,#e0f0fb)}.entity-row.is-pending .entity-control,.entity-row.is-warning .entity-control{border-color:var(--op-amber,#a85c0e);color:var(--op-amber,#a85c0e);background:#fff1d6}.entity-row.is-fault .entity-control{border-color:var(--op-red,#b42318);color:var(--op-red,#b42318);background:#fee4e2}.entity-row.is-offline .entity-control{border-color:var(--line);color:var(--op-muted,#68756d);background:var(--op-panel-strong,#e8eee9)}.entity-control.is-holding{border-color:var(--op-amber,#a85c0e);color:#fff;background:var(--op-amber,#a85c0e)}.entity-control.is-holding::before{content:'';position:absolute;inset:0;background:rgb(255 255 255/.28);transform:scaleY(0);transform-origin:bottom;animation:hold-progress 900ms linear forwards}@keyframes hold-progress{to{transform:scaleY(1)}}
    .entity-reason{margin:-5px 8px 3px;padding-left:48px;color:var(--op-red,#b42318);font-size:10px;line-height:1.35}.hold-summary{margin-top:8px;padding:9px 10px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-radius:9px;background:var(--op-blue-surface,#e0f0fb);color:var(--op-blue,#196ca6);font-size:10px;font-weight:750}.hold-summary span:last-child{font-weight:600;color:var(--op-muted,#68756d)}
    .map-pane{position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--op-canvas,#edf2ee)}.map-status{position:absolute;z-index:12;top:14px;left:14px;max-width:calc(100% - 190px);min-height:44px;padding:8px 12px;display:inline-flex;align-items:center;gap:9px;border:1px solid var(--line);border-radius:11px;background:rgb(255 255 255/.9);box-shadow:0 7px 20px rgb(21 32 25/.08);backdrop-filter:blur(10px);font-size:12px;font-weight:700}.map-status span:last-child{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.status-dot{width:9px;height:9px;flex:none;border-radius:50%;background:var(--op-green,#147448);box-shadow:0 0 0 5px color-mix(in srgb,var(--op-green,#147448) 12%,transparent)}.map-stop{display:none}.mobile-tabs{display:none}
    @media (min-width:768px) and (max-width:1279.98px){.workspace{grid-template-columns:280px minmax(0,1fr)}}
    @media (max-width:767.98px){:host{min-height:0}.workspace{display:flex;flex-direction:column;min-height:0;height:100%;border:0}.mobile-tabs{position:relative;z-index:20;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:7px;border-bottom:1px solid var(--line);background:var(--op-panel,#f3f6f2)}.mobile-tab{min-height:44px;border-radius:11px;color:var(--op-muted,#68756d);font-size:13px;font-weight:800}.mobile-tab.active{background:#fff;color:var(--op-blue,#196ca6);box-shadow:0 1px 3px rgb(21 32 25/.12),inset 0 0 0 1px var(--line)}.operator-rail{display:grid;flex:1;border:0}.operator-rail.hidden-mobile{display:none}.map-pane{flex:1;min-height:31rem}.map-pane.hidden-mobile{position:absolute;inset:59px 0 0;visibility:hidden;pointer-events:none}.rail-header{padding:10px 12px 13px}.rail-scroll{padding:12px;overflow-y:auto}.map-status{top:64px;left:12px;max-width:calc(100% - 24px)}.map-stop{position:absolute;z-index:14;top:12px;left:12px;display:block;min-height:44px;padding:0 12px;border:1px solid color-mix(in srgb,var(--op-red,#b42318) 60%,transparent);border-radius:11px;background:rgb(255 255 255/.92);color:var(--op-red,#b42318);font-size:12px;font-weight:800}}
    @media (prefers-reduced-motion:reduce){.stop-all,.entity-row,.entity-control,.manual-gate,.gate-switch,.gate-switch::after{transition:none}.entity-control.is-holding::before{animation-duration:900ms}}
  `],
  template: `
    <section class="workspace workspace-page" aria-label="Operator workspace">
      <div class="mobile-tabs" role="tablist" aria-label="Workspace view">
        <button class="mobile-tab" [class.active]="mobileView()==='controls'" role="tab" [attr.aria-selected]="mobileView()==='controls'" (click)="showMobileView('controls')">Controls</button>
        <button class="mobile-tab" [class.active]="mobileView()==='map'" role="tab" [attr.aria-selected]="mobileView()==='map'" (click)="showMobileView('map')">Map</button>
      </div>
      <aside class="operator-rail" [class.hidden-mobile]="mobileView()!=='controls'">
        <div class="rail-header">
          <div class="rail-tabs" role="tablist" aria-label="Operator controls">
            <button type="button" class="rail-tab" [class.is-active]="railMode()==='routes'" role="tab" [attr.aria-selected]="railMode()==='routes'" (click)="setRailMode('routes')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h5l3 3h8M4 18h5l3-3h8"/><circle cx="4" cy="6" r="1.5"/><circle cx="4" cy="18" r="1.5"/><path d="m17 6 3 3-3 3m0 0 3 3-3 3"/></svg>
              Routes
            </button>
            <button type="button" class="rail-tab" [class.is-active]="railMode()==='manual'" role="tab" [attr.aria-selected]="railMode()==='manual'" (click)="setRailMode('manual')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>
              Manual
            </button>
          </div>
          <div class="rail-title"><div class="rail-title-copy"><div class="eyebrow">Operator controls</div><h2>{{railMode()==='routes'?'Routes':'Manual controls'}}</h2></div><span>{{railMode()==='routes'?routes().length+' configured':entities().length+' entities'}}</span></div>
          <button class="stop-all" type="button" [disabled]="!canControl()||!hasActiveControls()||stopBusy()" (click)="stopAll.emit()">{{stopBusy()?'Stopping…':'Stop all'}}</button>
          @if(railMode()==='manual'){
            <button type="button" class="manual-gate" [class.is-armed]="manualArmed()" role="switch" [attr.aria-checked]="manualArmed()" [disabled]="!canControl()" (click)="toggleManualArmed()">
              <span class="gate-icon" aria-hidden="true">
                @if(manualArmed()){
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/></svg>
                }@else{
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
                }
              </span><span class="gate-copy"><strong>{{manualArmed()?'Direct control armed':'Direct control locked'}}</strong><span>{{manualArmed()?'Hold an actuator to change it.':'Enable before changing a pump or valve.'}}</span></span><span class="gate-switch" aria-hidden="true"></span>
            </button>
          }
        </div>
        <div class="rail-scroll">
          @if(railMode()==='routes'){
            @for(r of routes();track r.controller+'/'+r.route.routeId;let i=$index){@if(showControllerLabel(r,i)){<div class="route-controller">{{r.controllerName}}</div>}<app-route-card [route]="r.route" [state]="r.state" [flowRate]="r.flowRate" [progress]="r.progress" [fillMs]="fillMs()" [online]="r.online" [phase]="r.phase" [phaseReason]="r.phaseReason" [controllable]="canControl()" [automationKey]="r.automationKey" [automationCount]="r.automationCount" [automationSelected]="automationRoute()?.automationKey===r.automationKey" (action)="emitRouteAction(r,$event)" (run)="emitRouteRun(r,$event)" (automation)="openRouteAutomations(r)"/>}@empty{<p class="empty">No routes are configured yet.</p>}
          }@else{
            @for(entity of entities();track entity.controller+'/'+entity.id;let i=$index){
              @if(showEntityControllerLabel(entity,i)){<div class="entity-group">{{entity.controllerName}}</div>}
              <button type="button" class="entity-row" [id]="entityDomId(entity)" [class.is-selected]="selectedKey()===entityKey(entity)" [class.is-held]="entity.held" [class.is-pending]="entity.phase==='pending'" [class.is-warning]="entity.phase==='expired'" [class.is-fault]="entity.state==='fault'||entity.phase==='refused'" [class.is-offline]="!entity.online||entity.state==='unavailable'" [class.is-disabled]="!canActuate(entity)" [attr.aria-label]="entityAriaLabel(entity)" [attr.aria-disabled]="!canActuate(entity)" [title]="actionLabel(entity)" (click)="selectEntity(entity)" (pointerdown)="startHold($event,entity)" (pointerup)="cancelHold()" (pointercancel)="cancelHold()" (pointerleave)="cancelHold()" (keydown)="onActionKeyDown($event,entity)" (keyup)="onActionKeyUp($event)">
                <span class="entity-control" [class.can-start]="canActuate(entity)" [class.release]="entity.held" [class.is-holding]="pressingKey()===entityKey(entity)" aria-hidden="true"><app-operator-entity-icon [kind]="entity.kind" /></span>
                <span class="entity-row-copy"><strong>{{entity.name}}</strong><span>{{entity.kind==='valve'?'Valve':'Pump'}} · <span class="entity-reading">{{entityMeta(entity)}}</span></span></span>
                <span class="entity-state" [class.is-live]="entity.held||entity.state==='on'">{{actionLabel(entity)}}</span>
              </button>
              @if(entity.phaseReason){<p class="entity-reason" role="status">{{entity.phaseReason}}</p>}
            }@empty{<p class="empty">No manually controllable entities are configured.</p>}
            @if(activeHoldCount()){<div class="hold-summary"><span>{{activeHoldCount()}} active manual {{activeHoldCount()===1?'hold':'holds'}}</span><span>Stop All releases every manual control</span></div>}
          }
        </div>
      </aside>
      <div class="map-pane" [class.hidden-mobile]="mobileView()!=='map'">
        <app-live-map class="block h-full" [fill]="true" [topology]="topology()" [runtime]="runtime()" [activePath]="activePath()" [selectableNodeIds]="selectableNodeIds()" [selectedNodeId]="selectedNodeId()" [safeViewportInsets]="canvasInsets" (nodeSelect)="onMapSelection($event)"/>
        <button type="button" class="map-stop" [disabled]="!canControl()||!hasActiveControls()||stopBusy()" (click)="stopAll.emit()">{{stopBusy()?'Stopping…':'Stop all'}}</button><div class="map-status"><span class="status-dot"></span><span>{{mapStatus()}}</span></div>
      </div>
      @if(automationRoute();as selected){
        <app-route-automations-dialog [siteId]="siteId()" [routeKey]="selected.automationKey" [routeName]="routeName(selected)" [count]="selected.automationCount" (changed)="automationChanged.emit()" (closed)="closeRouteAutomations()"/>
      }
    </section>
  `,
})
export class OperatorWorkspaceComponent implements OnDestroy {
  private static readonly HOLD_MS = 900;
  private readonly liveMap = viewChild(LiveMapComponent);

  readonly topology = input<SiteTopology | null>(null);
  readonly siteId = input.required<string>();
  readonly runtime = input<Map<string, NodeRuntime>>(new Map());
  readonly activePath = input<ActivePath>({ nodes: new Set(), pipes: new Set(), faultNodes: new Set(), faultPipes: new Set() });
  readonly routes = input<OperatorRouteView[]>([]);
  readonly entities = input<OperatorEntityView[]>([]);
  readonly fillMs = input(9000);
  readonly canControl = input(true);
  readonly stopBusy = input(false);

  readonly routeAction = output<OperatorRouteAction>();
  readonly routeRun = output<OperatorRouteRun>();
  readonly automationChanged = output<void>();
  readonly entityToggle = output<OperatorEntityView>();
  readonly stopAll = output<void>();

  protected mobileView = signal<'controls' | 'map'>('controls');
  protected railMode = signal<'routes' | 'manual'>('routes');
  protected selectedKey = signal<string | null>(null);
  protected manualArmed = signal(false);
  protected pressingKey = signal<string | null>(null);
  private automationRouteKey = signal<string | null>(null);
  protected automationRoute = computed(() => this.routes().find((route) => route.automationKey === this.automationRouteKey()) ?? null);
  protected readonly canvasInsets: CanvasViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private holdTimer: ReturnType<typeof setTimeout> | null = null;

  protected selectableNodeIds = computed(() => new Set(this.entities().map((entity) => entity.id)));
  protected selectedNodeId = computed(() => this.selectedKey()?.split('/', 2)[1] ?? null);
  protected activeHoldCount = computed(() => this.entities().filter((entity) => entity.held).length);
  protected hasActiveRoutes = computed(() => this.routes().some((route) => ['PREPARING', 'RUNNING', 'STOPPING'].includes(route.state.token)));
  protected hasActiveControls = computed(() => this.hasActiveRoutes() || this.entities().some((entity) => entity.held || entity.state === 'on'));
  protected mapStatus = computed(() => {
    const active = this.routes().filter((route) => ['PREPARING', 'RUNNING', 'STOPPING'].includes(route.state.token));
    if (!active.length) return 'Live topology · select an actuator to locate its manual control';
    if (active.length === 1) return `${active[0].route.source ?? 'Route'} → ${active[0].route.destination ?? active[0].route.name} · ${active[0].state.token.toLowerCase()}`;
    return `${active.length} routes active`;
  });

  protected entityKey(entity: OperatorEntityView): string { return `${entity.controller}/${entity.id}`; }
  protected entityDomId(entity: OperatorEntityView): string { return `manual-${this.entityKey(entity).replace(/[^a-zA-Z0-9_-]/g, '-')}`; }
  protected emitRouteAction(view: OperatorRouteView, action: RouteAction): void { this.routeAction.emit({ controller: view.controller, route: view.route, action }); }
  protected emitRouteRun(view: OperatorRouteView, stopSpec: StopSpecOverride): void { this.routeRun.emit({ controller: view.controller, route: view.route, stopSpec }); }
  protected openRouteAutomations(view: OperatorRouteView): void { if (view.automationKey) this.automationRouteKey.set(view.automationKey); }
  protected closeRouteAutomations(): void { this.automationRouteKey.set(null); }
  protected routeName(view: OperatorRouteView): string { return `${view.route.source ?? 'Route'} → ${view.route.destination ?? view.route.name}`; }
  protected showControllerLabel(view: OperatorRouteView, index: number): boolean { return this.routes().some((route) => route.controller !== view.controller) && (index === 0 || this.routes()[index - 1]?.controller !== view.controller); }
  protected showEntityControllerLabel(view: OperatorEntityView, index: number): boolean { return this.entities().some((entity) => entity.controller !== view.controller) && (index === 0 || this.entities()[index - 1]?.controller !== view.controller); }

  protected setRailMode(mode: 'routes' | 'manual'): void {
    this.cancelHold();
    this.railMode.set(mode);
    if (mode === 'routes') this.manualArmed.set(false);
  }

  protected toggleManualArmed(): void {
    if (!this.canControl()) return;
    this.cancelHold();
    this.manualArmed.update((armed) => !armed);
  }

  protected selectEntity(entity: OperatorEntityView): void {
    this.selectedKey.set(this.entityKey(entity));
  }

  protected onMapSelection(id: string): void {
    const match = this.entities().find((entity) => entity.id === id);
    if (!match) return;
    this.selectedKey.set(this.entityKey(match));
    this.railMode.set('manual');
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767.98px)').matches) this.showMobileView('controls');
    requestAnimationFrame(() => document.getElementById(this.entityDomId(match))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  protected showMobileView(view: 'controls' | 'map'): void {
    this.cancelHold();
    this.mobileView.set(view);
    if (view === 'map') requestAnimationFrame(() => this.liveMap()?.refreshLayout());
  }

  protected canActuate(entity: OperatorEntityView): boolean {
    return resolveManualControl(entity, this.manualArmed(), this.canControl()).canActuate;
  }

  protected actionLabel(entity: OperatorEntityView): string {
    return resolveManualControl(entity, this.manualArmed(), this.canControl()).action;
  }

  protected actionAriaLabel(entity: OperatorEntityView): string {
    if (entity.held) return `${entity.kind === 'valve' ? 'Release manual hold on' : 'Stop manual'} ${entity.name}`;
    return `Press and hold to ${entity.kind === 'valve' ? 'hold open' : 'run'} ${entity.name}`;
  }

  protected entityAriaLabel(entity: OperatorEntityView): string {
    return `${entity.name}, ${this.stateLabel(entity)}. ${this.actionLabel(entity)}${this.canActuate(entity) ? '; press and hold to change' : ''}`;
  }

  protected stateLabel(entity: OperatorEntityView): string {
    return resolveManualControl(entity, this.manualArmed(), this.canControl()).reported;
  }

  protected entityMeta(entity: OperatorEntityView): string {
    const state = this.stateLabel(entity);
    const reading = entity.value !== null ? ` · ${entity.value}${entity.unit ?? ''}` : '';
    if (entity.held) return `${state} · manual hold${reading}`;
    if (entity.routeControlled) return `${state} · route controlled${reading}`;
    return `${state}${reading}`;
  }

  protected startHold(event: PointerEvent, entity: OperatorEntityView): void {
    event.stopPropagation();
    if (!this.canActuate(entity) || event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.beginHold(entity);
  }

  protected onActionKeyDown(event: KeyboardEvent, entity: OperatorEntityView): void {
    if (!this.canActuate(entity) || event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    this.beginHold(entity);
  }

  protected onActionKeyUp(event: KeyboardEvent): void {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); this.cancelHold(); }
  }

  private beginHold(entity: OperatorEntityView): void {
    this.cancelHold();
    const key = this.entityKey(entity);
    this.pressingKey.set(key);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (this.pressingKey() !== key || !this.canActuate(entity)) return;
      this.pressingKey.set(null);
      navigator.vibrate?.(18);
      this.entityToggle.emit(entity);
    }, OperatorWorkspaceComponent.HOLD_MS);
  }

  protected cancelHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.pressingKey.set(null);
  }

  ngOnDestroy(): void { this.cancelHold(); }
}
