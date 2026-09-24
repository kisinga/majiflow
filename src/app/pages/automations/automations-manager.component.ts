import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { UnsubscribeFunc } from 'pocketbase';
import {
  parseTopology, listAutomatableRoutes, buildDashboardSpec, MAX_AUTOMATIONS,
  RUN_TARGET_FIELDS, OVERRIDE_BITS, runTargetMax,
  type SiteTopology, type AutomatableRoute, type NewAutomationRow, type RunTargetField,
} from '@core';
import { BackendService } from '../../core/services/backend.service';
import { AuthStore } from '../../core/services/auth.store';
import { ConfirmService } from '../../core/services/confirm.service';
import { DEVICE_MODE } from '../../core/tokens/device-mode';
import { DashboardStore } from '../dashboard/dashboard.store';
import { CommandLifecycleStore } from '../dashboard/command-lifecycle.store';
import { TunableNumbersComponent } from '../dashboard/widgets/tunable-numbers.component';
import { AutomationsService, type AutomationRecord } from './automations.service';

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// The overridable run targets + their mask bits are owned by RUN_TARGET_FIELDS /
// OVERRIDE_BITS in @core (shared with the dashboard run picker and pinned to the
// firmware enum), so the editor never re-hardcodes the bit literals.

/** Default timezone offset for the launch market (EAT = UTC+3). */
const DEFAULT_TZ_OFFSET_MIN = 180;
const DAY_MASK_ALL = 0x7F;

/** Convert local wall-clock minutes to UTC minutes for storage. */
function localToUtcMin(localMin: number, offsetMin: number): number {
  return (((localMin - offsetMin) % 1440) + 1440) % 1440;
}

/** Convert UTC minutes to local wall-clock minutes for display. */
function utcToLocalMin(utcMin: number, offsetMin: number): number {
  return (((utcMin + offsetMin) % 1440) + 1440) % 1440;
}

/** Rotate the 7-bit weekday mask by `shift` days (+1 = forward: MON→TUE→…→SUN→MON). */
function rotateDayMask(mask: number, shift: number): number {
  const m = mask & DAY_MASK_ALL;
  return (((m << shift) | (m >>> (7 - shift))) & DAY_MASK_ALL);
}

/** Convert a stored UTC day mask to local days for display/editing. */
function utcToLocalDayMask(utcMask: number, utcMin: number, offsetMin: number): number {
  return ((utcMin + offsetMin) % 1440) < utcMin ? rotateDayMask(utcMask, 1) : utcMask;
}

/** Convert a local day mask to UTC days for storage. */
function localToUtcDayMask(localMask: number, localMin: number, offsetMin: number): number {
  return (localMin - offsetMin) < 0 ? rotateDayMask(localMask, -1) : localMask;
}

/** Derive the current offset (minutes) for an IANA zone; null if unsupported. */
function getIanaOffsetMinutes(zone: string): number | null {
  try {
    const utc = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
    const local = new Date(new Date().toLocaleString('en-US', { timeZone: zone }));
    return (local.getTime() - utc.getTime()) / 60000;
  } catch { return null; }
}

/** A blank draft for a new automation (route stamped on save). */
function blankDraft(): NewAutomationRow & { id?: string } {
  return {
    site: '', controller: '', name: '', route_key: '', route_index: 0, route_set_version: 0,
    trigger_type: 'time', time_min: 3 * 60, days_mask: 0, level_threshold_pct: 50,
    override_mask: 0, ov_source_min_pct: 0, ov_dest_max_pct: 0,
    ov_max_runtime_min: 30, ov_target_duration_s: 1800, ov_target_volume_l: 500, enabled: true,
  };
}

/**
 * AutomationsManagerComponent - the reusable automation manager: lists, creates,
 * edits and deletes automations as first-class rows in the `automations` collection
 * (server republishes the retained set to the device on every change). Route
 * selection stamps the owning controller + route_index + route_set_version; each
 * automation can override the route's run-params (volume, duration, max-runtime,
 * level setpoints) via a sparse overlay. Operational, gated by ownership.
 *
 * Self-contained: give it a {@link siteId} and it loads the topology (for routes
 * and route-default tunables) and the automation rows itself. Hosted both by the
 * standalone `/site/:name/automations` page. Provides its own DashboardStore so
 * cloud and on-device builds use the same editor and persistence seam.
 */
@Component({
  selector: 'app-automations-manager',
  standalone: true,
  imports: [RouterLink, TunableNumbersComponent],
  providers: [DashboardStore, CommandLifecycleStore],
  host: { class: 'block' },
  styles: [`
    :host{display:block;container-type:inline-size}.automation-editor-grid{padding:16px;display:grid;grid-template-columns:minmax(0,1fr);column-gap:24px;row-gap:20px}.automation-editor-footer{padding-top:12px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}
    @container(min-width:700px){.automation-editor-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.automation-editor-footer{grid-column:1/-1}}
    @container(max-width:520px){.automation-row{align-items:flex-start;flex-wrap:wrap}.automation-row-actions{width:calc(100% - 2.75rem);margin-left:2.75rem;justify-content:flex-end}.automation-route-focus{flex-wrap:wrap}.automation-route-focus .all-routes{margin-left:3.25rem}}
  `],
  template: `
    <div class="flex flex-col gap-4">
      @if (error()) { <div role="alert" class="alert alert-error text-sm py-2">{{ error() }}</div> }

      <!-- Top actions: count vs cap + New. -->
      @if (canEdit()) {
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-base-content/40">
            @if(focusRoute()){ {{visibleRows().length}} on this route · {{rows().length}}/{{maxAutomations}} total }
            @else { {{rows().length}}/{{maxAutomations}} automations }
          </span>
          <button class="btn btn-sm btn-primary gap-1 shrink-0" (click)="startNew()"
                  [disabled]="!routes().length || atCap() || !!draft()"
                  [title]="atCap() ? 'Limit reached (' + maxAutomations + ')' : ''">
            <span class="text-base leading-none -mt-px">+</span> New
          </button>
        </div>
      }

      @if (showRouteFocus()) {
        @if (focusRoute(); as route) {
          <section class="automation-route-focus rounded-2xl ring-1 ring-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3" aria-label="Selected route">
            <span class="w-10 h-10 rounded-xl bg-primary/10 text-primary grid place-items-center shrink-0">
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/></svg>
            </span>
            <div class="min-w-0 flex-1">
              <span class="block text-[10px] uppercase tracking-wider font-bold text-primary/70">Route automations</span>
              <strong class="block text-sm truncate mt-0.5">{{route.routeName}}</strong>
            </div>
            <span class="badge badge-primary badge-outline shrink-0">{{visibleRows().length}}</span>
            <a [routerLink]="[]" [queryParams]="{}" class="all-routes btn btn-ghost btn-sm shrink-0">All routes</a>
          </section>
        }
      }

      <!-- Route defaults: the per-route values an automation inherits unless it
           overrides them. Collapsed by default; the canonical editor also lives in
           Site settings → Routes. -->
      @if (showRouteDefaults() && hasRouteTuning()) {
        <details class="group rounded-2xl ring-1 ring-base-300/40 bg-base-100 overflow-hidden">
          <summary class="cursor-pointer list-none flex items-center justify-between gap-3 px-4 h-12 hover:bg-base-200/30 transition-colors">
            <span class="flex items-baseline gap-2 min-w-0">
              <span class="text-sm font-semibold">Route defaults</span>
              <span class="text-xs text-base-content/40 truncate hidden sm:inline">per-route runtime, volume, duration &amp; levels</span>
            </span>
            <svg class="w-4 h-4 text-base-content/40 shrink-0 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </summary>
          <div class="px-4 pb-4 pt-3 border-t border-base-300/40">
            <app-tunable-numbers [controllers]="dash.spec().controllers" [canEdit]="canEdit()" scope="route" />
          </div>
        </details>
      }

      <!-- Editor -->
      @if (draft(); as d) {
        <section class="rounded-2xl ring-1 ring-primary/40 bg-base-100 shadow-lg overflow-hidden">
          <div class="flex items-center justify-between px-4 h-11 border-b border-base-300/40">
            <h2 class="text-sm font-semibold">{{ d.id ? 'Edit automation' : 'New automation' }}</h2>
            <button class="btn btn-ghost btn-xs btn-circle" (click)="cancel()" title="Cancel" aria-label="Cancel">✕</button>
          </div>

          <div class="automation-editor-grid">
            <!-- Left: identity + trigger -->
            <div class="flex flex-col gap-4">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] font-medium text-base-content/50">Name</span>
                <input class="input input-sm input-bordered" [value]="d.name" (input)="set('name', $any($event.target).value)" placeholder="Morning fill" />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] font-medium text-base-content/50">Route</span>
                <select class="select select-sm select-bordered" [class.select-primary]="!!focusRoute()" [disabled]="!!focusRoute()" [value]="d.route_key" (change)="onRoute($any($event.target).value)">
                  <option value="" disabled>Select a route…</option>
                  @if (multiController()) {
                    @for (g of routeGroups(); track g.controller) {
                      <optgroup [label]="g.controller">
                        @for (r of g.routes; track r.routeKey) { <option [value]="r.routeKey">{{ r.routeName }}</option> }
                      </optgroup>
                    }
                  } @else {
                    @for (r of routes(); track r.routeKey) { <option [value]="r.routeKey">{{ r.routeName }}</option> }
                  }
                </select>
              </label>

              <div class="flex flex-col gap-2">
                <span class="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">When</span>
                <div class="inline-flex w-fit rounded-lg bg-base-200 p-0.5">
                  <button class="btn btn-xs btn-ghost rounded-md normal-case" [class.bg-base-100]="d.trigger_type === 'time'" [class.shadow-sm]="d.trigger_type === 'time'" (click)="set('trigger_type', 'time')">Time of day</button>
                  <button class="btn btn-xs btn-ghost rounded-md normal-case" [class.bg-base-100]="d.trigger_type === 'level'" [class.shadow-sm]="d.trigger_type === 'level'" [disabled]="!selectedRoute()?.hasLevelSource" (click)="set('trigger_type', 'level')">Tank level</button>
                </div>
                @if (d.trigger_type === 'time') {
                  <div class="flex items-center gap-2 flex-wrap pt-0.5">
                    <input type="time" class="input input-sm input-bordered w-32" [value]="hhmm(d.time_min)" (input)="setTime($any($event.target).value)" />
                    <div class="flex flex-wrap gap-1">
                      @for (day of dayLabels; track day; let i = $index) {
                        <button class="btn btn-xs btn-circle w-8 h-8 min-h-0 font-normal" [class.btn-primary]="dayOn(i)" [class.btn-ghost]="!dayOn(i)" (click)="toggleDay(i)" [title]="day">{{ day.charAt(0) }}</button>
                      }
                    </div>
                    @if (d.days_mask === 0) { <span class="text-[11px] text-base-content/40">every day</span> }
                    <span class="text-[11px] text-base-content/40">({{ tzLabel() }})</span>
                  </div>
                } @else {
                  <div class="flex items-center gap-2 text-sm pt-0.5">
                    <span class="text-base-content/60">When source rises above</span>
                    <input type="number" min="0" max="100" class="input input-sm input-bordered w-20 text-right" [value]="d.level_threshold_pct" (input)="set('level_threshold_pct', num($event))" />
                    <span class="text-base-content/40">%</span>
                  </div>
                }
              </div>
            </div>

            <!-- Right: run settings -->
            <div class="flex flex-col gap-2">
              <span class="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">Run settings</span>
              <p class="text-[11px] text-base-content/40 -mt-1">A field left off uses this route's default from Site settings → Routes.</p>
              <div class="rounded-xl ring-1 ring-base-300/40 px-3 divide-y divide-base-300/40">
                @for (f of overrideFields(); track f.key) {
                  <div class="flex items-center gap-3 py-2">
                    <label class="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer select-none">
                      <input type="checkbox" class="toggle toggle-xs" [checked]="ovOn(d.override_mask, f.bit)" (change)="toggleOverride(f.bit)" />
                      <span class="text-sm truncate">{{ f.label }}</span>
                    </label>
                    @if (ovOn(d.override_mask, f.bit)) {
                      <div class="flex items-center gap-1.5 shrink-0">
                        <input type="number" [min]="f.min" [max]="targetMax(f)" class="input input-sm input-bordered w-24 text-right" [value]="disp(f, d[f.key])" (input)="set(f.key, toWire(f, num($event)))" />
                        <span class="text-xs text-base-content/40 w-7">{{ f.unit }}</span>
                      </div>
                    } @else {
                      <span class="text-xs text-base-content/35 shrink-0 italic">route default</span>
                    }
                  </div>
                }
              </div>
            </div>

            <!-- Footer -->
            <div class="automation-editor-footer">
              @if (draftIssues().length) {
                <ul class="mb-3 text-[11px] text-error/90 list-disc pl-4 space-y-0.5">
                  @for (e of draftIssues(); track e) { <li>{{ e }}</li> }
                </ul>
              }
              <div class="flex items-center justify-between gap-2">
                <label class="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input type="checkbox" class="toggle toggle-sm toggle-success" [checked]="d.enabled" (change)="set('enabled', $any($event.target).checked)" />
                  <span class="text-base-content/70">{{ d.enabled ? 'Enabled' : 'Paused' }}</span>
                </label>
                <div class="flex gap-2">
                  <button class="btn btn-ghost btn-sm" (click)="cancel()">Cancel</button>
                  <button class="btn btn-primary btn-sm min-w-20" (click)="save()" [disabled]="draftIssues().length > 0 || saving()">
                    @if (saving()) { <span class="loading loading-spinner loading-xs"></span> } Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      }

      <!-- List -->
      @if (loading()) {
        <div class="flex justify-center py-10"><span class="loading loading-spinner text-base-content/30"></span></div>
      } @else if (!routes().length) {
        <div class="rounded-2xl ring-1 ring-base-300/40 bg-base-100 px-4 py-10 text-center">
          <p class="text-sm text-base-content/50">No routes to automate yet.</p>
          <p class="text-xs text-base-content/40 mt-1">Add routes in the site design first.</p>
        </div>
      } @else {
        <ul class="flex flex-col gap-2">
          @for (a of visibleRows(); track a.id) {
            <li class="automation-row rounded-2xl ring-1 ring-base-300/40 bg-base-100 px-4 py-3 flex items-center gap-3 transition-opacity"
                [class.opacity-55]="!a.enabled">
              <span class="w-2 h-2 rounded-full shrink-0" [class]="a.enabled ? 'bg-success' : 'bg-base-content/25'"></span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-sm truncate">{{ a.name || 'Untitled automation' }}</span>
                  @if (!a.enabled) { <span class="badge badge-ghost badge-sm shrink-0">Paused</span> }
                  @if (staleness(a); as s) {
                    @if (s === 'stale') {
                      <span class="badge badge-warning badge-sm shrink-0"
                            title="The site design changed since this device was flashed. Regenerate this controller's firmware and reflash it — that re-applies the automation to the new route layout.">Needs reflash</span>
                    } @else if (s === 'missing') {
                      <span class="badge badge-error badge-sm shrink-0"
                            title="This automation's route no longer exists in the site design, so it's been paused. Edit it to pick a current route, or delete it.">Route removed</span>
                    }
                  }
                </div>
                <p class="text-xs text-base-content/50 truncate mt-0.5">{{ routeName(a.route_key) }} · {{ triggerSummary(a) }}{{ overrideSummary(a) }}</p>
              </div>
              @if (canEdit()) {
                <div class="automation-row-actions flex items-center gap-1 shrink-0">
                  <input type="checkbox" class="toggle toggle-sm toggle-success" [checked]="a.enabled" (change)="toggleEnabled(a)" [title]="a.enabled ? 'Pause' : 'Resume'" />
                  <button class="btn btn-ghost btn-sm" (click)="startEdit(a)">Edit</button>
                  <button class="btn btn-ghost btn-sm text-error/70 hover:text-error hover:bg-error/10" (click)="remove(a)">Delete</button>
                </div>
              }
            </li>
          } @empty {
            <li class="rounded-2xl ring-1 ring-base-300/40 border-dashed bg-base-100/60 px-4 py-10 text-center list-none">
              <p class="text-sm text-base-content/50">{{focusRoute()?'No automations for this route yet.':'No automations yet.'}}</p>
              @if (canEdit()) { <p class="text-xs text-base-content/40 mt-1">Create one to run {{focusRoute()?'this route':'a route'}} by time or tank level.</p> }
            </li>
          }
        </ul>
      }
    </div>
  `,
})
export class AutomationsManagerComponent {
  /** Site whose automations this manages. Drives the one-time load. */
  readonly siteId = input.required<string>();
  /** Show inherited route defaults as an optional disclosure. */
  readonly showRouteDefaults = input(true);
  /** Optional route context from an operator route card. It filters the list and
   *  preselects/locks that route for new rows, while the global page still shows all. */
  readonly focusRouteKey = input('');
  /** The full-page host shows its route context card. A modal supplies that
   *  context in its own title bar and hides the duplicate surface. */
  readonly showRouteFocus = input(true);
  readonly changed = output<void>();

  private backend = inject(BackendService);
  private auth = inject(AuthStore);
  private svc = inject(AutomationsService);
  private confirm = inject(ConfirmService);
  protected dash = inject(DashboardStore);
  /** Device-mode build: no PocketBase session exists, so the ownership gate
   *  below can never open — the device's own UI is trusted to edit its set. */
  private deviceMode = inject(DEVICE_MODE);

  protected rows = signal<AutomationRecord[]>([]);
  protected routes = signal<AutomatableRoute[]>([]);
  protected draft = signal<(NewAutomationRow & { id?: string }) | null>(null);
  protected loading = signal(true);
  protected saving = signal(false);
  protected error = signal('');
  protected readonly dayLabels = DAY_LABELS;
  protected readonly maxAutomations = MAX_AUTOMATIONS;

  private topology: SiteTopology | null = null;
  /** Signal (not a plain field) so `canEdit` recomputes once `load()` resolves
   *  ownership. As a plain field it stayed stale in the modal, where auth is
   *  already settled and nothing else forced the computed to re-run. */
  private isOwner = signal(false);
  private started = false;
  private unsub?: UnsubscribeFunc;
  /** Site timezone offset in minutes (for display conversion). Defaults to EAT. */
  protected tzOffsetMin = signal(DEFAULT_TZ_OFFSET_MIN);
  /** Human-readable timezone label for the UI. */
  protected tzLabel = computed(() => {
    const offset = this.tzOffsetMin();
    if (offset === 180) return 'EAT';
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    return `UTC${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
  });

  protected canEdit = computed(() => this.deviceMode || this.isOwner() || this.auth.isManager());
  protected atCap = computed(() => this.rows().length >= MAX_AUTOMATIONS);
  protected focusRoute = computed(() => this.routes().find((route) => route.routeKey === this.focusRouteKey()));
  protected visibleRows = computed(() => {
    const key = this.focusRouteKey();
    return key ? this.rows().filter((row) => row.route_key === key) : this.rows();
  });
  /** Any per-route tunable exists (drives the "Route defaults" disclosure). */
  protected hasRouteTuning = computed(() => this.dash.spec().controllers.some((c) => c.tunables.some((t) => t.scope === 'route')));
  protected selectedRoute = computed(() => this.routes().find((r) => r.routeKey === this.draft()?.route_key));
  /** Which override targets this route offers, gated by the single capability owner
   *  so the editor agrees with the run picker and the firmware: volume only when
   *  attributable, "stop at level" only with a destination level sensor, source-min
   *  only with a source level sensor. Duration + max-runtime are always offered. */
  protected overrideFields = computed(() => {
    const caps = this.selectedRoute()?.caps;
    return RUN_TARGET_FIELDS.filter((f) => {
      if (f.key === 'ov_target_volume_l') return !!caps?.targets.volume.available;
      if (f.key === 'ov_dest_max_pct') return !!caps?.targets.level.available;
      if (f.key === 'ov_source_min_pct') return !!caps?.sourceHasLevel;
      return true;
    });
  });
  /** Display-unit max for a target field, capped at the selected route's tank capacity
   *  (the same runTargetMax the run picker uses, so the two surfaces never disagree). */
  protected targetMax(f: RunTargetField): number {
    return runTargetMax(f, { destCapacityL: this.selectedRoute()?.destCapacityL });
  }
  protected routeGroups = computed(() => {
    const groups = new Map<string, AutomatableRoute[]>();
    for (const r of this.routes()) {
      const arr = groups.get(r.controllerId) ?? [];
      arr.push(r);
      groups.set(r.controllerId, arr);
    }
    return [...groups.entries()].map(([controller, routes]) => ({ controller, routes }));
  });
  protected multiController = computed(() => this.routeGroups().length > 1);

  /** Pre-submit validation: what still blocks Save, in plain words. */
  protected draftIssues = computed<string[]>(() => {
    const d = this.draft();
    if (!d) return [];
    const issues: string[] = [];
    if (!d.route_key) issues.push('Pick a route.');
    if (d.trigger_type === 'level') {
      const t = d.level_threshold_pct;
      if (t == null || Number.isNaN(t) || t < 0 || t > 100) issues.push('Tank level must be between 0 and 100%.');
    }
    for (const f of this.overrideFields()) {
      if (!this.ovOn(d.override_mask, f.bit)) continue;
      const v = Number(d[f.key]) / (f.scale ?? 1);
      if (Number.isNaN(v) || v < f.min || v > f.max) issues.push(`${f.label} must be ${f.min}–${f.max} ${f.unit}.`);
    }
    return issues;
  });

  constructor() {
    // Load once the bound siteId is available (it's set once, so guard re-runs).
    effect(() => {
      const id = this.siteId();
      if (id && !this.started) { this.started = true; void this.load(id); }
    });
  }

  private async load(siteId: string): Promise<void> {
    try {
      const { site, topology } = await this.backend.siteLoad(siteId);
      const me = this.auth.user()?.id;
      this.isOwner.set(!!me && (site.owners?.includes(me) ?? false));
      // Use the site's display_timezone when present; default to EAT for the launch market.
      const tz = site.display_timezone || 'Africa/Nairobi';
      this.tzOffsetMin.set(getIanaOffsetMinutes(tz) ?? DEFAULT_TZ_OFFSET_MIN);
      if (topology) {
        this.topology = parseTopology(topology);
        this.routes.set(listAutomatableRoutes(this.topology));
        // Live per-route tunables (the "Route defaults" the automations override)
        // ride the same dashboard store + desired-config write path as on the dashboard.
        await this.dash.init(siteId, buildDashboardSpec(this.topology));
      }
      this.rows.set(await this.svc.list(siteId));
      this.unsub = await this.svc.subscribe(siteId, () => void this.refresh());
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Failed to load automations.');
    } finally {
      this.loading.set(false);
    }
  }

  private async refresh(): Promise<void> {
    try { this.rows.set(await this.svc.list(this.siteId())); } catch { /* transient */ }
  }

  ngOnDestroy(): void { this.unsub?.(); }

  // --- editor state ---
  protected startNew(): void {
    const d = blankDraft();
    d.site = this.siteId();
    const route = this.focusRoute();
    this.draft.set(route ? this.stampRoute(d, route) : d);
  }
  protected startEdit(a: AutomationRecord): void { this.draft.set({ ...a }); }
  protected cancel(): void { this.draft.set(null); }

  protected set<K extends keyof NewAutomationRow>(key: K, val: NewAutomationRow[K]): void {
    const d = this.draft(); if (!d) return; this.draft.set({ ...d, [key]: val });
  }
  protected num(e: Event): number { return Number((e.target as HTMLInputElement).value) || 0; }
  /** Wire value → display value (e.g. duration seconds → minutes). */
  protected disp(f: RunTargetField, wire: number): number { return f.scale ? Math.round(wire / f.scale) : wire; }
  /** Display value → wire value (the inverse), written back to the draft. */
  protected toWire(f: RunTargetField, display: number): number { return display * (f.scale ?? 1); }

  protected onRoute(key: string): void {
    const r = this.routes().find((x) => x.routeKey === key); const d = this.draft();
    if (!r || !d) return;
    this.draft.set(this.stampRoute(d, r));
  }

  private stampRoute(d: NewAutomationRow & { id?: string }, r: AutomatableRoute): NewAutomationRow & { id?: string } {
    const next = { ...d, route_key: r.routeKey, controller: r.controllerId, route_index: r.routeIndex, route_set_version: r.routeSetVersion };
    // A level trigger needs a level source; fall back to time if the new route lacks one.
    if (next.trigger_type === 'level' && !r.hasLevelSource) next.trigger_type = 'time';
    return next;
  }

  /** Display a stored UTC `time_min` as local HH:MM. */
  protected hhmm(utcMin: number): string {
    const localMin = utcToLocalMin(utcMin, this.tzOffsetMin());
    const h = Math.floor(localMin / 60), m = localMin % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  /** Convert a local HH:MM input to UTC minutes for storage. */
  protected setTime(v: string): void {
    const [h, m] = v.split(':').map((n) => parseInt(n, 10));
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      const localMin = h * 60 + m;
      this.set('time_min', localToUtcMin(localMin, this.tzOffsetMin()));
    }
  }
  /** Whether local day index `i` (0=MON) is enabled for the current draft. */
  protected dayOn(i: number): boolean {
    const d = this.draft(); if (!d) return false;
    const localMask = utcToLocalDayMask(d.days_mask, d.time_min, this.tzOffsetMin());
    return (localMask & (1 << i)) !== 0;
  }
  /** Toggle the local day index `i` on/off, storing the corresponding UTC bit. */
  protected toggleDay(i: number): void {
    const d = this.draft(); if (!d) return;
    const offset = this.tzOffsetMin();
    const localMask = utcToLocalDayMask(d.days_mask, d.time_min, offset);
    const newLocalMask = localMask ^ (1 << i);
    this.set('days_mask', localToUtcDayMask(newLocalMask, d.time_min, offset));
  }
  protected ovOn(mask: number, bit: number): boolean { return (mask & bit) !== 0; }
  protected toggleOverride(bit: number): void { const d = this.draft(); if (d) this.set('override_mask', d.override_mask ^ bit); }

  protected async save(): Promise<void> {
    const d = this.draft(); if (!d || !d.route_key) return;
    this.saving.set(true);
    try {
      const { id, ...row } = d;
      // Re-stamp the route identity from the live route table on every write. route_index
      // + route_set_version are otherwise set only when the route is (re)picked, so editing
      // an automation re-sends a version stamped against an older route table — which the
      // device refuses wholesale (apply_set's route_set_version gate), and nothing runs.
      // Re-deriving here heals the row to the current manifest. Stamp index + version
      // together (never the version alone) or a matching version could run the wrong route.
      const r = this.routes().find((x) => x.routeKey === row.route_key);
      if (r) { row.controller = r.controllerId; row.route_index = r.routeIndex; row.route_set_version = r.routeSetVersion; }
      if (id) await this.svc.update(id, row); else await this.svc.create(row);
      this.draft.set(null);
      await this.refresh();
      this.changed.emit();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async toggleEnabled(a: AutomationRecord): Promise<void> {
    // Re-stamp the route identity alongside the flag (see save()): a pause/resume is the
    // most common reason a long-lived automation re-publishes, so it's the cheapest place
    // to heal a stale route_set_version the device would otherwise refuse.
    const patch: Partial<NewAutomationRow> = { enabled: !a.enabled };
    const r = this.routes().find((x) => x.routeKey === a.route_key);
    if (r) { patch.route_index = r.routeIndex; patch.route_set_version = r.routeSetVersion; }
    try { await this.svc.update(a.id, patch); await this.refresh(); this.changed.emit(); }
    catch (e) { this.error.set(e instanceof Error ? e.message : 'Update failed.'); }
  }

  protected async remove(a: AutomationRecord): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete automation',
      message: `Delete automation "${a.name || 'unnamed'}"? This can't be undone.`,
      confirmLabel: 'Delete',
      variant: 'error',
    });
    if (!ok) return;
    try { await this.svc.remove(a.id); await this.refresh(); this.changed.emit(); }
    catch (e) { this.error.set(e instanceof Error ? e.message : 'Delete failed.'); }
  }

  // --- list display ---
  protected routeName(key: string): string { return this.routes().find((r) => r.routeKey === key)?.routeName ?? key; }
  /** Whether the row's stamped route table still matches the current site design. The
   *  device refuses any automation set whose route_set_version differs from the firmware's
   *  baked value, so a drift means "won't run until re-saved"; 'missing' means the route
   *  was removed from the design entirely. Compared against the dashboard's manifest — the
   *  version a re-save writes — so a device on older firmware than the design is a separate
   *  "re-flash" case the badge can't see, called out in the tooltip. */
  protected staleness(a: AutomationRecord): 'ok' | 'stale' | 'missing' {
    const r = this.routes().find((x) => x.routeKey === a.route_key);
    if (!r) return 'missing';
    return r.routeSetVersion === a.route_set_version ? 'ok' : 'stale';
  }
  protected triggerSummary(a: AutomationRecord): string {
    if (a.trigger_type === 'level') return `when source > ${a.level_threshold_pct}%`;
    const localMask = utcToLocalDayMask(a.days_mask, a.time_min, this.tzOffsetMin());
    const days = localMask === 0 ? 'daily' : DAY_LABELS.filter((_, i) => localMask & (1 << i)).join(' ');
    return `${this.hhmm(a.time_min)} ${days}`;
  }
  protected overrideSummary(a: AutomationRecord): string {
    const parts: string[] = [];
    if (a.override_mask & OVERRIDE_BITS.volume) parts.push(`${a.ov_target_volume_l}L`);
    if (a.override_mask & OVERRIDE_BITS.duration) parts.push(`${a.ov_target_duration_s}s`);
    if (a.override_mask & OVERRIDE_BITS.max_runtime) parts.push(`≤${a.ov_max_runtime_min}min`);
    return parts.length ? ` · ${parts.join(' ')}` : '';
  }
}
