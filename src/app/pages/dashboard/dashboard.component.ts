import { Component, computed, inject, signal, type OnDestroy, type Signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { buildDashboardSpec, createEmptySiteTopology, parseTopology, routeLabel, describeState, listAutomatableRoutes, FAULT_MEANINGS, STOP_REASON_MEANINGS, COMMAND_TTL_S, type CommandAction, type CommandPhase, type DashboardWidget, type ActuatorControl, type RuntimeState } from '@core';
import { BackendService } from '../../core/services/backend.service';
import { AuthStore } from '../../core/services/auth.store';
import { FeatureFlagsService } from '../../core/services/feature-flags.service';
import { DashboardStore } from './dashboard.store';
import { TelemetryStore } from './telemetry.store';
import { CommandLifecycleStore } from './command-lifecycle.store';
import { runProgress, type RunProgress } from './run-progress';
import { DashboardCardComponent } from './widgets/dashboard-card.component';
import { UsageTotalsComponent } from './widgets/usage-totals.component';
import { SiteControlsComponent } from './widgets/site-controls.component';
import { ControllerHealthComponent } from './widgets/controller-health.component';
import { HealthHistoryComponent } from './widgets/health-history.component';
import { BillingOutstandingComponent } from './widgets/billing-outstanding.component';
import { MeterValveComponent } from './widgets/meter-valve.component';
import { CONTROLLER_PALETTE } from '../../core/util/site-colors';
import { DEVICE_MODE } from '../../core/tokens/device-mode';
import type { SiteTopology } from '../../core/models/topology.model';
import type { RouteControl, StopSpecOverride } from '@core';
import { WidgetGridComponent } from '../../widgets/widget-grid.component';
import { filterByEntitlement, filterForBuild, type WidgetDef } from '../../widgets/registry';
import { resolveLayout, type LayoutItem } from '../../widgets/layout';
import { CapabilitiesService, type CapabilitiesState } from '../../widgets/capabilities.service';
import { DashboardLayoutService } from '../../widgets/layout.service';
import { WIDGET_DEFS } from './widget-defs';
import { buildDefaultLayout, WIDGET_ZONE } from './default-layout';
import { resolveRender, type WidgetRender } from './widgets';
import {
  OperatorWorkspaceComponent,
  type OperatorEntityView,
  type OperatorRouteAction,
  type OperatorRouteRun,
  type OperatorRouteView,
} from './operator-workspace.component';
import { AutomationsService, type AutomationRecord } from '../automations/automations.service';

/**
 * The site dashboard shell (`/site/:name/dashboard`): the runtime stores
 * and widget components. The fixed operator workspace owns routes, topology and
 * direct entity control; reporting/diagnostic widgets remain in the customizable
 * grid below it. The secondary layout is
 * `resolveLayout(stored, buildDefaultLayout(spec))` — the stored layout (when
 * one exists) wins on order/width/visibility, the auto-derived default fills
 * the rest. Edit mode (the Customize toggle, ≥640px only) stages
 * reorder/resize/hide edits in a draft and saves them as the caller's personal
 * layout — or the shared site default for owners.
 *
 * The presentation is state-driven: an attention banner surfaces faults,
 * offline controllers and a live safety override above the grid (absent when
 * the system is calm). The X6 topology is the same renderer at every breakpoint:
 * mobile changes composition and camera framing, not the graph implementation.
 *
 * One shell serves both builds. The device build (served from the controller's
 * flash) swaps the network surfaces via device.providers.ts (realtime/backend/
 * automations/layout) and drops the cloud-only widgets through the registry's
 * `cloudOnly` flag (`filterForBuild`) — history charts, usage totals and
 * health history have no backing endpoint on the device. Billing/Docs in the
 * header are cloud-backed too and hide on DEVICE_MODE.
 */
@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterLink, WidgetGridComponent, DashboardCardComponent, UsageTotalsComponent, SiteControlsComponent, ControllerHealthComponent, HealthHistoryComponent, OperatorWorkspaceComponent, BillingOutstandingComponent, MeterValveComponent],
  providers: [DashboardStore, TelemetryStore, CommandLifecycleStore],
  host: { class: 'flex-1 min-h-0 min-w-0 flex overflow-hidden' },
  styles: [`
    :host{--op-green-surface:var(--op-green-soft);--op-blue-surface:var(--op-blue-soft)}
    .dashboard-page{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;overflow:hidden;background:transparent;color:var(--op-ink)}
    .site-context-header{height:64px;min-height:64px;padding:0 24px;display:flex;align-items:center;gap:20px;border-bottom:1px solid var(--op-border);background:rgb(255 255 255/.88);box-shadow:0 5px 18px rgb(18 35 59/.045);backdrop-filter:blur(16px) saturate(1.2)}
    .site-context-copy{min-width:0}.site-context-copy h1{margin:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:18px;line-height:1.25;font-weight:800}.site-context-copy p{margin:3px 0 0;color:var(--op-muted);font-size:11px}.site-context-actions{margin-left:auto;display:flex;align-items:center;gap:8px}.online-summary{min-height:44px;padding:0 8px;display:flex;align-items:center;gap:8px;color:var(--op-green);font-size:12px;font-weight:700;white-space:nowrap}.online-summary i{width:8px;height:8px;border-radius:50%;background:var(--op-muted)}.online-summary i.is-online{background:var(--op-green);box-shadow:0 0 0 5px var(--op-green-surface)}
    .context-chip{padding:5px 8px;border-radius:999px;background:var(--op-panel-strong);color:var(--op-muted);font-size:10px;font-weight:800}.context-chip.is-warning{background:var(--op-amber-soft);color:var(--op-amber)}.context-button{min-height:44px;padding:0 14px;border:1px solid var(--op-border);border-radius:11px;background:#fff;box-shadow:var(--op-shadow-sm);font-size:12px;font-weight:750;transition:border-color var(--motion-press) var(--ease-standard),color var(--motion-press) var(--ease-standard),box-shadow var(--motion-press) var(--ease-standard),transform var(--motion-press) var(--ease-standard)}.context-button:hover{border-color:var(--op-blue);color:var(--op-blue);box-shadow:var(--op-shadow-md);transform:translateY(-1px)}.context-button:active{transform:translateY(1px) scale(.98)}
    .site-more{position:relative}.site-more summary{width:44px;height:44px;display:grid;place-items:center;border-radius:11px;cursor:pointer;list-style:none;font-weight:800}.site-more summary::-webkit-details-marker{display:none}.site-more summary:hover{background:var(--op-panel)}.site-more-menu{position:absolute;z-index:50;top:calc(100% + 6px);right:0;width:190px;padding:6px;border:1px solid var(--op-border);border-radius:11px;background:#fff;box-shadow:var(--op-shadow-lg);transform-origin:right top;animation:op-popover-enter var(--motion-panel) var(--ease-enter) both}.site-more-menu a,.site-more-menu button{width:100%;min-height:40px;padding:0 10px;display:flex;align-items:center;border-radius:8px;text-align:left;font-size:12px}.site-more-menu a:hover,.site-more-menu button:hover{color:var(--op-brand-deep);background:var(--op-blue-soft)}
    .page-state{margin:auto;color:var(--op-muted)}.operate-region{display:flex;flex:1;min-height:0;flex-direction:column}.admin-strip,.attention-strip{min-height:42px;padding:7px 18px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--op-border);font-size:12px;animation:op-attention-enter var(--motion-mode,200ms) var(--ease-enter,ease) both}.admin-strip{background:var(--op-amber-soft);color:var(--op-amber)}.attention-strip.is-error{background:var(--op-red-soft);color:var(--op-red)}.attention-strip.is-warning{background:var(--op-amber-soft);color:var(--op-amber)}.attention-strip.is-info{background:var(--op-blue-soft);color:var(--op-brand-deep)}.strip-spacer{flex:1}.strip-button{min-height:32px;padding:0 10px;border:1px solid currentColor;border-radius:8px;font-weight:750;transition:background var(--motion-press) var(--ease-standard),transform var(--motion-press) var(--ease-standard)}.strip-button:hover{background:rgb(255 255 255/.58)}.strip-button:active{transform:scale(.97)}.note-strip{padding:6px 18px;border-bottom:1px solid var(--op-border);color:var(--op-muted);background:rgb(255 255 255/.48);font-size:10px;animation:op-attention-enter var(--motion-mode,200ms) var(--ease-enter,ease) both}
    .insights-scroll,.settings-scroll{flex:1;min-height:0;overflow:auto}.section-intro{margin-bottom:20px}.section-intro h2{margin:0;font-size:20px;font-weight:800}.section-intro p{margin:5px 0 0;color:var(--op-muted);font-size:13px}.customize-panel{margin-bottom:18px;padding:14px;border:1px solid var(--op-border);border-radius:15px;background:var(--op-panel)}.customize-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.customize-actions h2{margin:0;font-size:14px}.customize-actions .grow{flex:1}.save-message{margin-bottom:12px;color:var(--op-green);font-size:12px}.settings-docs{margin-top:16px;min-height:52px;padding:0 16px;display:inline-flex;align-items:center;border:1px solid var(--op-border);border-radius:11px;background:#fff;font-size:13px;font-weight:750}
    @media(max-width:767.98px){.site-context-header{display:none}.dashboard-page{height:100%}.operate-region{min-height:0}.admin-strip,.attention-strip{padding-inline:14px}.attention-strip span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  `],
  template: `
    <div class="dashboard-page" [class.is-operate]="workspaceView === 'operate'">
      <header class="site-context-header">
        <div class="site-context-copy">
          <h1>{{ siteName() || 'Site' }}</h1>
          <p>{{ viewSubtitle() }}</p>
        </div>
        <div class="site-context-actions">
          @if (adminViewing()) { <span class="context-chip" [class.is-warning]="controlEnabled()">{{ controlEnabled() ? 'Controlling' : 'Read-only' }}</span> }
          <span class="online-summary"><i [class.is-online]="onlineCount() > 0"></i>{{ onlineCount() }}/{{ totalControllers() }} online</span>
          <app-controller-health />
          @if (workspaceView === 'insights' && !editing()) {
            <button class="context-button" type="button" (click)="startCustomize()">Customize</button>
          }
          @if (!deviceMode) {
            <details class="site-more">
              <summary aria-label="Site actions" title="Site actions">•••</summary>
              <div class="site-more-menu">
                <button type="button" (click)="openDocs()" [disabled]="docBusy()">{{ docBusy() ? 'Preparing documentation…' : 'Site documentation' }}</button>
                @if (billingEnabled()) { <a [routerLink]="['/site', siteId, 'billing']">Billing</a> }
                <a [routerLink]="['/site', siteId, 'settings']">Site settings</a>
              </div>
            </details>
          }
        </div>
      </header>

      @if (store.loading()) {
        <div class="page-state"><span class="loading loading-spinner loading-lg"></span></div>
      } @else if (store.error()) {
        <div class="alert alert-error text-sm">{{ store.error() }}</div>
      } @else if (loadError()) {
        <div class="alert alert-error text-sm">{{ loadError() }}</div>
      } @else {
        <!-- Managers who do not own this site stay read-only until they explicitly
             take control. Keep this gate beside every command-bearing workspace;
             sibling routes recreate the component, so Settings cannot borrow the
             Operate page's transient grant. -->
        @if (adminViewing() && workspaceView !== 'insights') {
          <div class="admin-strip">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              @if (controlEnabled()) {
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              } @else {
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z M2.46 12C3.73 7.94 7.52 5 12 5c4.48 0 8.27 2.94 9.54 7-1.27 4.06-5.06 7-9.54 7-4.48 0-8.27-2.94-9.54-7z"/>
              }
            </svg>
            <span class="strip-spacer">
              @if (controlEnabled()) {
                You have control of <strong>{{ siteName() }}</strong> (a customer's site). Commands you send are recorded against your account.
              } @else {
                Admin view — <strong>{{ siteName() }}</strong> is a customer's site. You're viewing read-only.
              }
            </span>
            @if (controlEnabled()) {
              <button class="strip-button" (click)="controlEnabled.set(false)">Release control</button>
            } @else {
              <button class="strip-button" (click)="controlEnabled.set(true)">Take control</button>
            }
          </div>
        }

        @if (workspaceView === 'operate') {
        <div class="operate-region">
        <!-- Attention: the state-driven "needs your eyes NOW" signals — faults,
             offline controllers, a live safety override. Absent when calm. -->
        @if (attention()[0]; as a) {
          <div class="attention-strip" role="alert" [class.is-error]="a.tone === 'error'" [class.is-warning]="a.tone === 'warning'" [class.is-info]="a.tone === 'info'">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            </svg>
            <span class="flex-1">{{ a.text }}</span>
            @if (attention().length > 1) { <strong>+{{ attention().length - 1 }} more</strong> }
          </div>
        }

        @if (note()) { <div class="note-strip" role="status" aria-live="polite">{{ note() }}</div> }

        <!-- The fixed operational core: route touch targets on the left, the same
             live X6 topology at every breakpoint, and armed inline manual controls.
             Map selection only locates a control; it never issues a command. This
             surface is not layout-customizable because
             moving/hiding primary controls is an operational regression. -->
        <app-operator-workspace
          [siteId]="siteId"
          [topology]="topology()"
          [runtime]="store.nodeRuntime()"
          [activePath]="store.activePath()"
          [routes]="operatorRoutes()"
          [entities]="operatorEntities()"
          [fillMs]="fillMs()"
          [canControl]="canControl()"
          [stopBusy]="stopAllBusy()"
          (routeAction)="onOperatorRouteAction($event)"
          (routeRun)="onOperatorRouteRun($event)"
          (automationChanged)="onAutomationsChanged()"
          (entityToggle)="onOperatorEntityToggle($event)"
          (stopAll)="stopAllRoutes()"
        />
        </div>
        } @else if (workspaceView === 'insights') {
        <div class="insights-scroll"><div class="insights-inner page-container">
        @if (saveMsg()) { <div class="save-message">{{ saveMsg() }}</div> }

        <!-- Edit mode: toolbar (save / site default / reset / cancel) above the
             widget picker, which lists every layout item by name — hidden ones
             included — and toggles visibility. The grid itself does drag-reorder,
             width cycling and hiding. Edits stage in the draft signal until Save. -->
        @if (editing()) {
          <div class="customize-panel">
            <div class="customize-actions">
              <h2 class="section-label">Customize dashboard</h2>
              <span class="grow"></span>
              <button class="btn btn-xs btn-primary" [disabled]="saveBusy()" (click)="saveLayout('user')">
                @if (saveBusy()) { <span class="loading loading-spinner loading-xs"></span> }
                Save
              </button>
              @if (isSiteOwner() && !deviceMode) {
                <button class="btn btn-xs btn-outline" [disabled]="saveBusy()" (click)="saveLayout('site')"
                        title="Make this layout the default for everyone on this site">Set as site default</button>
              }
              <button class="btn btn-xs btn-ghost" [disabled]="saveBusy()" (click)="resetLayout()"
                      title="Forget all saved layouts and use the automatic one">Reset to default</button>
              <button class="btn btn-xs btn-ghost" [disabled]="saveBusy()" (click)="cancelEdit()">Cancel</button>
            </div>
            @if (saveError()) { <div class="alert alert-error text-sm mb-3">{{ saveError() }}</div> }
            <p class="text-xs text-base-content/50 my-2">Reorder reporting and diagnostic widgets. Operational controls stay in Operate.</p>
            <div class="flex flex-wrap gap-1.5">
              @for (item of gridItems(); track item.instanceId) {
                <button type="button" class="btn btn-xs" [class.btn-outline]="!item.hidden" [class.opacity-40]="item.hidden"
                        [attr.aria-pressed]="!item.hidden"
                        [title]="(item.hidden ? 'Show' : 'Hide') + ' ' + labelFor(item)"
                        (click)="toggleHidden(item)">
                  {{ labelFor(item) }}
                </button>
              }
            </div>
          </div>
        }

        <!-- The widget grid: items render in layout order at their layout width;
             hidden items are skipped (edit mode manages them via the picker
             above). The parent template below owns what each instance renders. -->
        <div>
        <app-widget-grid [items]="gridItems()" [itemTemplate]="cell" [editing]="editing()" (itemsChange)="onItemsChange($event)" />
        </div>
        <ng-template #cell let-item>
          @if (renderFor(item); as r) {
            @switch (r.kind) {
              @case ('telemetry') {
                <app-dashboard-card
                  [widget]="r.widget"
                  [dense]="denseWidget(r.widget)"
                  [controllerLabel]="showController() ? ctrlName(r.widget.controller) : ''"
                  [controllerColor]="ctrlColor(r.widget.controller)"
                  [row]="store.rowFor(r.widget)"
                  [state]="cardState(r.widget)"
                  [series]="telemetry.seriesFor(r.widget)"
                  [span]="telemetry.spanFor(r.widget)"
                  [items]="store.activityFor(r.widget.controller)"
                  [actuatable]="false"
                  [held]="actuatorHeld(r.widget)"
                  [phase]="actuatorPhase(r.widget)?.phase ?? null"
                  [phaseReason]="actuatorPhase(r.widget)?.reason ?? ''"
                  [actuatorKind]="actuatorFor(r.widget)?.kind ?? ''"
                  [historyLoaded]="telemetry.loadedFor(r.widget)"
                  (toggle)="toggleWidgetActuator(r.widget)"
                  (spanChange)="onSpanChange(r.widget, $event)"
                  (expand)="onExpand(r.widget)"
                />
              }
              @case ('usage') {
                <app-usage-totals [spec]="store.spec()" />
              }
              @case ('health') {
                <app-health-history [siteId]="siteId" />
              }
              @case ('billing-outstanding') {
                <app-billing-outstanding [siteId]="siteId" />
              }
              @case ('meter-valve') {
                <app-meter-valve [siteId]="siteId" />
              }
            }
          }
        </ng-template>
        </div></div>
        } @else {
          <div class="settings-scroll"><div class="settings-inner page-container">
            <div class="section-intro"><h2>Site settings</h2><p>Operational defaults, equipment calibration and safety controls for this site.</p></div>
            <app-site-controls [siteId]="siteId" [canControl]="canControl()" mode="page" />
            @if (!deviceMode) { <button type="button" class="settings-docs" (click)="openDocs()" [disabled]="docBusy()">{{ docBusy() ? 'Preparing documentation…' : 'Open site documentation' }}</button> }
          </div></div>
        }
      }
    </div>
  `,
})
export class DashboardComponent implements OnDestroy {
  private route = inject(ActivatedRoute);
  private backend = inject(BackendService);
  private auth = inject(AuthStore);
  private flags = inject(FeatureFlagsService);
  protected store = inject(DashboardStore);
  protected telemetry = inject(TelemetryStore);
  protected lifecycle = inject(CommandLifecycleStore);
  private capabilitiesService = inject(CapabilitiesService);
  private layouts = inject(DashboardLayoutService);

  /** Operate, Insights and Settings share the loaded site/runtime context but
   *  expose purpose-built surfaces. The route data is the single view switch. */
  protected readonly workspaceView = (this.route.snapshot.data['workspaceView'] ?? 'operate') as 'operate' | 'insights' | 'settings';
  protected viewSubtitle(): string {
    const controllers = this.store.spec().controllers;
    const controller = controllers.length === 1 ? controllers[0]?.name : `${controllers.length} controllers`;
    const view = this.workspaceView === 'operate' ? 'Operator workspace' : this.workspaceView === 'insights' ? 'Insights' : 'Settings';
    return controller ? `${view} · ${controller}` : view;
  }

  /** Device-mode build (served from the controller's flash): the cloud-only
   *  surfaces — history charts, water usage, health history, billing, docs,
   *  the site-default layout — are hidden; the registry's `cloudOnly` filter
   *  drops the chart/usage/health widgets. Routes, tank levels, valves/pumps,
   *  the live map, command tracking and the Activity feed (the snapshot's
   *  on-device event ring) stay. */
  protected deviceMode = inject(DEVICE_MODE);

  /** Tenant-billing header link: feature-flag gated (same as the old dashboard). */
  protected billingEnabled = computed(() => this.flags.isEnabled('billing_module'));

  protected siteId = '';
  protected siteName = signal('');
  protected note = signal<string | null>(null);

  /** Parsed topology, kept for the live map (the card spec is derived separately). */
  protected topology = signal<SiteTopology | null>(null);
  /** Route automation rows are lightweight operator metadata: they feed the count
   *  on each route card and refresh in realtime without coupling commands to CRUD. */
  private automationRows = signal<AutomationRecord[]>([]);
  private automationUnsub: (() => void | Promise<void>) | null = null;
  private automatableRouteMap = computed(() => {
    const map = new Map<string, { routeKey: string }>();
    const topology = this.topology();
    if (!topology) return map;
    for (const route of listAutomatableRoutes(topology)) {
      map.set(`${route.controllerId}/${route.routeIndex}`, { routeKey: route.routeKey });
    }
    return map;
  });
  private automationCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const row of this.automationRows()) counts.set(row.route_key, (counts.get(row.route_key) ?? 0) + 1);
    return counts;
  });
  /** Fill glide for the route progress bar ~ the snapshot interval (held on the
   *  topology), so the bar moves continuously between updates instead of stepping. */
  protected fillMs = computed(() => {
    const secs = (this.topology() as { timing?: { update_interval?: number } } | null)?.timing?.update_interval;
    return (secs && secs > 0 ? secs : 10) * 1000;
  });

  // --- Layout (registry + capabilities + stored layout) ---------------------

  /** The site's capability state; empty until loaded and on failure, so
   *  entitled widgets fail CLOSED (hidden) rather than flashing in. */
  private capState: Signal<CapabilitiesState> = signal<CapabilitiesState>('loading');
  /** The registry filtered to what this site is entitled to and what this build
   *  serves (cloud-only widgets drop out on the device build). */
  private entitledDefs = computed<WidgetDef[]>(() => {
    const s = this.capState();
    return filterForBuild(filterByEntitlement(WIDGET_DEFS, Array.isArray(s) ? s : []), this.deviceMode);
  });
  /** The stored layout (cache first for instant paint, then the PB row). */
  private storedLayout = signal<LayoutItem[] | null>(null);

  /** Phone form factor (<640px), read once like the old dashboard's cards-on-
   *  mobile default (SSR defaults to mobile): the map starts hidden there —
   *  the cards are the phone's monitoring surface. */
  private readonly mobile = signal(
    typeof window === 'undefined' ? true : window.matchMedia('(max-width: 639.98px)').matches,
  );

  /** The effective layout AND the per-instance render instruction, resolved in
   *  ONE pass: the stored layout wins where it has entries, the auto-derived
   *  default fills the rest; entitlement-filtered defs drop out; and an
   *  instance whose subject vanished (`resolveRender` → null, e.g. a stored
   *  entry for a since-removed route) drops OUT of the layout instead of
   *  occupying a dead grid cell (invisible slot in view mode, ghost chrome in
   *  edit mode). Zone labels are re-derived from the widget id at render
   *  time — a function of the widget, never stored state. */
  private resolved = computed(() => {
    const defs = this.entitledDefs();
    const allowed = new Set(defs.map((d) => d.id));
    const spec = this.store.spec();
    const derived = buildDefaultLayout(spec, defs, { mobile: this.mobile() });
    const items: LayoutItem[] = [];
    const renders = new Map<string, WidgetRender>();
    for (const i of resolveLayout(this.storedLayout(), derived)) {
      if (!allowed.has(i.widgetId)) continue;
      const r = resolveRender(i, spec, defs);
      if (!r) continue;
      const item = { ...i, section: WIDGET_ZONE[i.widgetId] };
      items.push(item);
      renders.set(item.instanceId, r);
    }
    return { items, renders };
  });
  protected layout = computed<LayoutItem[]>(() => this.resolved().items);

  // --- Attention (state-driven, above everything) ---------------------------

  /** What needs the operator's eyes RIGHT NOW: faults, offline controllers,
   *  a live safety override. Empty when the system is calm — no chrome begging
   *  for attention when nothing is wrong. Rendered above the grid. */
  protected attention = computed<{ tone: 'error' | 'warning' | 'info'; text: string }[]>(() => {
    const out: { tone: 'error' | 'warning' | 'info'; text: string }[] = [];
    for (const c of this.store.spec().controllers) {
      if (!this.store.presence(c.controller).online) {
        out.push({ tone: 'info', text: `${c.name} is offline — controls are disabled; showing the last known state.` });
      }
      if (this.store.overrideOn(c.controller)) {
        out.push({ tone: 'warning', text: `Safety override is ON on ${c.name} — level gates and watchdogs are bypassed. Turn it off in Setup when you're done.` });
      }
      for (const r of c.routes) {
        const st = this.store.routeState(c.controller, r.routeId);
        if (st?.token === 'FAULT') {
          const reason = st.reason ? describeState({ ...FAULT_MEANINGS, ...STOP_REASON_MEANINGS }, st.reason).label : '';
          out.push({ tone: 'error', text: `Fault on ${routeLabel(r, r.routeId)}${reason ? ` — ${reason}` : ''}. Reset it from the route card.` });
        }
      }
    }
    return out;
  });

  /** instanceId → render instruction, from the same pass that built the layout
   *  (dead instances are already excluded, so a miss renders nothing). */
  private renderMap = computed(() => this.resolved().renders);
  protected renderFor(item: LayoutItem): WidgetRender | null {
    return this.renderMap().get(item.instanceId) ?? null;
  }

  // --- Edit mode (layout customization) -------------------------------------

  /** Edit mode on/off. Edits stage in {@link draft} until Save. */
  protected editing = signal(false);
  /** The in-progress layout while editing; null outside edit mode. */
  protected draft = signal<LayoutItem[] | null>(null);
  /** What the secondary grid renders. The operational map/routes are fixed in the
   *  workspace above, so stale saved instances are deliberately filtered here. */
  protected gridItems = computed<LayoutItem[]>(() =>
    (this.draft() ?? this.layout()).filter((i) => i.widgetId !== 'live-map' && i.widgetId !== 'route-card'));
  /** Site co-owner ids from the site record — gates "Set as site default"
   *  (the collection rules enforce it server-side too). */
  private siteOwners = signal<string[]>([]);
  protected isSiteOwner = computed(() => {
    const me = this.auth.user()?.id;
    return !!me && this.siteOwners().includes(me);
  });
  protected saveBusy = signal(false);
  /** Brief inline confirmation after a save/reset; auto-clears. */
  protected saveMsg = signal<string | null>(null);
  /** Save/reset failure — edits are kept, shown inside the edit panel. */
  protected saveError = signal<string | null>(null);
  private saveMsgTimer = 0;

  protected startCustomize(): void {
    this.draft.set(this.layout());
    this.saveError.set(null);
    this.editing.set(true);
  }

  protected cancelEdit(): void {
    this.draft.set(null);
    this.saveError.set(null);
    this.editing.set(false);
  }

  protected onItemsChange(items: LayoutItem[]): void {
    this.draft.set(items);
  }

  /** The picker's show/hide toggle for one widget. */
  protected toggleHidden(item: LayoutItem): void {
    const d = this.draft();
    if (!d) return;
    this.draft.set(d.map((i) => (i.instanceId === item.instanceId ? { ...i, hidden: !i.hidden } : i)));
  }

  /** A widget's human label in the picker (its card/route title, else the def's). */
  protected labelFor(item: LayoutItem): string {
    const r = this.renderFor(item);
    if (!r) return item.instanceId;
    switch (r.kind) {
      case 'telemetry': return r.widget.title;
      case 'route': return routeLabel(r.route, r.route.routeId);
      default: return r.def.title;
    }
  }

  /** Save the draft — 'user' = the caller's personal layout (self-service);
   *  'site' = the shared site default (owners only, UI- and server-side). On
   *  error the draft is kept so no edit is lost. */
  protected async saveLayout(scope: 'user' | 'site'): Promise<void> {
    const d = this.draft();
    if (!d || this.saveBusy()) return;
    this.gen++; // a layout load started earlier must not overwrite what we save
    this.saveBusy.set(true);
    this.saveError.set(null);
    try {
      await this.layouts.save(this.siteId, d, scope);
      this.storedLayout.set(d);
      this.draft.set(null);
      this.editing.set(false);
      this.flash(scope === 'site' ? 'Saved as the site default layout.' : 'Layout saved.');
    } catch (e) {
      this.saveError.set(`Could not save — your edits are still here. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.saveBusy.set(false);
    }
  }

  /** Forget all saved layouts (the caller's, plus the site default for owners)
   *  and fall back to the auto-derived one. */
  protected async resetLayout(): Promise<void> {
    if (this.saveBusy()) return;
    this.gen++; // a layout load started earlier must not overwrite the reset
    this.saveBusy.set(true);
    this.saveError.set(null);
    try {
      await this.layouts.reset(this.siteId, this.isSiteOwner());
      // Re-resolve what remains (a site default may still apply for non-owners).
      const gen = this.gen;
      const fresh = await this.layouts.load(this.siteId);
      if (gen !== this.gen) return; // the site switched mid-reset
      this.storedLayout.set(fresh);
      this.draft.set(null);
      this.editing.set(false);
      this.flash('Reset to the automatic layout.');
    } catch (e) {
      this.saveError.set(`Could not reset — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.saveBusy.set(false);
    }
  }

  private flash(msg: string): void {
    this.saveMsg.set(msg);
    clearTimeout(this.saveMsgTimer);
    this.saveMsgTimer = setTimeout(() => this.saveMsg.set(null), 4000) as unknown as number;
  }

  /** Building/opening the site documentation. */
  protected docBusy = signal(false);

  /**
   * Assemble this site's documentation in the browser and open it in a new tab.
   * Uses the diagrams cached on the site (rendered admin-side), so no X6 here.
   */
  async openDocs(): Promise<void> {
    if (this.docBusy()) return;
    this.docBusy.set(true);
    this.note.set(null);
    try {
      const html = await this.backend.buildSiteDoc(this.siteId);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      this.note.set(String(e));
    } finally {
      this.docBusy.set(false);
    }
  }

  /** Stale-command window in minutes, for the offline warning copy. */
  private readonly ttlMin = Math.max(1, Math.round(COMMAND_TTL_S / 60));

  /** True when an admin is viewing a site they don't own (support/validation). */
  protected adminViewing = signal(false);
  /** Admin opted into control on a non-owned site (audited via issued_role). */
  protected controlEnabled = signal(false);
  /** Command bar is shown to owners always, and to admins only after Take control. */
  protected canControl = computed(() => !this.adminViewing() || this.controlEnabled());

  /** id → { name, colour } for every controller in the spec. */
  private ctrlMeta = computed(() => {
    const m = new Map<string, { name: string; color: string }>();
    this.store.spec().controllers.forEach((c, i) =>
      m.set(c.controller, { name: c.name, color: CONTROLLER_PALETTE[i % CONTROLLER_PALETTE.length] }),
    );
    return m;
  });

  /** Only label widgets by controller when the site actually has more than one. */
  protected showController = computed(() => this.store.spec().controllers.length > 1);
  protected ctrlName(id: string): string { return this.ctrlMeta().get(id)?.name ?? id; }
  protected ctrlColor(id: string): string { return this.ctrlMeta().get(id)?.color ?? '#94a3b8'; }

  // --- Device presence (the compact status bar) ----------------------------
  protected onlineCount = computed(() =>
    this.store.spec().controllers.filter((c) => this.store.presence(c.controller).online).length,
  );
  protected totalControllers = computed(() => this.store.spec().controllers.length);

  // --- Operator workspace ---------------------------------------------------
  /** Route view models for the fixed left-hand control dock. Keeping the live
   *  derivation here means the workspace remains presentational and every command
   *  still passes through this page's established lifecycle methods. */
  protected operatorRoutes = computed<OperatorRouteView[]>(() =>
    this.store.spec().controllers.flatMap((controller) =>
      controller.routes.map((route) => {
        const phase = this.routePhase(controller.controller, route.routeId);
        const automationKey = this.automatableRouteMap().get(`${controller.controller}/${route.routeId}`)?.routeKey ?? '';
        return {
          controller: controller.controller,
          controllerName: controller.name,
          route,
          automationKey,
          automationCount: automationKey ? this.automationCounts().get(automationKey) ?? 0 : 0,
          state: this.routeState(controller.controller, route.routeId),
          flowRate: this.routeFlow(controller.controller, route),
          progress: this.routeProgress(controller.controller, route),
          online: this.store.presence(controller.controller).online,
          phase: phase?.phase ?? null,
          phaseReason: phase?.reason ?? '',
        };
      }),
    ));

  /** Directly controllable valves/pumps. Node id is the shared selection anchor
   *  used by the topology, telemetry projection and firmware claim registry. */
  protected operatorEntities = computed<OperatorEntityView[]>(() =>
    this.store.spec().controllers.flatMap((controller) => {
      const online = this.store.presence(controller.controller).online;
      return controller.actuators.map((actuator) => {
        const runtime = this.store.nodeRuntime().get(actuator.id);
        const phase = this.lifecycle.phaseFor(this.nodeKey(controller.controller, actuator.id));
        return {
          id: actuator.id,
          controller: controller.controller,
          controllerName: controller.name,
          name: actuator.name,
          kind: actuator.kind,
          state: runtime?.state ?? 'unknown',
          value: runtime?.value ?? null,
          unit: runtime?.unit ?? null,
          online,
          held: this.lifecycle.isHeld(this.nodeKey(controller.controller, actuator.id)),
          // A direct claim is additive, not an override. Mark an actuator already
          // owned by a live route so the manual surface never implies it can stop it.
          routeControlled: controller.routes.some((route) =>
            ['PREPARING', 'RUNNING', 'STOPPING'].includes(this.routeState(controller.controller, route.routeId).token)
            && (route.pathNodeIds ?? []).includes(actuator.id)),
          phase: phase?.phase ?? null,
          phaseReason: phase?.reason ?? '',
        };
      });
    }));

  private stopAllKey(controller: string): string { return `${controller}/routes/stop-all`; }
  private stopAllPending = signal(false);
  protected stopAllBusy = computed(() =>
    this.stopAllPending() || this.store.spec().controllers.some((c) => this.lifecycle.isBusy(this.stopAllKey(c.controller))));

  protected onOperatorRouteAction(event: OperatorRouteAction): void {
    void this.routeCmd(event.controller, event.action, event.route);
  }
  protected onOperatorRouteRun(event: OperatorRouteRun): void {
    void this.routeRun(event.controller, event.stopSpec, event.route);
  }
  protected onOperatorEntityToggle(entity: OperatorEntityView): void {
    if (!this.canControl()) return;
    const actuator = this.store.spec().controllers
      .find((c) => c.controller === entity.controller)?.actuators
      .find((a) => a.id === entity.id);
    if (!actuator) return;
    void this.lifecycle.toggleClaim(this.nodeKey(entity.controller, entity.id), entity.controller, actuator);
    this.offlineNote(entity.controller);
  }
  protected async stopAllRoutes(): Promise<void> {
    if (!this.canControl() || this.stopAllBusy()) return;
    const controllers = this.store.spec().controllers;
    this.stopAllPending.set(true);
    try {
      // Firmware `stop_all` stops route slots only. Pair it with an explicit
      // release for every local actuator so this workspace action is truthful:
      // routes stop and browser-held/manual claims cannot keep outputs energized.
      const results = await Promise.all(controllers.map(async (controller) => {
        const stop = this.lifecycle.dispatch(this.stopAllKey(controller.controller), controller.controller, 'stop_all');
        const releases = controller.actuators.map((actuator) =>
          this.lifecycle.dispatch(this.nodeKey(controller.controller, actuator.id), controller.controller, 'node_set', { actuator, on: false }));
        const accepted = await Promise.all([stop, ...releases]);
        return accepted.every(Boolean);
      }));
      const accepted = results.filter(Boolean).length;
      this.note.set(accepted === controllers.length
        ? `Stop All accepted by ${accepted} ${accepted === 1 ? 'controller' : 'controllers'}; routes and manual controls are releasing.`
        : accepted === 0
          ? 'Stop All failed on every controller. No stop command was accepted.'
          : `Stop All partially completed: ${accepted} of ${controllers.length} controllers accepted every stop and release command.`);
    } finally {
      this.stopAllPending.set(false);
    }
  }

  // --- Routes (the live control surface) ------------------------------------
  /** A route's live state for its card (token + reason + origin; empty when never seen). */
  protected routeState(controller: string, routeId: number): { token: string; reason: string; origin?: string; initiator?: { label: string; support: boolean; title: string } } {
    const s = this.store.routeState(controller, routeId);
    return { token: s?.token ?? '', reason: s?.reason ?? '', origin: s?.origin, initiator: s?.initiator };
  }

  /** Live flow rate (L/min) for a route's primary flow sensor, null when none/unknown. */
  protected routeFlow(controller: string, r: RouteControl): number | null {
    if (!r.flowSensor) return null;
    return this.store.row(controller, r.flowSensor)?.reported ?? null;
  }

  /** Dest level captured when a level-targeted run is first seen, so the level bar is
   *  run-relative (0% at start) rather than the tank's absolute fill. Cleared on stop. */
  private runStartLevel = new Map<string, number>();

  /** Live progress for the card-as-progress-bar: the route's `live` facts (delivered /
   *  elapsed / targets) against the dest tank's live level. null until the device
   *  reports live data (then the card shows the flow rate instead). */
  protected routeProgress(controller: string, r: RouteControl): RunProgress | null {
    const key = this.routeKey(controller, r.routeId);
    const live = this.store.routeLive(controller, r.routeId);
    if (!live) { this.runStartLevel.delete(key); return null; }
    const destLevel = r.destLevelSensor ? this.store.row(controller, r.destLevelSensor)?.reported ?? null : null;
    if (live.tl > 0 && destLevel != null && !this.runStartLevel.has(key)) this.runStartLevel.set(key, destLevel);
    return runProgress(live, destLevel, !!r.canStopOnFull, this.runStartLevel.get(key) ?? null);
  }

  private routeKey(controller: string, routeId: number): string {
    return `${controller}/route/${routeId}`;
  }

  /** The route's live command phase (pending/refused/…) for the card overlay, or
   *  null when no command is in flight (the card's state view drives). */
  protected routePhase(controller: string, routeId: number): { phase: CommandPhase; reason: string } | null {
    return this.lifecycle.phaseFor(this.routeKey(controller, routeId));
  }

  // --- Inline actuator control --------------------------------------------
  // A valve/pump widget reads the same sensor its actuator reports on, so the
  // status card *is* the control: click to hold open / run (claim) or release.
  /** `${controller}/${reportedSensor}` → the actuator it drives. */
  private actuatorMap = computed(() => {
    const m = new Map<string, ActuatorControl>();
    for (const c of this.store.spec().controllers)
      for (const a of c.actuators) m.set(`${c.controller}/${a.reportedSensor}`, a);
    return m;
  });
  protected actuatorFor(w: DashboardWidget): ActuatorControl | undefined {
    return w.sensor ? this.actuatorMap().get(`${w.controller}/${w.sensor}`) : undefined;
  }
  /** Canonical node state for an actuator card, from the shared projection — so
   *  the card and the live map agree on on/off. Null for non-node widgets. */
  protected cardState(w: DashboardWidget): RuntimeState | null {
    const a = this.actuatorFor(w);
    return a ? this.store.nodeRuntime().get(a.id)?.state ?? null : null;
  }
  /** Toggleable now: an actuator exists, control is held, and the device is online. */
  protected isActuatable(w: DashboardWidget): boolean {
    return this.canControl() && !!this.actuatorFor(w) && this.store.presence(w.controller).online;
  }
  private nodeKey(controller: string, nodeId: string): string {
    return `${controller}/node/${nodeId}`;
  }
  protected actuatorHeld(w: DashboardWidget): boolean {
    const a = this.actuatorFor(w);
    return a ? this.lifecycle.isHeld(this.nodeKey(w.controller, a.id)) : false;
  }
  /** The actuator's live command phase for the card overlay, null when idle. */
  protected actuatorPhase(w: DashboardWidget): { phase: CommandPhase; reason: string } | null {
    const a = this.actuatorFor(w);
    return a ? this.lifecycle.phaseFor(this.nodeKey(w.controller, a.id)) : null;
  }
  protected toggleWidgetActuator(w: DashboardWidget): void {
    const a = this.actuatorFor(w);
    if (a && this.canControl()) void this.lifecycle.toggleClaim(this.nodeKey(w.controller, a.id), w.controller, a);
  }
  /** Valve/pump control cards render dense (the glyph grid look); charts full. */
  protected denseWidget(w: DashboardWidget): boolean {
    return w.kind === 'valve' || !!this.actuatorFor(w);
  }

  /**
   * Boot generation: a monotonically increasing counter bumped on every site
   * switch AND on every layout save/reset. Every async resolution (the layout
   * load, the site load) applies its result only when the generation it
   * started under is still current — a late resolution can never overwrite a
   * newer save or land on the wrong site.
   */
  private gen = 0;

  /** siteLoad failure — rendered where the store's own error shows. */
  protected loadError = signal<string | null>(null);

  private paramSub: { unsubscribe(): void } | null = null;

  private automations = inject(AutomationsService);

  constructor() {
    // Route REUSE: navigating /site/A/dashboard → /site/B/dashboard keeps this
    // component alive, so the site id comes from the param observable, and
    // every change re-boots the whole page — stores included — for the new site.
    this.paramSub = this.route.paramMap.subscribe((params) => this.boot(params.get('name') ?? ''));
  }

  ngOnDestroy(): void {
    this.paramSub?.unsubscribe();
    if (this.automationUnsub) void this.automationUnsub();
    clearTimeout(this.saveMsgTimer);
  }

  /**
   * (Re)boot the dashboard for a site: tear down the previous site's state —
   * the component-provided stores (their ngOnDestroy does NOT fire on route
   * reuse), any unsaved layout draft, every per-site signal — then run the
   * load sequence for the new site. Runs on construction and on every
   * /site/:name change.
   */
  private boot(siteId: string): void {
    this.gen++; // invalidate every in-flight async resolution from the old site
    this.store.reset();
    this.telemetry.reset();
    this.lifecycle.switchSite(siteId);
    this.siteId = siteId;
    this.siteName.set('');
    this.note.set(null);
    this.topology.set(null);
    this.automationRows.set([]);
    if (this.automationUnsub) void this.automationUnsub();
    this.automationUnsub = null;
    this.loadError.set(null);
    this.adminViewing.set(false);
    this.controlEnabled.set(false);
    this.siteOwners.set([]);
    this.runStartLevel.clear();
    this.cancelEdit(); // drop any unsaved layout draft (and its save error)
    this.saveMsg.set(null);
    clearTimeout(this.saveMsgTimer);
    this.storedLayout.set(null);
    if (!siteId) return;
    this.capState = this.capabilitiesService.capabilities(siteId);
    // Cache first for instant paint, then the PB row replaces it (or clears
    // it — a layout deleted elsewhere must not resurrect from the cache).
    this.storedLayout.set(this.layouts.cached(siteId));
    const gen = this.gen;
    void this.layouts.load(siteId).then((l) => {
      if (gen === this.gen) this.storedLayout.set(l);
    });
    void this.load(gen);
  }

  private async load(gen: number): Promise<void> {
    try {
      const { site, topology } = await this.backend.siteLoad(this.siteId);
      if (gen !== this.gen) return; // a newer boot superseded this load
      this.siteName.set(site.friendlyName);
      // Admin/partner looking at a site they're not a co-owner of → start read-only.
      const me = this.auth.user()?.id;
      this.adminViewing.set(this.auth.isManager() && !(!!me && (site.owners?.includes(me) ?? false)));
      this.siteOwners.set(site.owners ?? []);
      const topo = topology ? parseTopology(topology) : createEmptySiteTopology();
      this.topology.set(topo);
      void this.loadAutomationRows(gen);
      const spec = buildDashboardSpec(topo);
      await this.store.init(this.siteId, spec, { update_interval: topo.timing.update_interval }, site.owners ?? [], site.people ?? []);
      if (gen !== this.gen) return;
      // Backfill history for the charted widgets (line + flow rate). Each uses its
      // own remembered span (telemetry.load defaults to the widget's stored span).
      // Device mode has no history endpoint — nothing to backfill.
      if (!this.deviceMode) {
        for (const w of spec.widgets) {
          if (w.kind === 'line' || w.kind === 'flow') void this.telemetry.load(this.siteId, w);
        }
      }
    } catch (e) {
      if (gen !== this.gen) return; // the newer boot owns the error surface now
      // Without this the spinner would stay up forever: store.init (which owns
      // the loading flag) either never ran or already cleared it on its own
      // failure path — clearing again is harmless.
      this.store.loading.set(false);
      this.loadError.set(e instanceof Error ? e.message : String(e));
    }
  }

  private async loadAutomationRows(gen: number): Promise<void> {
    try {
      const rows = await this.automations.list(this.siteId);
      if (gen !== this.gen) return;
      this.automationRows.set(rows);
      const unsub = await this.automations.subscribe(this.siteId, () => void this.refreshAutomationRows(gen));
      if (gen !== this.gen) { void unsub(); return; }
      this.automationUnsub = unsub;
    } catch {
      // Automation metadata must never block the live operator surface. The route
      // button remains available with a zero count and the manager owns its errors.
      if (gen === this.gen) this.automationRows.set([]);
    }
  }

  private async refreshAutomationRows(gen: number): Promise<void> {
    try {
      const rows = await this.automations.list(this.siteId);
      if (gen === this.gen) this.automationRows.set(rows);
    } catch { /* transient; retain the last truthful count */ }
  }

  protected onAutomationsChanged(): void { void this.refreshAutomationRows(this.gen); }

  /** Operator picked a new timescale for a chart — reload it at that span. */
  protected onSpanChange(w: DashboardWidget, hours: number): void {
    if (this.siteId) void this.telemetry.setSpan(this.siteId, w, hours);
  }

  /** Tank history panel opened for the first time — backfill its series (lazy, so
   *  we don't fetch history for every tank up front the way flow/line do). */
  protected onExpand(w: DashboardWidget): void {
    if (this.siteId) void this.telemetry.load(this.siteId, w);
  }

  // --- Command dispatch — every control routes through the lifecycle store, which
  //     tracks the command by command_id and exposes the phase the cards render. --

  /** Warn (only) when the target reads offline — the per-control phase is the
   *  primary feedback; this keeps the "expires in ~Nm" copy for a dark device. */
  private offlineNote(controller: string): void {
    this.note.set(
      this.store.presence(controller).online
        ? null
        : `${this.ctrlName(controller)} looks offline — the command expires in ~${this.ttlMin} min if it doesn't reconnect.`,
    );
  }

  /** Start/stop/fault-reset a route (the route-card emits one of these). */
  protected async routeCmd(controller: string, action: CommandAction, route: RouteControl): Promise<void> {
    if (!this.canControl()) return;
    // A non-runnable route (no valve, no pump) can't be started — only monitored.
    if (action === 'route_start' && route.caps && !route.caps.runnable) return;
    await this.lifecycle.dispatch(this.routeKey(controller, route.routeId), controller, action, { route });
    this.offlineNote(controller);
  }

  /** A targeted manual run: a route_start carrying the picker's StopSpec (volume /
   *  level / time). Same lifecycle as a plain start, just with the target attached. */
  protected async routeRun(controller: string, stopSpec: StopSpecOverride, route: RouteControl): Promise<void> {
    if (!this.canControl()) return;
    if (route.caps && !route.caps.runnable) return; // no actuator: not runnable
    await this.lifecycle.dispatch(this.routeKey(controller, route.routeId), controller, 'route_start', { route, stopSpec });
    this.offlineNote(controller);
  }
}
