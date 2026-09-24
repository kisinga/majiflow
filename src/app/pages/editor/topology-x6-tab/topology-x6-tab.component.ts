import { Component, inject, ElementRef, viewChild, afterNextRender, DestroyRef, computed, signal, effect, Injector } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { SystemEditorService } from '../../../core/services/system-editor.service';
import { WorkspaceService } from '../../../core/services/workspace.service';
import { BackendService } from '../../../core/services/backend.service';
import type { SiteTopology, TopologyNode, RouteOverride } from '../../../core/models/topology.model';
import { NODE_REGISTRY, legendSvgFor, type NodeDescriptor } from '../../../core/models/entities.model';
import { X6Canvas, type Selection } from './x6-canvas';
import type { Node as X6Node } from '@antv/x6';
import { TopologySidebarComponent } from '../shared/topology-sidebar.component';
import { AddControllerComponent } from './add-controller.component';
import { buildGraph, activeGraph, downstreamNodes } from '@core';
import { renderPerSystemOverlays } from '../../../shared/canvas/topology-overlays';
import { renderControllerOverlays } from '../../../shared/canvas/controller-overlay-renderer';

@Component({
  selector: 'app-topology-x6-tab',
  standalone: true,
  imports: [TopologySidebarComponent, AddControllerComponent],
  host: {
    '(document:keydown.escape)': 'closePopup()',
    '(document:keydown.control.z)': 'doUndo()',
    '(document:keydown.control.y)': 'doRedo()',
    '(document:keydown.meta.z)': 'doUndo()',
    '(document:keydown.meta.shift.z)': 'doRedo()',
    '(document:keydown.delete)': 'deleteSelected($event)',
    '(document:keydown.backspace)': 'deleteSelected($event)',
  },
  template: `
    <header class="design-toolbar">
      <div class="toolbar-copy">
        <span class="toolbar-eyebrow">Topology editor</span>
        <h2>Design system</h2>
      </div>
      <div class="toolbar-actions" aria-label="Topology tools">
        @if (!editor.readonly()) {
          <div class="dropdown dropdown-end">
            <button tabindex="0" type="button" class="design-tool design-tool-primary">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
              <span>Add node</span>
            </button>
            <ul tabindex="0" class="node-menu dropdown-content menu z-30 w-56 p-2">
              @for (group of groupedDescs; track group.label) {
                <li class="menu-title">{{ group.label }}</li>
                @for (desc of group.items; track desc.kind) {
                  <li><button type="button" (click)="addNode(desc.kind)" [class.disabled]="desc.singleton && kindExists(desc.kind)">
                    <span class="menu-icon" [innerHTML]="legendSvg(desc)"></span><span>{{ desc.label }}</span>
                    @if (desc.experimental) { <span class="badge badge-ghost badge-xs ml-auto">Experimental</span> }
                  </button></li>
                }
              }
            </ul>
          </div>
          <app-add-controller />
          <span class="tool-separator" aria-hidden="true"></span>
          <button class="design-tool design-tool-icon" type="button" aria-label="Undo" title="Undo" (click)="doUndo()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 7-5 5 5 5"/><path d="M20 17a7 7 0 0 0-7-7H4"/></svg>
          </button>
          <button class="design-tool design-tool-icon" type="button" aria-label="Redo" title="Redo" (click)="doRedo()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 7 5 5-5 5"/><path d="M4 17a7 7 0 0 1 7-7h9"/></svg>
          </button>
          <span class="tool-separator" aria-hidden="true"></span>
        }
        <div class="view-tools" aria-label="Canvas view">
          <button class="design-tool design-tool-icon" type="button" aria-label="Zoom out" title="Zoom out" (click)="doZoomOut()">&minus;</button>
          <button class="design-tool design-tool-icon" type="button" aria-label="Zoom in" title="Zoom in" (click)="doZoomIn()">+</button>
          <button class="design-tool design-tool-fit" type="button" (click)="doFit()">Fit</button>
        </div>
      </div>
    </header>

    <div class="design-stage">
      <!-- Canvas -->
      <div class="canvas-wrap">
        <div #x6canvas></div>
        <div class="legend" aria-label="Component legend">
          <span class="legend-title">Components</span>
          <div class="legend-list">
            @for (desc of nodeDescs; track desc.kind) {
              <div class="legend-item">
                <span class="legend-icon" [innerHTML]="legendSvg(desc)"></span>
                <span>{{ desc.label }}</span>
              </div>
            }
          </div>
        </div>
      </div>

      <!-- Node selector popup (shown when pipe dropped on empty space) -->
      @if (nodePopup(); as popup) {
        <div class="node-popup-backdrop" (click)="closePopup()"></div>
        <div class="node-popup" [style.left.px]="popup.clientPos.x" [style.top.px]="popup.clientPos.y">
          <ul class="node-menu menu rounded-xl shadow-lg w-48 p-2">
            @for (desc of popupDescs(); track desc.kind) {
              <li><button type="button" (click)="selectPopupNode(desc.kind)">
                <span class="menu-icon" [innerHTML]="legendSvg(desc)"></span><span>{{ desc.label }}</span>
              </button></li>
            }
          </ul>
        </div>
      }

      <!-- Sidebar -->
      <aside class="sidebar">
        @if (!selection()) {
          <div class="sidebar-intro">
            <span>Inspector</span>
            <strong>Topology details</strong>
            <p>Select a node, pipe or derived route to inspect and configure it.</p>
          </div>
        }
        <app-topology-sidebar
          [selection]="selection()"
          (deleteNode)="deleteNode($event)"
          (deletePipe)="deletePipe($event)"
          (updateField)="updateNodeField($event.nodeId, $event.field, $event.value)"
          (updateRouteOverride)="updateRouteOverride($event.key, $event.field, $event.value)"
          (selectRoute)="onRouteSelected($event)"
          (selectNode)="onNodeSelected($event)"
        />
      </aside>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      color: var(--op-ink, #12233b);
      background: var(--op-shell, #f6f9fc);
    }
    .design-toolbar {
      min-width: 0; min-height: 68px; padding: 10px 14px 10px 18px;
      display: flex; align-items: center; gap: 18px;
      border-bottom: 1px solid var(--op-border, #cfdae7);
      background: rgb(251 252 250 / .96); z-index: 22;
    }
    .toolbar-copy { min-width: 9.5rem; flex: 1; }
    .toolbar-copy h2 { margin: 3px 0 0; font-size: 17px; line-height: 1.15; font-weight: 800; }
    .toolbar-eyebrow { display: block; color: var(--op-muted, #60738a); font-size: 9px; line-height: 1; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
    .toolbar-actions { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px; overflow-x: auto; scrollbar-width: none; }
    .toolbar-actions::-webkit-scrollbar { display: none; }
    .design-tool, :host ::ng-deep app-add-controller .design-tool {
      min-width: 44px; min-height: 44px; padding: 0 12px; flex: none;
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      border: 1px solid transparent; border-radius: 11px; background: transparent;
      color: var(--op-ink, #12233b); font-size: 12px; line-height: 1; font-weight: 750;
      transition: background var(--motion-press, 130ms) var(--ease-standard, ease), border-color var(--motion-press, 130ms) var(--ease-standard, ease), transform var(--motion-press, 130ms) var(--ease-standard, ease);
    }
    .design-tool:hover, :host ::ng-deep app-add-controller .design-tool:hover { border-color: var(--op-border, #cfdae7); background: var(--op-panel, #edf3f8); }
    .design-tool:active, :host ::ng-deep app-add-controller .design-tool:active { transform: scale(.97); }
    .design-tool:focus-visible, :host ::ng-deep app-add-controller .design-tool:focus-visible { outline: 3px solid color-mix(in srgb, var(--op-blue, #0369a1) 30%, transparent); outline-offset: 2px; }
    .design-tool svg, :host ::ng-deep app-add-controller .design-tool svg { width: 18px; height: 18px; flex: none; }
    .design-tool-primary { color: var(--op-blue, #0369a1); border-color: color-mix(in srgb, var(--op-blue, #0369a1) 36%, var(--op-border, #cfdae7)); background: var(--op-route-surface, #dff2fe); }
    .design-tool-icon { padding: 0; font-size: 20px; }
    .design-tool-fit { min-width: 50px; }
    .view-tools { padding: 3px; display: flex; gap: 2px; border: 1px solid var(--op-border, #cfdae7); border-radius: 13px; background: #fff; }
    .tool-separator { width: 1px; height: 28px; margin: 0 3px; flex: none; background: var(--op-border, #cfdae7); }
    .node-menu { margin-top: 6px; border: 1px solid var(--op-border, #cfdae7); background: #fff; box-shadow: 0 16px 42px rgb(18 35 59 / .16); color: var(--op-ink, #12233b); }
    .node-menu .menu-title { padding: 9px 9px 5px; color: var(--op-muted, #60738a); font-size: 9px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    .node-menu button { min-height: 40px; width: 100%; display: flex; align-items: center; gap: 9px; border-radius: 8px; font-size: 12px; text-align: left; }
    .node-menu button:hover { background: var(--op-panel, #edf3f8); }
    .menu-icon { width: 26px; display: grid; place-items: center; flex: none; }
    .design-stage { min-width: 0; min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) clamp(18rem, 22vw, 21rem); overflow: hidden; }
    :host ::ng-deep .x6-graph { cursor: grab; }
    :host ::ng-deep .x6-graph:active { cursor: grabbing; }
    .canvas-wrap { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: var(--op-canvas, #eaf2f8); }
    .legend {
      position: absolute; bottom: 14px; left: 14px; max-width: calc(100% - 28px);
      padding: 10px 12px 11px; background: rgb(255 255 255 / .92);
      border: 1px solid var(--op-border, #cfdae7); border-radius: 11px;
      box-shadow: 0 8px 24px rgb(18 35 59 / .09); backdrop-filter: blur(10px);
      color: var(--op-ink, #12233b); pointer-events: none; z-index: 10;
    }
    .legend-title { display: block; margin-bottom: 7px; color: var(--op-muted, #60738a); font-size: 9px; line-height: 1; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    .legend-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 15px; }
    .legend-item { min-width: 0; display: flex; align-items: center; gap: 7px; color: var(--op-muted, #60738a); font: 600 10px/1.25 ui-monospace, monospace; white-space: nowrap; }
    .legend-icon { width: 23px; min-height: 17px; display: flex; justify-content: center; align-items: center; flex: none; }
    .sidebar { min-width: 0; min-height: 0; overflow-y: auto; border-left: 1px solid var(--op-border, #cfdae7); background: #fff; font-size: 12px; scrollbar-gutter: stable; }
    .sidebar-intro { padding: 17px 16px 15px; border-bottom: 1px solid var(--op-border, #cfdae7); background: var(--op-shell, #f6f9fc); }
    .sidebar-intro span { color: var(--op-blue, #0369a1); font-size: 9px; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
    .sidebar-intro strong { display: block; margin-top: 5px; font-size: 15px; }
    .sidebar-intro p { margin: 5px 0 0; color: var(--op-muted, #60738a); font-size: 11px; line-height: 1.45; }
    :host-context(.preview) .sidebar input,
    :host-context(.preview) .sidebar select,
    :host-context(.preview) .sidebar .toggle,
    :host-context(.preview) .sidebar button.btn-error,
    :host-context(.preview) .sidebar button[title="Delete"] {
      pointer-events: none;
      opacity: 0.5;
    }
    .node-popup-backdrop { position: fixed; inset: 0; z-index: 50; }
    .node-popup { position: fixed; z-index: 51; }
    @media (max-width: 980px) {
      .design-stage { grid-template-columns: minmax(0, 1fr) 18rem; }
      .toolbar-copy { min-width: 0; }
      .toolbar-copy h2 { font-size: 15px; }
    }
    @media (max-width: 720px) {
      .design-toolbar { min-height: 60px; padding: 8px; gap: 8px; }
      .toolbar-copy { display: none; }
      .toolbar-actions { flex: 1; justify-content: flex-start; }
      .design-tool > span, :host ::ng-deep app-add-controller .design-tool > span { display: none; }
      .design-tool, :host ::ng-deep app-add-controller .design-tool { padding: 0; }
      .design-stage { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(24rem, 1fr) minmax(12rem, 38vh); overflow-y: auto; }
      .sidebar { border-top: 1px solid var(--op-border, #cfdae7); border-left: 0; }
      .legend-list { grid-template-columns: minmax(0, 1fr); }
      .legend-item:nth-child(n+6) { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .design-tool, :host ::ng-deep app-add-controller .design-tool { transition: none; }
    }
  `],
})
export class TopologyX6TabComponent {
  protected editor = inject(SystemEditorService);
  protected workspace = inject(WorkspaceService);
  private backend = inject(BackendService);
  private sanitizer = inject(DomSanitizer);
  private injector = inject(Injector);
  private destroyRef = inject(DestroyRef);
  private canvasRef = viewChild.required<ElementRef<HTMLDivElement>>('x6canvas');

  private canvas: X6Canvas | null = null;
  private get c(): X6Canvas { return this.canvas!; }

  // Registry arrays for template iteration
  protected nodeDescs: NodeDescriptor[] = Array.from(NODE_REGISTRY.values());

  protected groupedDescs = (() => {
    const groups = new Map<string, NodeDescriptor[]>();
    for (const desc of this.nodeDescs) {
      const key = desc.group ?? desc.category ?? 'other';
      const list = groups.get(key) ?? [];
      list.push(desc);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([label, items]) => ({ label, items }));
  })();

  // --- Selection state ---
  protected selection = signal<Selection | null>(null);

  // --- Node popup state (pipe dropped on empty space) ---
  protected nodePopup = signal<{
    from: string;
    graphPos: { x: number; y: number };
    clientPos: { x: number; y: number };
  } | null>(null);

  protected popupDescs = computed(() => {
    if (!this.nodePopup()) return [];
    return this.nodeDescs.filter(desc => {
      if (desc.singleton && this.kindExists(desc.kind)) return false;
      return desc.defaultPorts.some(p => p.direction === 'inlet');
    });
  });

  private lastRenderedControllerId: string | null = null;

  constructor() {
    afterNextRender(() => {
      this.initCanvas();

      // Unified render effect: triggers on initial load AND controller switches,
      // but skips redundant renders when only topology data mutates.
      const stop = effect(() => {
        const cid = this.workspace.activeControllerId();
        const t = this.editor.topology();
        if (!t || !cid || !this.canvas) return;
        if (cid === this.lastRenderedControllerId) return;
        this.lastRenderedControllerId = cid;
        this.renderToCanvas(t, { reset: true });
      }, { injector: this.injector });
      this.destroyRef.onDestroy(() => stop.destroy());
    });
  }

  /** Enrich topology with interconnect labels based on the active system context. */
  private enrich(topology: SiteTopology): SiteTopology {
    // TODO(anchor-mesh): interconnect enrichment removed — flat site topology
    return topology;
  }

  private computeNodeImportCounts(): Map<string, number> {
    const topology = this.workspace.siteTopology();
    const cid = this.workspace.activeControllerId();
    if (!topology || !cid) return new Map();
    const counts = new Map<string, number>();
    for (const ri of topology.remoteImports) {
      const node = topology.nodes.find(n => n.id === ri.nodeId);
      if (node && node.anchorId === cid) {
        counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * Render the topology on the live canvas and capture its SVG for docs.
   * `reset: true` clears cells (use on initial load or full topology swap);
   * `reset: false` performs incremental reconciliation (use on granular edits).
   */
  private renderToCanvas(topology: SiteTopology, opts: { reset: boolean }) {
    if (this.canvas) {
      this.canvas.activeControllerId = this.workspace.activeControllerId() ?? undefined;
      this.canvas.nodeImportCounts = this.computeNodeImportCounts();
    }
    const enriched = this.enrich(topology);
    if (opts.reset) this.c.reset(enriched); else this.c.render(enriched);
    renderPerSystemOverlays(this.c.graphInstance, enriched);
    this.renderControllerOverlay();
    requestAnimationFrame(() =>
      this.c.exportSvg()
        .then(svg => this.editor.setCanvasSvg(svg))
        .catch(e => console.error('[MajiFlow] SVG export failed:', e)),
    );
  }

  private renderAndSnapshot(topology: SiteTopology) {
    this.renderToCanvas(topology, { reset: false });
  }

  // --- Template helpers ---

  trustSvg(svg: string) {
    return this.sanitizer.bypassSecurityTrustHtml(svg);
  }

  legendSvg(desc: NodeDescriptor) {
    return this.trustSvg(legendSvgFor(desc));
  }

  kindExists(kind: string): boolean {
    const t = this.editor.topology();
    return t ? t.nodes.some(n => n.kind === kind) : false;
  }

  private initCanvas() {
    const canvasEl = this.canvasRef().nativeElement;
    const canvasWrap = canvasEl.parentElement!;

    this.canvas = new X6Canvas(canvasEl, {
      onNodesMoved: (positions) => {
        this.editor.updateTopology(t => {
          for (const node of t.nodes) {
            const pos = positions.get(node.id);
            if (pos) node.position = pos;
          }
        });
      },
      onPipeCreated: (from, to) => {
        const pipeId = this.editor.nextPipeId();
        this.editor.updateTopology(t => {
          t.pipes.push({ id: pipeId, from, to });
        });
        this.renderAndSnapshot(this.editor.topology()!);
      },
      onPipeDeleted: (pipeId) => {
        this.editor.updateTopology(t => {
          t.pipes = t.pipes.filter(p => p.id !== pipeId);
        });
        this.selection.set(null);
        this.renderAndSnapshot(this.editor.topology()!);
      },
      onSelected: (sel) => {
        this.selection.set(sel);
        const t = this.editor.topology();
        if (t) this.c.highlight(sel, activeGraph(buildGraph(t.nodes, t.pipes)));
      },
      onDanglingPipe: (from, graphPos, clientPos) => {
        this.nodePopup.set({ from, graphPos, clientPos });
      },
    });
    this.canvas.nodeImportCounts = this.computeNodeImportCounts();

    // Keep canvas interactivity in lockstep with the editor's readonly state
    // (commissioned lock / route preview / admin design-mode opt-in). A reactive
    // effect, NOT a one-time read — so it stays correct as the sites catalog loads
    // async and as the lock is lifted. The old imperative read froze the canvas
    // locked under zoneless, where init runs after the catalog resolves.
    const stopReadonly = effect(() => {
      this.canvas?.setReadonly(this.editor.readonly());
    }, { injector: this.injector });
    this.destroyRef.onDestroy(() => stopReadonly.destroy());

    // Re-render overlays when nodes are dragged so they track position
    let ghostEdgeTimer: ReturnType<typeof setTimeout> | null = null;
    this.c.graphInstance.on('node:change:position', ({ node }: { node: X6Node }) => {
      const data = node.getData() as Record<string, unknown> | undefined;
      if (data?.['kind'] === 'controller') {
        const controllerId = data['controllerId'] as string;
        this.workspace.setControllerLayoutPosition(controllerId, node.getPosition());
      }
      if (ghostEdgeTimer) clearTimeout(ghostEdgeTimer);
      ghostEdgeTimer = setTimeout(() => {
        const t = this.editor.topology();
        if (t) renderPerSystemOverlays(this.c.graphInstance, this.enrich(t));
        this.renderControllerOverlay();
      }, 50);
    });

    this.destroyRef.onDestroy(() => this.c.destroy());

    const syncSize = () => {
      const w = canvasWrap.clientWidth;
      const h = canvasWrap.clientHeight;
      this.c.resize(w, h);
    };

    const observer = new ResizeObserver(() => syncSize());
    observer.observe(canvasWrap);
    this.destroyRef.onDestroy(() => observer.disconnect());

    syncSize();
  }

  // --- Toolbar actions ---

  addNode(kind: string) {
    const desc = NODE_REGISTRY.get(kind);
    if (!desc) return;
    if (desc.singleton && this.kindExists(kind)) return;

    (document.activeElement as HTMLElement)?.blur();

    const center = this.c.getViewportCenter();

    // Generate site-wide unique ID before the topology update
    const id = desc.singleton ? kind : this.editor.nextNodeId(kind);
    const controllerId = this.editor.controllerId();

    this.editor.updateTopology(t => {
      const n = t.nodes.filter(n => n.kind === kind).length + 1;
      t.nodes.push({
        kind,
        id,
        anchorId: controllerId,
        ...desc.defaultData(n),
        ports: desc.defaultPorts.map(p => ({ ...p })),
        position: { x: center.x - desc.size.width / 2, y: center.y - desc.size.height / 2 },
      } as TopologyNode);
    });
    this.renderAndSnapshot(this.editor.topology()!);
  }

  doZoomIn() { this.c.zoomIn(); }
  doZoomOut() { this.c.zoomOut(); }
  doFit() { this.c.fitContent(); }
  doUndo() { this.c.undo(); }
  doRedo() { this.c.redo(); }

  deleteSelected(e?: Event) {
    if (e) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return;
    }
    const sel = this.selection();
    if (!sel) return;
    if (sel.kind === 'node') {
      // Don't allow deleting singleton nodes via keyboard
      const t = this.editor.topology();
      if (t) {
        const node = t.nodes.find(n => n.id === sel.nodeId);
        if (node) {
          const desc = NODE_REGISTRY.get(node.kind);
          if (desc?.singleton) return;
        }
      }
      this.deleteNode(sel.nodeId);
    } else if (sel.kind === 'pipe') {
      this.deletePipe(sel.pipeId);
    }
  }

  // --- Node editing ---

  deleteNode(nodeId: string) {
    this.editor.updateTopology(t => {
      t.nodes = t.nodes.filter(n => n.id !== nodeId);
      t.pipes = t.pipes.filter(p => {
        const fn = p.from.split(':')[0];
        const tn = p.to.split(':')[0];
        return fn !== nodeId && tn !== nodeId;
      });
      for (const key of Object.keys(t.route_overrides ?? {})) {
        if (key.includes(nodeId)) delete t.route_overrides[key];
      }
    });
    this.selection.set(null);
    this.renderAndSnapshot(this.editor.topology()!);
  }

  updateNodeField(nodeId: string, field: string, value: any) {
    this.editor.updateTopology(t => {
      const node = t.nodes.find(n => n.id === nodeId);
      if (node) Object.assign(node, { [field]: value });

      // Cascade disabled state to all downstream nodes
      if (field === 'disabled') {
        const g = buildGraph(t.nodes, t.pipes);
        const dsIds = downstreamNodes(g, nodeId);
        for (const dsId of dsIds) {
          const dn = t.nodes.find(n => n.id === dsId);
          if (dn) Object.assign(dn, { disabled: value });
        }
      }
    });
    // Push to X6 for live SVG update without full re-render
    this.renderAndSnapshot(this.editor.topology()!);
  }


  // --- Pipe editing ---

  deletePipe(pipeId: string) {
    this.editor.updateTopology(t => {
      t.pipes = t.pipes.filter(p => p.id !== pipeId);
    });
    this.selection.set(null);
    this.renderAndSnapshot(this.editor.topology()!);
  }

  // --- Route selection ---

  onRouteSelected(ev: { route: import('../shared/derive-routes').DerivedRoute; sharedNodeIds?: string[] }) {
    const sel: Selection = { kind: 'route', route: ev.route, sharedNodeIds: ev.sharedNodeIds };
    this.selection.set(sel);
    const t = this.editor.topology();
    if (t) this.c.highlight(sel, activeGraph(buildGraph(t.nodes, t.pipes)));
  }

  onNodeSelected(nodeId: string) {
    const sel: Selection = { kind: 'node', nodeId };
    this.selection.set(sel);
    const t = this.editor.topology();
    if (t) this.c.highlight(sel, activeGraph(buildGraph(t.nodes, t.pipes)));
  }

  // --- Route overrides ---

  updateRouteOverride(key: string, field: keyof RouteOverride, value: number | undefined) {
    this.editor.updateTopology(t => {
      if (!t.route_overrides) t.route_overrides = {};
      if (!t.route_overrides[key]) t.route_overrides[key] = {};
      t.route_overrides[key][field] = value;
    });
  }

  // --- Node popup ---

  selectPopupNode(kind: string) {
    const popup = this.nodePopup();
    if (!popup) return;
    this.nodePopup.set(null);

    const desc = NODE_REGISTRY.get(kind);
    if (!desc) return;
    if (desc.singleton && this.kindExists(kind)) return;

    // Generate site-wide unique IDs before the topology update
    const id = desc.singleton ? kind : this.editor.nextNodeId(kind);
    const pipeId = this.editor.nextPipeId();

    this.editor.updateTopology(t => {
      const n = t.nodes.filter(n => n.kind === kind).length + 1;
      const controllerId = this.editor.controllerId();
      t.nodes.push({
        kind,
        id,
        anchorId: controllerId,
        ...desc.defaultData(n),
        ports: desc.defaultPorts.map(p => ({ ...p })),
        position: popup.graphPos,
      } as TopologyNode);

      const inletPort = desc.defaultPorts.find(p => p.direction === 'inlet');
      if (inletPort) {
        t.pipes.push({ id: pipeId, from: popup.from, to: `${id}:${inletPort.id}` });
      }
    });
    this.renderAndSnapshot(this.editor.topology()!);
  }

  closePopup() {
    this.nodePopup.set(null);
  }

  private renderControllerOverlay() {
    const siteTopology = this.workspace.siteTopology();
    if (!siteTopology) return;
    const friendlyNames = new Map<string, string>();
    for (const ctrl of siteTopology.controllers) {
      friendlyNames.set(ctrl.id, ctrl.friendlyName ?? ctrl.id);
    }
    renderControllerOverlays(this.c.graphInstance, {
      controllers: siteTopology.controllers,
      friendlyNames,
      positions: siteTopology.layout?.controllers,
    });
  }

}
