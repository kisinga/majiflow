import { Component, computed, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { describeState, routeLabel, FAULT_MEANINGS, STOP_REASON_MEANINGS, RUN_TARGET_FIELDS, runTargetMax, runTargetChips, type RouteControl, type CommandPhase, type StopSpecOverride, type RunTargetField, type TargetAvailability } from '@core';
import { phaseUi } from './command-phase';
import { formatInitiator } from './initiator';
import type { RunProgress } from '../run-progress';

/** The command a route card emits when toggled — a subset of CommandAction. */
export type RouteAction = 'route_start' | 'route_stop' | 'fault_reset';

/** A route's `reason` token is a fault or stop-reason — combined for lookup. */
const ROUTE_REASONS = { ...FAULT_MEANINGS, ...STOP_REASON_MEANINGS };

/** The state-derived presentation of a route card: copy, colours, the central
 *  control's morph state, and which command a click sends. */
interface RouteView {
  label: string;
  /** True while the route is doing something (preparing/running/stopping). */
  running: boolean;
  /** Pulse the small state dot (transient states). */
  pulse: boolean;
  /** Central glyph — cross-fades between these on a state transition. */
  glyph: 'play' | 'stop' | 'reset';
  /** Spinner arc around the button (working: starting / stopping). */
  spin: boolean;
  /** Completed progress ring around the button (running / fault). */
  ringFull: boolean;
  /** Card ring colour. */
  ring: string;
  textCls: string;
  dotCls: string;
  /** Verb for the tooltip ("tap to stop"). */
  actionLabel: string;
  action: RouteAction;
}

/**
 * One route, drawn as a `source → destination` pipe. The card is a status/progress
 * surface with explicit controls at either edge: route actuation on the left and
 * route-scoped automation management on the right. The centre never sends a hardware
 * command; while idle it only discloses the optional one-off run-target editor.
 * Presentational — the page wires state, flow, and the computed progress.
 */
@Component({
  selector: 'app-route-card',
  standalone: true,
  imports: [NgTemplateOutlet],
  host: { class: 'block w-full min-w-0' },
  styles: [`
    :host { display: block; width: 100%; min-width: 0; }
    @keyframes rc-sweep { 0% { transform: translateX(-120%); } 100% { transform: translateX(420%); } }
    .rc-sweep { animation: rc-sweep 1.8s ease-in-out infinite; }
    .rc-card { transition: box-shadow var(--motion-selection, 170ms) var(--ease-standard, ease), border-color var(--motion-selection, 170ms) var(--ease-standard, ease); }
    .rc-card.is-automation-selected { background:linear-gradient(90deg,var(--op-blue-surface,#e0f0fb),#fff 44%);box-shadow:0 0 0 2px var(--op-blue,#196ca6),0 8px 22px color-mix(in srgb,var(--op-blue,#196ca6) 16%,transparent); }
    .rc-card.is-automation-selected .rc-automation{color:var(--op-blue,#196ca6);background:var(--op-blue-surface,#e0f0fb)}
    .rc-row { min-height: 64px; }
    .rc-action,.rc-automation,.rc-summary { position: relative; transition: color var(--motion-press, 130ms) var(--ease-standard, ease), background-color var(--motion-press, 130ms) var(--ease-standard, ease), transform var(--motion-press, 130ms) var(--ease-standard, ease); }
    .rc-action { width: 58px; min-width: 58px; display: grid; place-items: center; border-right: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
    .rc-action:hover:not(:disabled) { background: color-mix(in srgb, currentColor 7%, transparent); }
    .rc-action:active:not(:disabled),.rc-automation:active:not(:disabled) { transform: scale(.97); }
    .rc-action:focus-visible,.rc-automation:focus-visible,.rc-summary:focus-visible { z-index: 3; outline: 3px solid color-mix(in srgb,var(--op-blue,#196ca6) 30%,transparent); outline-offset: -3px; }
    .rc-action:disabled { cursor: not-allowed; }
    .rc-summary { min-width: 0; flex: 1; padding: 9px 10px; text-align: left; }
    button.rc-summary:hover { background: color-mix(in srgb,var(--op-blue,#196ca6) 4%,transparent); }
    .rc-automation { width: 54px; min-width: 54px; display: grid; place-items: center; align-content: center; gap: 1px; border-left: 1px solid var(--op-border,#d7ded8); color: var(--op-muted,#68756d); }
    .rc-automation:hover:not(:disabled),.rc-automation.has-automations { color: var(--op-blue,#196ca6); background: var(--op-blue-surface,#e0f0fb); }
    .rc-automation:disabled { color: color-mix(in srgb,var(--op-muted,#68756d) 45%,transparent); cursor: not-allowed; }
    .rc-automation svg { width: 18px; height: 18px; }
    .rc-count { min-width: 18px; height: 15px; padding: 0 4px; display: grid; place-items: center; border-radius: 999px; background: var(--op-panel-strong,#e8eee9); color: var(--op-muted,#68756d); font-size: 9px; line-height: 1; font-weight: 850; font-variant-numeric: tabular-nums; }
    .rc-automation.has-automations .rc-count { background: #fff; color: var(--op-blue,#196ca6); }
    .rc-target-cue { margin-left: auto; width: 18px; height: 18px; flex: none; display: grid; place-items: center; border-radius: 50%; color: var(--op-muted,#68756d); }
    .rc-glyph { transition-duration: var(--motion-selection, 170ms); transition-timing-function: var(--ease-standard, ease); }
    .rc-options { animation: op-page-enter var(--motion-mode, 200ms) var(--ease-enter, ease) both; }
    @media (prefers-reduced-motion: reduce) {
      .rc-sweep, .animate-spin, .animate-pulse { animation: none !important; }
      [class*="transition-"] { transition: none !important; }
    }
  `],
  template: `
    <!-- Explicit edge actions with a passive status/progress centre. The centre may
         disclose one-off run targets, but only the left button can actuate a route. -->
    <div class="rc-card relative isolate w-full bg-base-100 rounded-xl ring-1 overflow-hidden"
         [class]="cmd()?.alert ? 'ring-error/60' : view().ring"
         [class.is-automation-selected]="automationSelected()"
         [class.is-offline]="!online()">

      <!-- progress fill: the card IS the bar while running -->
      @if (view().running && progress(); as p) {
        @if (p.pct !== null) {
          <div class="absolute inset-y-0 left-0 z-0 pointer-events-none transition-[width] ease-linear motion-reduce:transition-none"
               role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="p.pct"
               [attr.aria-label]="p.primary + ' ' + p.goal"
               [class]="p.nearDone ? 'bg-success/15' : 'bg-primary/12'"
               [style.width.%]="p.pct" [style.transitionDuration]="fillMs() + 'ms'">
            <div class="absolute inset-y-0 right-0 w-0.5" [class]="p.nearDone ? 'bg-success/50' : 'bg-primary/40'"></div>
          </div>
        } @else {
          <!-- indeterminate (until full): a gentle sweep instead of a fixed fill -->
          <div class="absolute inset-0 z-0 overflow-hidden pointer-events-none motion-reduce:hidden"
               role="progressbar" [attr.aria-label]="p.primary + ' ' + p.goal">
            <div class="absolute inset-y-0 left-0 w-1/3 bg-primary/12 blur-[2px] rc-sweep"></div>
          </div>
        }
      }

      <div class="rc-row relative z-10 flex items-stretch">
        <!-- Only this control sends start/stop/reset. -->
        <button
          type="button"
          class="rc-action group {{ view().textCls }}"
          [disabled]="disabled()"
          [title]="actionTitle()"
          [attr.aria-label]="actionTitle()"
          (click)="action.emit(view().action)">

          <!-- control — compact morphing glyph (play↔stop↔reset) with the same rings -->
          <span class="relative shrink-0 grid place-items-center w-10 h-10 rounded-full bg-base-100 ring-1 ring-base-300/50
                       transition-all group-hover:scale-105 {{ view().textCls }}">
            <svg class="col-start-1 row-start-1 w-full h-full" [class.animate-spin]="view().spin || cmd()?.spin" viewBox="0 0 48 48" fill="none">
              <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-opacity="0.18" stroke-width="3" />
              @if (view().spin || cmd()?.spin) {
                <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="30 126" />
              } @else if (view().ringFull) {
                <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
              }
            </svg>
            <svg class="rc-glyph col-start-1 row-start-1 h-4 w-4 translate-x-px transition-all {{ view().glyph === 'play' ? 'opacity-100 scale-100' : 'opacity-0 scale-50' }}" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.5 L12.5 8 L5 12.5 Z" /></svg>
            <svg class="rc-glyph col-start-1 row-start-1 h-3.5 w-3.5 transition-all {{ view().glyph === 'stop' ? 'opacity-100 scale-100' : 'opacity-0 scale-50' }}" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="2.5" /></svg>
            <svg class="rc-glyph col-start-1 row-start-1 h-4 w-4 transition-all {{ view().glyph === 'reset' ? 'opacity-100 scale-100' : 'opacity-0 scale-50' }}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.708L3 8" /><path d="M3 3v5h5" /></svg>
          </span>

        </button>

        <!-- Route identity stays readable and owns no direct actuation. When idle,
             it is a disclosure button for one-off target settings only. -->
        @if (canPick()) {
          <button type="button" class="rc-summary" (click)="togglePicker()"
            [attr.aria-expanded]="expanded()" [title]="expanded() ? 'Hide one-off run targets' : 'Set a one-off run target'">
            <ng-container *ngTemplateOutlet="routeSummary" />
          </button>
        } @else {
          <div class="rc-summary"><ng-container *ngTemplateOutlet="routeSummary" /></div>
        }

        <!-- Route-scoped automation management is available independently of device
             connectivity. Count is total schedules/triggers attached to this route. -->
        <button type="button" class="rc-automation" [class.has-automations]="automationCount()>0"
          [disabled]="!automationKey()" (click)="automation.emit()"
          [attr.aria-label]="automationLabel()" [title]="automationLabel()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/></svg>
          <span class="rc-count">{{automationCount()}}</span>
        </button>
      </div>

      <ng-template #routeSummary>
          <span class="min-w-0 flex-1 flex flex-col gap-0.5">
            <span class="flex items-center gap-1 min-w-0 text-[13px] font-bold tracking-tight leading-tight">
              <span class="truncate">{{ route().source || '—' }}</span>
              <svg class="shrink-0 h-3 w-3 text-base-content/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
              <span class="truncate">{{ route().destination || '—' }}</span>
            </span>
            <span class="inline-flex items-center gap-1.5 min-w-0 text-[11px] font-semibold leading-tight {{ cmd()?.tone || view().textCls }}">
              <span class="w-1.5 h-1.5 rounded-full shrink-0 {{ view().dotCls }}" [class.animate-pulse]="view().pulse"></span>
              <span class="truncate">{{ labelText() }}</span>
              @if (originText()) {
                <span class="text-base-content/40 font-normal truncate cursor-help" [title]="originTitle()">· {{ originText() }}</span>
              }
              @if(canPick()){
                <span class="rc-target-cue" aria-hidden="true"><svg class="h-3 w-3 transition-transform" [class.rotate-180]="expanded()" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
              }
            </span>
          </span>

          <!-- right readout: progress (running, with live data) → flow rate → offline -->
          @if (view().running && progress(); as p) {
            <span class="shrink-0 text-right leading-tight tabular-nums {{ p.nearDone ? 'text-success' : view().textCls }}">
              <span class="block text-sm font-bold">{{ p.primary }}</span>
              <span class="block text-[9px] font-normal text-base-content/45 -mt-0.5">{{ p.goal }}</span>
            </span>
          } @else if (view().running && route().flowSensor && flowRate() !== null) {
            <span class="shrink-0 text-right text-sm font-semibold tabular-nums {{ view().textCls }}">{{ flowText() }}<span class="block text-[9px] font-normal text-base-content/40 -mt-0.5">L/min</span></span>
          } @else if (!online()) {
            <span class="shrink-0 text-[10px] text-base-content/40">offline</span>
          }
      </ng-template>

      <!-- target picker: combine any of the route's targets; the run stops at the first
           one reached. Touch-sized controls; the volume target is capped at the tank. -->
      @if (expanded() && canPick()) {
        <div class="rc-options relative z-10 px-3 pb-3 pt-2 border-t border-base-300/40 flex flex-col gap-2">
          <p class="text-[10px] text-base-content/40 leading-snug">
            Stops at the first target reached.
            {{ route().canStopOnFull ? 'No target → runs until the tank is full.' : 'No target → runs until the time limit.' }}
          </p>
          @for (row of targetRows(); track row.field.key) {
            <div class="flex items-center gap-2 flex-wrap">
              <label class="flex items-center gap-2 flex-1 min-w-0 select-none py-0.5"
                [class.cursor-pointer]="row.avail.available" [class.opacity-40]="!row.avail.available"
                [title]="row.avail.available ? '' : (row.avail.reason ?? '')">
                <input type="checkbox" class="toggle toggle-sm" [checked]="isOn(row.field.key)"
                  [disabled]="!row.avail.available" (change)="toggleField(row.field.key)" />
                <span class="text-[13px] truncate">{{ row.field.label }}</span>
                @if (!row.avail.available && row.avail.reason) {
                  <span class="text-[10px] text-base-content/40 truncate">· {{ row.avail.reason }}</span>
                }
              </label>
              @if (row.avail.available && isOn(row.field.key)) {
                <input type="number" min="0" [max]="maxFor(row.field)" [value]="val(row.field.key)" (input)="setVal(row.field.key, $event)"
                  class="input input-sm input-bordered w-20 text-right tabular-nums" />
                <span class="text-[10px] text-base-content/40 w-6">{{ row.field.unit }}</span>
                <div class="flex gap-1.5 basis-full sm:basis-auto">
                  @for (c of chipsFor(row.field); track c) {
                    <button type="button" (click)="setValDirect(row.field.key, c)"
                      class="px-2.5 py-1 rounded-md text-[11px] bg-base-200 hover:bg-base-300 active:bg-base-300 text-base-content/70 tabular-nums">{{ c }}</button>
                  }
                </div>
              }
            </div>
          }
          <button type="button" (click)="runTarget()" [disabled]="!canRun()"
            class="btn btn-primary btn-sm w-full mt-0.5">Run · {{ runSummary() }}</button>
        </div>
      }
    </div>
  `,
})
export class RouteCardComponent {
  readonly route = input.required<RouteControl>();
  /** The route's live state: a SYSTEM_STATE `token` ('' ⇒ never seen ⇒ idle), the
   *  `reason` token carried by the latest transition (for the fault detail), and
   *  who/what started the run (`origin` + the viewer-resolved `initiator`). */
  readonly state = input<{ token: string; reason: string; origin?: string; initiator?: { label: string; support: boolean; title: string } }>({ token: '', reason: '' });

  /** "by Jane" / "Automation: Morning" / "Support" while a run is active, else ''.
   *  Mirrors the activity chip (resolveInitiator → formatInitiator) so the card and
   *  the timeline never disagree on who's running it. */
  protected originText = computed(() => {
    const s = this.state();
    if (!s.token || s.token === 'IDLE') return '';
    const init = s.initiator;
    if (!init || !init.label) return '';
    if (init.support) return init.label;
    return formatInitiator(s.origin, init.label);
  });
  /** Hover detail for the initiator line — name · email · co-owner / Support
   *  explainer, resolved alongside the label so it matches the activity chip. */
  protected originTitle = computed(() => {
    const s = this.state();
    if (!s.token || s.token === 'IDLE') return '';
    return s.initiator?.title ?? '';
  });
  /** Live flow rate (L/min) from the route's flow sensor, or null when unknown. */
  readonly flowRate = input<number | null>(null);
  /** Live progress for the card-as-progress-bar (running only); null ⇒ no live data
   *  yet (then the flow rate shows). The page computes it (see runProgress). */
  readonly progress = input<RunProgress | null>(null);
  /** Fill glide duration (ms), ~ the snapshot interval, so the bar moves continuously
   *  between updates rather than stepping. */
  readonly fillMs = input(9000);
  readonly online = input(true);
  /** Live command phase from the lifecycle store; null ⇒ no command in flight (the
   *  state view drives). `pending` ⇒ "Sending…" + spinner; `refused`/`expired` ⇒
   *  surface the reason. */
  readonly phase = input<CommandPhase | null>(null);
  /** Refusal/stop reason token accompanying a `refused` phase (best-effort). */
  readonly phaseReason = input('');
  /** False (admin read-only) → state still shows, the toggle is disabled. */
  readonly controllable = input(true);
  /** Stable manifest route key and current number of attached automations. */
  readonly automationKey = input('');
  readonly automationCount = input(0);
  readonly automationSelected = input(false);

  readonly action = output<RouteAction>();
  readonly automation = output<void>();
  /** A targeted run: emitted with the chosen StopSpec when the operator taps Run in
   *  the picker. The page dispatches a `route_start` carrying it; plain start (the
   *  strip) emits `action` with no target and runs to the route's own stop. */
  readonly run = output<StopSpecOverride>();

  /** Whether this route can be commanded at all (has a valve or pump). A monitor-only
   *  route (a flow sensor but no actuator) shows its state but no Start. Defaults to
   *  true for pre-caps route literals. */
  protected runnable = computed(() => this.route().caps?.runnable ?? true);

  protected disabled = computed(() => this.phase() === 'pending' || !this.online() || !this.controllable()
    || (this.view().action === 'route_start' && !this.runnable()));

  // --- Run-with-a-target picker (idle only). Combinable: any subset of the
  //     route's targets; the device stops at the first one reached. Same model
  //     as the automations editor (shared RUN_TARGET_FIELDS). --------------------
  protected expanded = signal(false);
  /** Active target field keys. */
  protected picked = signal<Set<string>>(new Set());
  /** Per-field display-unit values (minutes for duration; wire scale applied on run). */
  protected values = signal<Record<string, number>>({});

  /** Every run target with its availability + reason (the single capability owner,
   *  via route.caps). The picker renders unavailable targets disabled with the reason
   *  instead of hiding them, so the operator sees *why* a target isn't offered. */
  protected targetRows = computed<{ field: RunTargetField; avail: TargetAvailability }[]>(() => {
    const caps = this.route().caps;
    const availOf = (key: string): TargetAvailability => {
      if (!caps) return { available: true }; // pre-caps literals: assume offerable
      if (key === 'ov_target_volume_l') return caps.targets.volume;
      if (key === 'ov_dest_max_pct') return caps.targets.level;
      if (key === 'ov_target_duration_s') return caps.targets.duration;
      return { available: false };
    };
    return RUN_TARGET_FIELDS.filter((f) => f.runTarget).map((f) => ({ field: f, avail: availOf(f.key) }));
  });
  /** The offerable run targets (available subset) — used by the StopSpec builder
   *  and the run summary. Derived from {@link targetRows} so they never disagree. */
  protected targetFields = computed<RunTargetField[]>(() =>
    this.targetRows().filter((r) => r.avail.available).map((r) => r.field));
  /** The picker is offered only while the route is idle, controllable and online. */
  protected canPick = computed(() =>
    this.view().action === 'route_start' && this.runnable() && this.controllable() && this.online() && this.phase() !== 'pending');

  /** Per-route bounds for the picker: volume is capped at the tank's capacity (one
   *  owner — runTargetMax/runTargetChips — shared with the automations editor). */
  private targetCtx = computed(() => ({ destCapacityL: this.route().destCapacityL }));
  protected maxFor(f: RunTargetField): number { return runTargetMax(f, this.targetCtx()); }
  protected chipsFor(f: RunTargetField): number[] { return runTargetChips(f, this.targetCtx()); }

  protected isOn(key: string): boolean { return this.picked().has(key); }
  protected val(key: string): number { return this.values()[key] ?? this.defFor(key); }
  protected num(e: Event): number { return Math.max(0, Number((e.target as HTMLInputElement).value) || 0); }

  /** At least one target picked, all with a positive value. */
  protected canRun = computed(() => {
    const p = this.picked();
    if (p.size === 0) return false;
    for (const k of p) if (this.val(k) <= 0) return false;
    return true;
  });
  protected runSummary = computed(() => {
    const parts: string[] = [];
    for (const f of this.targetFields()) if (this.picked().has(f.key)) parts.push(`${this.val(f.key)}${f.unit}`);
    return parts.join(' · ') || 'now';
  });

  private field(key: string): RunTargetField | undefined { return RUN_TARGET_FIELDS.find((f) => f.key === key); }
  private defFor(key: string): number {
    const f = this.field(key);
    if (!f) return 0;
    const chips = this.chipsFor(f);
    return chips[1] ?? chips[0] ?? f.min ?? 0;
  }

  protected togglePicker(): void { this.expanded.update((v) => !v); }
  protected toggleField(key: string): void {
    const next = new Set(this.picked());
    if (next.has(key)) next.delete(key);
    else { next.add(key); if (this.values()[key] == null) this.setValDirect(key, this.defFor(key)); }
    this.picked.set(next);
  }
  protected setVal(key: string, e: Event): void { this.setValDirect(key, this.num(e)); }
  protected setValDirect(key: string, n: number): void {
    const f = this.field(key);
    const max = f ? this.maxFor(f) : n; // clamp to the route's real ceiling (tank capacity)
    this.values.update((m) => ({ ...m, [key]: Math.min(n, max) }));
  }

  /** Build the StopSpec from the picked targets (display → wire via each field's
   *  scale) and emit it. Each active field sets its bit; the device ignores the rest. */
  protected runTarget(): void {
    let mask = 0;
    const spec: StopSpecOverride = {
      override_mask: 0, ov_source_min_pct: 0, ov_dest_max_pct: 0,
      ov_max_runtime_min: 0, ov_target_duration_s: 0, ov_target_volume_l: 0,
    };
    for (const f of this.targetFields()) {
      if (!this.picked().has(f.key)) continue;
      mask |= f.bit;
      spec[f.key] = this.val(f.key) * (f.scale ?? 1);
    }
    if (!mask) return;
    spec.override_mask = mask;
    this.run.emit(spec);
    this.expanded.set(false);
    this.picked.set(new Set());
    this.values.set({});
  }

  /** Command-phase overlay (spinner / alert) layered over the token-driven view. */
  protected cmd = computed(() => { const p = this.phase(); return p ? phaseUi(p) : null; });

  /** State line text: the command phase wins while a command resolves (instant
   *  "Sending…", then the reason on refusal/timeout), else the token-derived label. */
  protected labelText = computed(() => {
    switch (this.phase()) {
      case 'pending': return 'Sending…';
      case 'refused': return this.reasonLabel();
      case 'expired': return 'No response';
      default:        return this.view().label;
    }
  });

  private reasonLabel(): string {
    const r = this.phaseReason();
    return r ? describeState(ROUTE_REASONS, r).label : 'Blocked';
  }

  protected flowText(): string {
    const v = this.flowRate();
    if (v === null || Number.isNaN(v)) return '—';
    return v >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  }

  protected actionTitle = computed(() => {
    const v = this.view();
    const parts = [`${routeLabel(this.route(), this.route().routeId)}: ${v.label}`];
    const reason = this.state().reason;
    if (reason) parts.push(describeState(ROUTE_REASONS, reason).label);
    if (!this.online()) parts.push('controller offline');
    else if (!this.controllable()) parts.push('read-only');
    else if (!this.runnable()) parts.push('no actuator — monitor only');
    else parts.push(v.actionLabel);
    return parts.join(' · ');
  });

  protected automationLabel = computed(() => {
    const count = this.automationCount();
    if (!this.automationKey()) return 'Automations unavailable for this route';
    return `Manage ${count} ${count === 1 ? 'automation' : 'automations'} for ${routeLabel(this.route(), this.route().routeId)}`;
  });

  protected view = computed<RouteView>(() => {
    const token = this.state().token;
    switch (token) {
      case 'PREPARING':
        return { label: 'Starting…', running: true, pulse: true,
          glyph: 'play', spin: true, ringFull: false,
          ring: 'ring-warning/40', textCls: 'text-warning', dotCls: 'bg-warning',
          actionLabel: 'Stop', action: 'route_stop' };
      case 'RUNNING':
        return { label: 'Flowing', running: true, pulse: false,
          glyph: 'stop', spin: false, ringFull: true,
          ring: 'ring-primary/50', textCls: 'text-primary', dotCls: 'bg-primary',
          actionLabel: 'Stop', action: 'route_stop' };
      case 'STOPPING':
        return { label: 'Stopping…', running: true, pulse: true,
          glyph: 'stop', spin: true, ringFull: false,
          ring: 'ring-warning/40', textCls: 'text-warning', dotCls: 'bg-warning',
          actionLabel: 'Stop', action: 'route_stop' };
      case 'FAULT': {
        const r = this.state().reason;
        const label = r ? describeState(ROUTE_REASONS, r).label : 'Fault';
        return { label, running: false, pulse: true,
          glyph: 'reset', spin: false, ringFull: true,
          ring: 'ring-error/50', textCls: 'text-error', dotCls: 'bg-error',
          actionLabel: 'Reset', action: 'fault_reset' };
      }
      default: // '' or IDLE
        return { label: 'Idle', running: false, pulse: false,
          glyph: 'play', spin: false, ringFull: false,
          ring: 'ring-base-300/40 hover:ring-base-300/70', textCls: 'text-base-content/50',
          dotCls: 'bg-base-content/30',
          actionLabel: 'Start', action: 'route_start' };
    }
  });
}
