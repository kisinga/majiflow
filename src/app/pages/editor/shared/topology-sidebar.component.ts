import { Component, inject, input, output, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SystemEditorService } from '../../../core/services/system-editor.service';
import { ValidationPanelComponent } from '../../../shared/validation-panel/validation-panel.component';
import type { RuleDiagnostic } from '../../../core/models/backend-api';
import { NODE_REGISTRY } from '../../../core/models/entities.model';
import type { DerivedRoute } from './derive-routes';
import { buildGraph, activeGraph, deriveRoutes, RouteOverrideSchema } from '@core';
import type { RouteOverride } from '../../../core/models/topology.model';
import { routeLevelInfo } from './route-level-info';
import type { Selection } from './selection';
import { ZodInputComponent } from '../../../shared/zod-input/zod-input.component';
import { NodePropertiesComponent } from './node-properties.component';
export type { Selection };

@Component({
  selector: 'app-topology-sidebar',
  standalone: true,
  imports: [FormsModule, ValidationPanelComponent, ZodInputComponent, NodePropertiesComponent],
  template: `
    <!-- Node properties (data-driven). Gated by the editor's readonly state (a
         commissioned lock or route preview): without this, inputs stay editable on
         a locked site and every edit is silently dropped by updateTopology's
         readonly early-return — no dirty, no autosave, no feedback. -->
    @if (selectedNodeData(); as sn) {
      <fieldset [disabled]="editor.readonly()" class="contents">
        <app-node-properties
          [node]="sn.node"
          [desc]="sn.desc"
          (updateField)="updateField.emit($event)"
          (deleteNode)="deleteNode.emit($event)" />
      </fieldset>
    }

    <!-- Pipe properties -->
    @if (selectedPipeData(); as pipeData) {
      <div class="sidebar-section">
        <button type="button" class="sidebar-title" (click)="toggleSection('pipe')">
          <span>Pipe</span>
          <svg class="section-chevron" [class.is-open]="isExpanded('pipe')" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 5 5 5-5 5"/></svg>
        </button>
        @if (isExpanded('pipe')) {
        <div class="pipe-path" [title]="pipeData.pipe.from + ' to ' + pipeData.pipe.to">{{ pipeData.pipe.from }} &rarr; {{ pipeData.pipe.to }}</div>
        <fieldset [disabled]="editor.readonly()" class="contents">
          <button type="button" class="delete-action" (click)="deletePipe.emit(pipeData.pipe.id)">Delete pipe</button>
        </fieldset>
        }
      </div>
    }

    <!-- Routes (always visible) -->
    <div class="sidebar-section">
      <button type="button" class="sidebar-title" (click)="toggleSection('routes')">
        <span>Derived Routes</span>
        <svg class="section-chevron" [class.is-open]="isExpanded('routes')" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 5 5 5-5 5"/></svg>
      </button>
      @if (isExpanded('routes')) {
      @if (derivedRoutes().length === 0) {
        <div class="text-base-content/40 text-center py-4 text-xs">No routes derived yet.<br>Connect nodes with pipes.</div>
      } @else {
        @for (route of derivedRoutes(); track route.key) {
          <button type="button" class="route-row"
            (click)="onRouteClick(route)">
            <span class="route-key" [title]="route.key">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 4h4l2 4h6M11 5l3 3-3 3"/></svg>
              <span>{{ route.key }}</span>
            </span>
            @if (hasErrorDiagnostics(route.key)) {
              <span class="badge badge-error badge-xs">Error</span>
            } @else if (hasWarningDiagnostics(route.key)) {
              <span class="badge badge-warning badge-xs">Warning</span>
            } @else if (!route.monitored) {
              <span class="badge badge-ghost badge-xs">Unmonitored</span>
            } @else if (hasInfoDiagnostics(route.key)) {
              <span class="badge badge-info badge-xs">Info</span>
            } @else {
              <span class="badge badge-success badge-xs">Valid</span>
            }
          </button>
        }
      }
      }
    </div>

    @if (!selection()) {
      <div class="sidebar-section">
        <button type="button" class="sidebar-title" (click)="toggleSection('overrides')">
          <span>Route Overrides</span>
          <svg class="section-chevron" [class.is-open]="isExpanded('overrides')" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 5 5 5-5 5"/></svg>
        </button>
        @if (isExpanded('overrides')) {
        @if (overrideEntries().length === 0) {
          <div class="text-base-content/40 text-center py-4 text-xs">No overrides defined.</div>
        } @else {
          @for (entry of overrideEntries(); track entry.key) {
            <div class="card bg-base-200/40 mb-2">
              <div class="card-body p-2 gap-1">
                <span class="override-key" [title]="entry.key">{{ entry.key }}</span>
                <div class="flex items-center gap-2">
                  <label class="text-[10px] text-base-content/50">Default Max Runtime</label>
                  <!-- Operator-facing unit is minutes; storage stays in seconds
                       (max_runtime_seconds) so the manifest and firmware are
                       unchanged. View → seconds happens in onMaxRuntimeChange. -->
                  <input type="number" class="input input-xs input-bordered w-20 font-mono"
                    min="1" max="120" step="1"
                    [name]="'rt-' + entry.key"
                    [ngModelOptions]="{ standalone: true }"
                    [ngModel]="maxRuntimeMinutes(entry.override.max_runtime_seconds)"
                    (ngModelChange)="onMaxRuntimeMinutesChange(entry.key, $event)" />
                  <span class="text-[10px] text-base-content/50">min</span>
                </div>
                @if (entry.sourceHasLevel) {
                  <div class="flex items-center gap-2">
                    <label class="text-[10px] text-base-content/50">Default Source Min</label>
                    <app-zod-input
                      [schema]="routeOverrideSchema"
                      fieldKey="source_min_level"
                      type="number"
                      inputClass="w-16 font-mono"
                      placeholder="—"
                      [min]="0"
                      [max]="100"
                      [value]="entry.override.source_min_level"
                      (valueChange)="updateRouteOverride.emit({ key: entry.key, field: 'source_min_level', value: $any($event) })" />
                    <span class="text-[10px] text-base-content/50">%</span>
                  </div>
                }
                @if (entry.destHasLevel) {
                  <div class="flex items-center gap-2">
                    <label class="text-[10px] text-base-content/50">Default Dest Max</label>
                    <app-zod-input
                      [schema]="routeOverrideSchema"
                      fieldKey="dest_max_level"
                      type="number"
                      inputClass="w-16 font-mono"
                      placeholder="—"
                      [min]="0"
                      [max]="100"
                      [value]="entry.override.dest_max_level"
                      (valueChange)="updateRouteOverride.emit({ key: entry.key, field: 'dest_max_level', value: $any($event) })" />
                    <span class="text-[10px] text-base-content/50">%</span>
                  </div>
                }
                <div class="text-[10px] text-base-content/45 mt-1 leading-snug">
                  Initial values, tuned live from the dashboard.
                </div>
              </div>
            </div>
          }
        }
        }
      </div>
    }

    <!-- Validation summary (always visible) -->
    <div class="sidebar-section">
      <button type="button" class="sidebar-title" (click)="toggleSection('validation')">
        <span>Validation</span>
        <svg class="section-chevron" [class.is-open]="isExpanded('validation')" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 5 5 5-5 5"/></svg>
      </button>
      @if (isExpanded('validation')) {
      <app-validation-panel
        [result]="editor.validation()"
        [gpioUsage]="editor.gpioUsage()"
        (selectTarget)="selectNode.emit($event)"
      />
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      font-size: 12px;
      color: var(--op-ink, #152019);
    }
    button:focus-visible { outline: 3px solid color-mix(in srgb, var(--op-blue, #196ca6) 30%, transparent); outline-offset: 1px; }
    .sidebar-section { min-width: 0; padding: 8px 12px 12px; border-bottom: 1px solid var(--op-border, #d7ded8); }
    .sidebar-title {
      min-height: 44px; width: 100%; display: flex; align-items: center; justify-content: space-between;
      color: var(--op-muted, #68756d); background: none; border: none; padding: 0 3px;
      font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; cursor: pointer;
      transition: color var(--motion-press, 130ms) var(--ease-standard, ease);
    }
    .sidebar-title:hover { color: var(--op-ink, #152019); }
    .section-chevron { width: 16px; height: 16px; flex: none; transition: transform var(--motion-selection, 170ms) var(--ease-standard, ease); }
    .section-chevron.is-open { transform: rotate(90deg); }
    .pipe-path { margin: 0 3px 10px; overflow: hidden; color: var(--op-muted, #68756d); font: 600 11px/1.4 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .delete-action { min-height: 44px; width: 100%; border: 1px solid color-mix(in srgb, var(--op-red, #b42318) 52%, var(--op-border, #d7ded8)); border-radius: 9px; color: var(--op-red, #b42318); background: #fff; font-size: 12px; font-weight: 800; }
    .delete-action:hover { background: color-mix(in srgb, var(--op-red, #b42318) 6%, #fff); }
    .route-row { min-height: 48px; width: 100%; min-width: 0; padding: 6px 4px 6px 6px; display: flex; align-items: center; gap: 7px; border-bottom: 1px solid var(--op-border, #d7ded8); border-radius: 8px; text-align: left; transition: background var(--motion-press, 130ms) var(--ease-standard, ease); }
    .route-row:hover { background: var(--op-panel, #f3f6f2); }
    .route-key { min-width: 0; flex: 1; display: flex; align-items: center; gap: 7px; color: var(--op-ink, #152019); font: 650 11px/1.35 ui-monospace, monospace; }
    .route-key svg { width: 16px; height: 16px; flex: none; color: var(--op-blue, #196ca6); }
    .route-key span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .route-row .badge { flex: none; }
    .override-key { display: block; max-width: 100%; overflow-wrap: anywhere; color: var(--op-ink, #152019); font: 700 11px/1.4 ui-monospace, monospace; }
    @media (prefers-reduced-motion: reduce) { .sidebar-title, .section-chevron, .route-row { transition: none; } }
  `],
})
export class TopologySidebarComponent {
  protected editor = inject(SystemEditorService);
  protected routeOverrideSchema = RouteOverrideSchema;

  private expandedSections = signal<Set<string>>(new Set(['pipe', 'routes']));

  protected isExpanded(key: string): boolean {
    return this.expandedSections().has(key);
  }

  protected toggleSection(key: string) {
    this.expandedSections.update(set => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // --- Inputs ---
  selection = input<Selection | null>(null);

  // --- Outputs ---
  deleteNode = output<string>();
  deletePipe = output<string>();
  updateField = output<{ nodeId: string; field: string; value: any }>();
  updateRouteOverride = output<{ key: string; field: keyof RouteOverride; value: number | undefined }>();
  selectRoute = output<{ route: DerivedRoute; sharedNodeIds?: string[] }>();
  selectNode = output<string>();

  // --- Computed ---
  protected selectedNodeData = computed(() => {
    const sel = this.selection();
    const t = this.editor.topology();
    if (!sel || sel.kind !== 'node' || !t) return null;
    const node = t.nodes.find(n => n.id === sel.nodeId);
    if (!node) return null;
    const desc = NODE_REGISTRY.get(node.kind);
    return desc ? { node, desc } : null;
  });

  protected selectedPipeData = computed(() => {
    const sel = this.selection();
    const t = this.editor.topology();
    if (!sel || sel.kind !== 'pipe' || !t) return null;
    const pipe = t.pipes.find(p => p.id === sel.pipeId);
    return pipe ? { pipe } : null;
  });

  protected derivedRoutes = computed(() => {
    const t = this.editor.topology();
    if (!t) return [];
    const g = activeGraph(buildGraph(t.nodes, t.pipes));
    return deriveRoutes(g);
  });

  protected overrideEntries = computed(() => {
    const t = this.editor.topology();
    if (!t) return [];
    return Object.entries(t.route_overrides ?? {}).map(([key, override]) => ({
      key,
      override,
      ...routeLevelInfo(key, t.nodes, t.pipes),
    }));
  });

  // --- Route override unit conversion ---

  /** Display value (minutes) for a stored max_runtime_seconds. */
  protected maxRuntimeMinutes(seconds: number | undefined): number {
    return Math.max(1, Math.round((seconds ?? 1800) / 60));
  }

  /** Persist a minutes-input change as the seconds value the schema expects. */
  protected onMaxRuntimeMinutesChange(key: string, minutes: unknown): void {
    const m = Number(minutes);
    const seconds = Number.isFinite(m) && m > 0 ? Math.round(m * 60) : undefined;
    this.updateRouteOverride.emit({ key, field: 'max_runtime_seconds', value: seconds });
  }

  // --- Route & validation helpers ---

  routeDiagnostics(routeKey: string): RuleDiagnostic[] {
    return this.editor.diagnosticsByTarget().get(routeKey) ?? [];
  }

  hasErrorDiagnostics(routeKey: string): boolean {
    return this.routeDiagnostics(routeKey).some(d => d.severity === 'error');
  }

  hasWarningDiagnostics(routeKey: string): boolean {
    return this.routeDiagnostics(routeKey).some(d => d.severity === 'warning');
  }

  hasInfoDiagnostics(routeKey: string): boolean {
    return this.routeDiagnostics(routeKey).some(d => d.severity === 'info');
  }

  onRouteClick(route: DerivedRoute) {
    const diags = this.routeDiagnostics(route.key);
    const sharedNodeIds = [...new Set(diags.flatMap(d => d.sharedNodeIds ?? []))];
    this.selectRoute.emit({ route, sharedNodeIds: sharedNodeIds.length ? sharedNodeIds : undefined });
  }
}
