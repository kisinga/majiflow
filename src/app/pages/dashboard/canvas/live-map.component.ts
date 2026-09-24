import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { SiteTopology } from '../../../core/models/topology.model';
import type { NodeRuntime } from '@core';
import { LiveCanvas, type ActivePath, type CanvasViewportInsets } from './live-canvas';

/**
 * Dumb host for the live SCADA map. Owns the `LiveCanvas` lifecycle and pushes
 * the topology + live state into it; all derivation lives in the dashboard
 * (the SSOT), so this component just renders what it's given.
 */
@Component({
  selector: 'app-live-map',
  standalone: true,
  styles: [`
    :host { display: block; }
    .map-frame { height: min(70vh, 640px); }
    .map-frame.fill { height: 100%; min-height: 0; border-radius: 0; box-shadow: none; }
    .map-host { touch-action: none; }
    .map-tools { padding: 3px; gap: 3px; border: 1px solid var(--op-border, #cfdae7); border-radius: 13px; background: rgb(255 255 255 / .9); box-shadow: 0 7px 20px rgb(18 35 59 / .08); backdrop-filter: blur(10px); }
    .map-tools button { min-width: 2.75rem; min-height: 2.75rem; display: grid; place-items: center; border-radius: 9px; color: var(--op-ink, #12233b); transition: background var(--motion-press, 130ms) var(--ease-standard, ease), transform var(--motion-press, 130ms) var(--ease-standard, ease); }
    .map-tools button:hover { background: var(--op-panel, #edf3f8); }
    .map-tools button:active { transform: scale(.94); }
    .map-tools button:focus-visible { outline: 3px solid color-mix(in srgb, var(--op-blue, #0369a1) 32%, transparent); outline-offset: 1px; }
    .map-legend { border: 1px solid var(--op-border, #cfdae7); color: var(--op-muted, #60738a); background: rgb(255 255 255 / .9); box-shadow: 0 7px 20px rgb(18 35 59 / .06); backdrop-filter: blur(10px); }
    @media (max-width: 767.98px) {
      .map-tools { top: .7rem; right: .7rem; flex-direction: row; }
      .map-legend { left: .7rem; bottom: .7rem; max-width: calc(100% - 1.4rem); }
    }
  `],
  template: `
    <div class="map-frame relative w-full rounded-2xl overflow-hidden bg-[#eaf2f8]"
         [class.fill]="fill()">
      <div #host class="map-host absolute inset-0"></div>

      <!-- Zoom controls — buttons only. Wheel-zoom is locked so scrolling the
           dashboard never zooms the map by accident. -->
      <div class="map-tools absolute top-3 right-3 z-10 flex flex-col">
        <button type="button" (click)="zoomIn()" title="Zoom in" aria-label="Zoom in"
                >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" d="M12 5v14M5 12h14"/></svg>
        </button>
        <button type="button" (click)="zoomOut()" title="Zoom out" aria-label="Zoom out"
                >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" d="M5 12h14"/></svg>
        </button>
        <button type="button" (click)="fit()" title="Fit to view" aria-label="Fit to view"
                >
          <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4"/></svg>
        </button>
      </div>

      <!-- Legend — the live vocabulary at a glance, frosted so it reads over the grid. -->
      <div class="map-legend absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2.5 py-1.5 text-[10px] font-medium">
        <span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_5px_1px] shadow-emerald-400/70"></span>Active</span>
        <span class="inline-flex items-center gap-1.5"><span class="h-0.5 w-4 rounded bg-sky-400"></span>Flow</span>
        <span class="inline-flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_5px_1px] shadow-red-500/70"></span>Fault</span>
        <span class="inline-flex items-center gap-1.5 opacity-50"><span class="h-2 w-2 rounded-full bg-slate-500"></span>Offline</span>
        <span class="hidden sm:inline">· drag to pan</span>
      </div>
    </div>
  `,
})
export class LiveMapComponent implements OnDestroy {
  /** Fill the parent operator workspace instead of using the legacy card height. */
  readonly fill = input(false);
  readonly topology = input<SiteTopology | null>(null);
  readonly runtime = input<Map<string, NodeRuntime>>(new Map());
  /** Nodes + pipes a route contributes, bucketed by state (active / fault) — the
   *  overlay the map lights. */
  readonly activePath = input<ActivePath>({ nodes: new Set(), pipes: new Set(), faultNodes: new Set(), faultPipes: new Set() });
  /** Draw the owning-controller boxes + wires. Off on the customer live dashboard:
   *  the controller is an engineering grouping with no operational meaning here, so
   *  the map shows only the plumbing (nodes + pipes stand on their own). The editor's
   *  design canvas keeps them; this live map opts in only if a host asks. */
  readonly showControllers = input(false);
  /** Nodes that are direct-manual-control entry points. Non-actuator nodes stay
   *  readable but do not masquerade as controls. */
  readonly selectableNodeIds = input<Set<string>>(new Set());
  readonly selectedNodeId = input<string | null>(null);
  /** Screen area occupied by a responsive inspector/sheet. Fit and selection
   *  reveal respect it without changing graph data or route styling. */
  readonly safeViewportInsets = input<CanvasViewportInsets>({ top: 0, right: 0, bottom: 0, left: 0 });
  readonly nodeSelect = output<string>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private canvas: LiveCanvas | null = null;
  private resizeObs: ResizeObserver | null = null;
  private visibilityObs: IntersectionObserver | null = null;
  private syncSize: (() => void) | null = null;
  private resizeFrame = 0;
  private readonly onWindowResize = () => {
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => this.syncSize?.());
  };

  constructor() {
    afterNextRender(() => {
      const el = this.host().nativeElement;
      const frame = el.parentElement;
      this.canvas = new LiveCanvas(el, (id) => this.nodeSelect.emit(id));
      // X6 writes an explicit width/height onto its container. Observing that same
      // element creates a sizing trap: after a desktop render it keeps reporting
      // the old desktop dimensions even when its responsive frame becomes narrow.
      // Observe the frame (the actual layout owner) and drive X6 from that instead.
      if (frame) {
        this.syncSize = () => {
          const width = frame.clientWidth;
          const height = frame.clientHeight;
          this.canvas?.resize(width, height);
        };
        this.resizeObs = new ResizeObserver(([entry]) => {
          const { width, height } = entry.contentRect;
          this.canvas?.resize(Math.round(width), Math.round(height));
        });
        this.resizeObs.observe(frame);
        // A phone opens on the Controls tab, so the map is laid out off-screen but
        // initially hidden. IntersectionObserver is the reveal edge: size once the
        // map enters the viewport, then ResizeObserver owns later changes.
        this.visibilityObs = new IntersectionObserver(([entry]) => {
          if (entry.isIntersecting) requestAnimationFrame(() => this.syncSize?.());
        });
        this.visibilityObs.observe(frame);
        window.addEventListener('resize', this.onWindowResize, { passive: true });
        this.syncSize();
      }
      this.renderTopology();
    });

    // Re-render when the topology arrives/changes, then fit.
    effect(() => {
      this.topology();
      this.renderTopology();
    });

    // Push live state on every shadow update (cheap class toggles).
    effect(() => {
      const runtime = this.runtime();
      this.canvas?.setState(runtime);
    });

    // Light the engaged path (nodes + pipes) as routes start/stop.
    effect(() => {
      const path = this.activePath();
      this.canvas?.setActivePath(path);
    });

    effect(() => {
      const selectable = this.selectableNodeIds();
      this.canvas?.setSelectableNodes(selectable);
    });

    effect(() => {
      const insets = this.safeViewportInsets();
      this.canvas?.setSafeViewportInsets(insets);
    });

    effect(() => {
      const selected = this.selectedNodeId();
      this.canvas?.setSelectedNode(selected);
    });

  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
    this.visibilityObs?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    cancelAnimationFrame(this.resizeFrame);
    this.syncSize = null;
    this.canvas?.destroy();
  }

  // Zoom controls — the only way to zoom (wheel-zoom is locked in the canvas).
  protected zoomIn(): void { this.canvas?.zoomIn(); }
  protected zoomOut(): void { this.canvas?.zoomOut(); }
  protected fit(): void { this.canvas?.fit(); }

  /** Called by responsive compositions immediately after revealing the map. */
  refreshLayout(): void { this.syncSize?.(); }

  private renderTopology(): void {
    const topo = this.topology();
    if (!this.canvas || !topo) return;
    // render() refits itself when the node set changes; don't fit here or we'd
    // reset the operator's pan/zoom on unrelated re-renders.
    let overlays;
    if (this.showControllers()) {
      const friendlyNames = new Map<string, string>();
      for (const c of topo.controllers ?? []) friendlyNames.set(c.id, c.friendlyName ?? c.id);
      overlays = { controllers: topo.controllers, friendlyNames, positions: topo.layout?.controllers };
    }
    this.canvas.render(topo, overlays);
    this.canvas.setState(this.runtime());
    this.canvas.setActivePath(this.activePath());
    this.canvas.setSelectableNodes(this.selectableNodeIds());
    this.canvas.setSafeViewportInsets(this.safeViewportInsets());
    this.canvas.setSelectedNode(this.selectedNodeId());
  }
}
