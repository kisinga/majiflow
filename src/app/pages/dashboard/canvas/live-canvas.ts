/**
 * Framework-agnostic, read-only "live SCADA map" canvas.
 *
 * Composes the editor's X6 helpers (ports, edges, router) and the node-glyph
 * SSOT (`NODE_REGISTRY[].renderSvg`) but is deliberately *not* `X6Canvas`: it
 * carries none of the editor's write concerns (history, snapline, connecting,
 * drag/position persistence). It draws the topology and paints two live inputs
 * onto each glyph's `data-part` hooks via one generated stylesheet: per-node
 * telemetry (`setState`) and the engaged path of running routes (`setActivePath`).
 * A node reads live when engaged OR self-active. The canvas names no kind.
 *
 * Rendering is synchronous (`async: false`): the maps are small and static, so
 * views mount on `addNode` and we can inject glyphs / apply state immediately,
 * with no render-timing dance.
 */
import { Graph } from '@antv/x6';
import type { Node } from '@antv/x6';
import { NODE_REGISTRY } from '../../../core/models/entities.model';
import type { NodeDescriptor } from '../../../core/models/entities.model';
import type { RenderableTopology, TopologyNode } from '../../../core/models/topology.model';
import { applyStateClass, formatReading, SYMBOL, type NodeRuntime } from '@core';
import { UI_COLORS, STATE_COLORS } from '../../../core/models/colors.model';
import { buildEdgeConfig, type PortItem } from '../../editor/topology-x6-tab/x6-shapes';
import { ensureLiveNodeRegistered, buildLiveNodeConfig } from './live-shapes';
import { renderControllerOverlays, type ControllerOverlayOptions } from '../../../shared/canvas/controller-overlay-renderer';

// --- One generated stylesheet: the whole live visual language ---
//
// Keyed only on the shared `state-*` classes + `[data-part]` hooks — NOT per
// kind. Every glyph reacts the same way: the body takes a state accent, a
// `spin`/`fill`/`gate` part reacts if the symbol has one, and the value label
// is styled uniformly. Adding a kind needs no CSS — only its `live` facets.

const LIVE_STYLE_ID = 'x6-live-animation';
function ensureLiveStyles(): void {
  if (document.getElementById(LIVE_STYLE_ID)) return;
  const { active, fault } = STATE_COLORS;
  const style = document.createElement('style');
  style.id = LIVE_STYLE_ID;
  style.textContent = `
@keyframes x6-spin  { to { transform: rotate(360deg); } }
@keyframes x6-flow  { to { stroke-dashoffset: -1000; } }
@keyframes x6-pulse { 50% { opacity: .45; } }
.live-glyph { overflow: visible; }

/* State accent — uniform on every kind's [data-part=body]. A glow keeps the
   entity's identity colour while signalling live/fault the same way. A node is
   live when it's engaged (on a running route) OR its own actuator is active. */
.live-glyph [data-part=body] { transition: filter var(--motion-selection, 170ms) var(--ease-standard, ease); }
.live-glyph text { fill: #12233b !important; }
.live-glyph.state-on [data-part=body], .live-glyph.engaged [data-part=body] { filter: drop-shadow(0 0 3.5px ${active}); }
.live-glyph.state-fault [data-part=body] { filter: drop-shadow(0 0 3.5px ${fault}); animation: x6-pulse 1.1s ease-in-out infinite; }
.live-glyph.state-unavailable { opacity: .4; }
.live-glyph.operator-selectable { cursor: pointer; }
.live-glyph.operator-selectable [data-part=body] { transition: filter var(--motion-selection, 170ms) var(--ease-standard, ease), opacity var(--motion-press, 130ms) var(--ease-standard, ease); }
.live-glyph.operator-selectable:hover [data-part=body] { filter: drop-shadow(0 0 5px #0f8063); }
.live-glyph.operator-selected [data-part=body] { filter: drop-shadow(0 0 7px #0f8063) drop-shadow(0 0 13px #0f8063) !important; }

/* Motion — live.spin. Part is drawn around its own centre, so this spins in
   place. Spins when live (engaged on a running route, or self-active). */
.live-glyph [data-part=spin] { transform-box: fill-box; transform-origin: center; }
.live-glyph.state-on [data-part=spin], .live-glyph.engaged [data-part=spin] { animation: x6-spin 1.1s linear infinite; }

/* Fill — live.fill. Height tracks --fill (0..1), bottom-anchored. */
.live-glyph [data-part=fill] { transform-box: fill-box; transform-origin: bottom; transform: scaleY(var(--fill, .5)); transition: transform var(--motion-camera, 260ms) var(--ease-standard, ease); }

/* Gate — live.gate. Recolours when open (live). Targets the part AND its child
   shapes, so a group whose paths carry their own fill/stroke still recolours. */
.live-glyph [data-part=gate], .live-glyph [data-part=gate] * { transition: fill var(--motion-selection, 170ms) var(--ease-standard, ease), stroke var(--motion-selection, 170ms) var(--ease-standard, ease), fill-opacity var(--motion-selection, 170ms) var(--ease-standard, ease); }
.live-glyph.state-on [data-part=gate], .live-glyph.state-on [data-part=gate] *,
.live-glyph.engaged [data-part=gate], .live-glyph.engaged [data-part=gate] * { fill: ${active}; stroke: ${active}; fill-opacity: .4; }

/* Value readout — an HTML overlay in *screen space* (a sibling layer X6's zoom
   transform never touches), so it stays crisp and a constant on-screen size at
   any zoom, and can never clip or rotate. positionLabels() places each one over
   its node; a layered dark text-shadow gives the halo (no SVG stroke needed). */
.live-label-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.value-label-html { position: absolute; top: 0; left: 0; will-change: transform; pointer-events: none; white-space: nowrap;
  font-weight: 700; font-size: ${SYMBOL.font.value}px; font-family: ${SYMBOL.font.family}; letter-spacing: .02em;
  color: #12233b; text-shadow: 0 0 2px #ffffff, 0 0 5px #ffffff, 0 1px 2px #ffffff; }
@media (prefers-reduced-motion: reduce) {
  .live-glyph.state-on [data-part=spin], .live-glyph.engaged [data-part=spin], .live-glyph.state-fault [data-part=body] { animation: none !important; }
  .live-glyph [data-part=body], .live-glyph [data-part=fill], .live-glyph [data-part=gate], .live-glyph [data-part=gate] * { transition: none !important; }
}`;
  document.head.appendChild(style);
}

function extractNodeData(node: TopologyNode): Record<string, unknown> {
  const { ports: _p, position: _pos, ...data } = node;
  return data;
}

/** Re-theme only the descriptor's explicit dark surface/text tokens. This keeps
 * semantic values such as `fill="none"` intact (notably the open tank shell),
 * unlike a blanket CSS fill override. */
function renderLiveGlyph(desc: NodeDescriptor, data: Record<string, unknown>): string {
  return desc.renderSvg(data)
    .replaceAll(UI_COLORS.bg, '#ffffff')
    .replaceAll(UI_COLORS.text, '#12233b');
}

/** The route overlay: nodes + pipes a route contributes, bucketed by its live
 *  state. An element in `nodes`/`pipes` is "engaged" (a running route) and reads
 *  live regardless of its own telemetry; an element in `faultNodes`/`faultPipes`
 *  belongs to a FAULTED route and reads fault. The whole path lights as one unit. */
export interface ActivePath {
  nodes: Set<string>;
  pipes: Set<string>;
  faultNodes: Set<string>;
  faultPipes: Set<string>;
}

export interface CanvasViewportInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export class LiveCanvas {
  /** Shared fit band — used by the structural auto-fit and the explicit fit button. */
  private static readonly FIT_OPTS = { padding: 48, maxScale: 1.4, minScale: 0.3 };

  private graph: Graph;
  private nodeIds = new Set<string>();
  /** Last runtime pushed, re-applied after each render so new nodes pick it up. */
  private runtime = new Map<string, NodeRuntime>();
  /** The route overlay (active + faulted nodes/pipes), re-applied after render. */
  private engaged: ActivePath = { nodes: new Set(), pipes: new Set(), faultNodes: new Set(), faultPipes: new Set() };
  /** What's actually on the DOM, so live updates only touch what changed (the
   *  runtime/path signals hand us fresh objects every shadow tick). The applied
   *  signature folds state + value + fill + engagement so any change repaints just that node. */
  private appliedNode = new Map<string, string>();
  /** pipeId → applied flow style ('flow' | 'fault' | 'rest'), so only edges whose
   *  membership changed get rewritten. */
  private appliedFlow = new Map<string, string>();
  /** Node-set signature of the last render — refit only when the structure changes,
   *  so live updates never yank the operator's pan/zoom. */
  private lastNodeSig = '';
  /** Screen-space HTML label overlay (a sibling layer outside X6's zoom transform)
   *  + per-node entries with their local anchor, so value readouts stay crisp and
   *  constant-size; positionLabels() maps each anchor through the view transform. */
  private labelLayer: HTMLDivElement;
  private labels = new Map<string, { el: HTMLDivElement; ax: number; ay: number }>();
  private selectableNodeIds = new Set<string>();
  private selectedNodeId: string | null = null;
  private safeInsets: CanvasViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private narrow = false;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private pinchActive = false;
  private pinchDistance = 0;
  private pinchCenter = { x: 0, y: 0 };
  private suppressNodeClickUntil = 0;

  constructor(private readonly container: HTMLElement, private readonly onNodeSelect?: (id: string) => void) {
    ensureLiveStyles();
    ensureLiveNodeRegistered();
    // X6 normalizes one-finger touch into its mouse-style panning path, but its
    // mousewheel plugin does not implement real two-finger touch pinch. Capture
    // multi-touch before X6 and zoom around the moving midpoint; single-touch is
    // left alone so X6 continues to own ordinary pan.
    container.addEventListener('touchstart', this.onTouchStart, { capture: true, passive: false });
    container.addEventListener('touchmove', this.onTouchMove, { capture: true, passive: false });
    container.addEventListener('touchend', this.onTouchEnd, { capture: true, passive: false });
    container.addEventListener('touchcancel', this.onTouchEnd, { capture: true, passive: false });
    this.graph = new Graph({
      container,
      width: container.clientWidth || 800,
      height: container.clientHeight || 600,
      async: false,
      interacting: false, // no drag, no magnet-connect
      panning: { enabled: true, eventTypes: ['leftMouseDown'] },
      // Plain wheel remains page scroll. Trackpad pinch arrives as ctrl+wheel,
      // giving touch users native-feeling zoom without hijacking scrolling.
      mousewheel: { enabled: true, modifiers: ['ctrl'], minScale: 0.3, maxScale: 3 },
      background: { color: '#eaf2f8' },
      grid: { visible: true, type: 'dot', args: [{ color: '#cbd9e8' }] },
    });
    // Screen-space label overlay: a sibling layer X6's zoom transform never touches,
    // so readouts stay crisp + constant-size. Reposition over the nodes on any view
    // change (pan / zoom / resize). The host is position:absolute, so inset-0 fits it.
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'live-label-layer';
    container.appendChild(this.labelLayer);
    const reposition = () => this.positionLabels();
    this.graph.on('scale', reposition);
    this.graph.on('translate', reposition);
    this.graph.on('resize', reposition);
    this.graph.on('node:click', ({ node }) => {
      if (Date.now() < this.suppressNodeClickUntil) return;
      const raw = String(node.id);
      const id = raw.startsWith('node-') ? raw.slice('node-'.length) : raw;
      if (this.selectableNodeIds.has(id)) this.onNodeSelect?.(id);
    });
  }

  /** Re-place every HTML label over its node, mapping the node's local anchor
   *  (bottom-centre) through the current view transform. The +6px is a constant
   *  screen-space gap below the glyph. */
  private positionLabels(): void {
    const m = this.graph.matrix();
    for (const { el, ax, ay } of this.labels.values()) {
      el.style.transform = `translate(${ax * m.a + m.e}px, ${ay * m.d + m.f}px) translate(-50%, 6px)`;
    }
  }

  /** Create a node's HTML value label, anchored to its bottom-centre (local coords). */
  private addLabel(id: string, pos: { x: number; y: number }, size: { width: number; height: number }): void {
    const el = document.createElement('div');
    el.className = 'value-label-html';
    el.style.display = 'none'; // shown once it carries a reading
    this.labelLayer.appendChild(el);
    this.labels.set(id, { el, ax: pos.x + size.width / 2, ay: pos.y + size.height });
  }

  /** Reconcile the rendered topology without replacing unchanged cells. Stable
   *  cell identity is important here: telemetry, route/fault paint, selection and
   *  camera state are independent layers and must survive an ordinary topology
   *  refresh. A cell is replaced only when its own kind/ports/endpoints change.
   *  The optional `controllers` draws the same ownership overlays as the editor. */
  render(topology: RenderableTopology, controllers?: ControllerOverlayOptions): void {
    const desiredNodes = new Map<string, {
      node: TopologyNode;
      desc: NodeDescriptor;
      pos: { x: number; y: number };
      ports: PortItem[];
      portSig: string;
      glyphMarkup: string;
    }>();
    const desiredPipes = new Map<string, {
      pipeId: string;
      fromNode: string;
      fromPort: string;
      toNode: string;
      toPort: string;
      sig: string;
    }>();

    topology.nodes.forEach((node, index) => {
      const desc = NODE_REGISTRY.get(node.kind);
      if (!desc || node.disabled) return;
      const pos = node.position ?? { x: (index % 4) * 160 + 50, y: Math.floor(index / 4) * 120 + 50 };
      const ports = this.portsFor(node);
      desiredNodes.set(node.id, {
        node,
        desc,
        pos,
        ports,
        portSig: JSON.stringify(ports),
        glyphMarkup: renderLiveGlyph(desc, extractNodeData(node)),
      });
    });

    for (const pipe of topology.pipes) {
      const [fromNode, fromPort] = pipe.from.split(':');
      const [toNode, toPort] = pipe.to.split(':');
      if (!fromNode || !fromPort || !toNode || !toPort) continue;
      if (!desiredNodes.has(fromNode) || !desiredNodes.has(toNode)) continue;
      desiredPipes.set(pipe.id, {
        pipeId: pipe.id,
        fromNode,
        fromPort,
        toNode,
        toPort,
        sig: `${fromNode}:${fromPort}>${toNode}:${toPort}`,
      });
    }

    this.graph.startBatch('render');

    // Remove only cells that no longer belong to the topology. Controller
    // overlays are reconciled separately by renderControllerOverlays().
    for (const cell of this.graph.getCells()) {
      const id = String(cell.id);
      if (id.startsWith('node-') && !desiredNodes.has(id.slice(5))) cell.remove();
      if (id.startsWith('pipe-') && !desiredPipes.has(id.slice(5))) cell.remove();
    }

    this.nodeIds = new Set(desiredNodes.keys());
    for (const [id, desired] of desiredNodes) {
      const cellId = `node-${id}`;
      const existing = this.graph.getCellById(cellId);
      const previous = existing?.isNode() ? existing.getData() as Record<string, unknown> | undefined : undefined;
      const mustReplace = !existing?.isNode()
        || previous?.['liveKind'] !== desired.node.kind
        || previous?.['livePortSig'] !== desired.portSig;

      if (mustReplace) {
        existing?.remove();
        const config = buildLiveNodeConfig(
          desired.desc,
          id,
          desired.pos.x,
          desired.pos.y,
          desired.ports,
          desired.node.anchorId,
        );
        config.data = {
          anchorId: desired.node.anchorId,
          liveKind: desired.node.kind,
          livePortSig: desired.portSig,
          liveGlyphMarkup: desired.glyphMarkup,
        };
        const nodeCell = this.graph.addNode(config);
        this.injectGlyph(nodeCell, desired.glyphMarkup);
        this.appliedNode.delete(id);
      } else {
        const nodeCell = existing;
        const current = nodeCell.getPosition();
        if (current.x !== desired.pos.x || current.y !== desired.pos.y) {
          nodeCell.setPosition(desired.pos.x, desired.pos.y);
        }
        nodeCell.setData({
          anchorId: desired.node.anchorId,
          liveKind: desired.node.kind,
          livePortSig: desired.portSig,
          liveGlyphMarkup: desired.glyphMarkup,
        }, { overwrite: true });
        if (previous?.['liveGlyphMarkup'] !== desired.glyphMarkup) {
          this.injectGlyph(nodeCell, desired.glyphMarkup);
          this.appliedNode.delete(id);
        }
      }

      const label = this.labels.get(id);
      if (desired.desc.live?.value) {
        if (label) {
          label.ax = desired.pos.x + desired.desc.size.width / 2;
          label.ay = desired.pos.y + desired.desc.size.height;
        } else {
          this.addLabel(id, desired.pos, desired.desc.size);
        }
      } else if (label) {
        label.el.remove();
        this.labels.delete(id);
      }
    }

    for (const [id, entry] of [...this.labels]) {
      if (desiredNodes.has(id)) continue;
      entry.el.remove();
      this.labels.delete(id);
    }
    for (const id of [...this.appliedNode.keys()]) {
      if (!desiredNodes.has(id)) this.appliedNode.delete(id);
    }

    for (const desired of desiredPipes.values()) {
      const cellId = `pipe-${desired.pipeId}`;
      const existing = this.graph.getCellById(cellId);
      const previous = existing?.isEdge() ? existing.getData() as Record<string, unknown> | undefined : undefined;
      if (!existing?.isEdge() || previous?.['livePipeSig'] !== desired.sig) {
        existing?.remove();
        const config = buildEdgeConfig(
          cellId,
          `node-${desired.fromNode}`,
          desired.fromPort,
          `node-${desired.toNode}`,
          desired.toPort,
        );
        config['data'] = { livePipeSig: desired.sig };
        this.graph.addEdge(config);
        this.appliedFlow.delete(desired.pipeId);
      }
    }

    for (const id of [...this.appliedFlow.keys()]) {
      if (!desiredPipes.has(id)) this.appliedFlow.delete(id);
    }

    // Controller boxes + dashed wires to their owned nodes (same shared renderer
    // the editor uses). Drawn before stopBatch so they're part of this reconcile.
    if (controllers) {
      renderControllerOverlays(this.graph, controllers);
    } else {
      for (const cell of this.graph.getCells()) {
        const id = String(cell.id);
        if (id.startsWith('controller-') || id.startsWith('wire-')) cell.remove();
      }
    }

    this.graph.stopBatch('render');
    this.applyRuntime(); // newly added nodes need current state
    this.applyFlow();
    this.applySelection();

    // Refit only when the topology's node set actually changed, so a re-render
    // driven by anything else leaves the operator's pan/zoom untouched.
    const sig = [...this.nodeIds].sort().join(',');
    if (sig !== this.lastNodeSig) {
      this.lastNodeSig = sig;
      this.fitInitialCamera();
    }
    this.positionLabels(); // place labels for this render (fit also fires events)
  }

  /** Push the per-node telemetry projection (state / value / fill). */
  setState(runtime: Map<string, NodeRuntime>): void {
    this.runtime = runtime;
    this.applyRuntime();
  }

  /** Push the engaged path (running routes' nodes + pipes). Lights the whole path:
   *  pipes flow, and path nodes read live even if their own telemetry is idle. */
  setActivePath(path: ActivePath): void {
    this.engaged = path;
    this.applyRuntime(); // node engagement rides the per-node paint
    this.applyFlow();
  }

  /** Mark the nodes that open manual control. Selection is explicit: clicking
   *  tanks/sensors still pans the canvas and can never dispatch a command. */
  setSelectableNodes(ids: Set<string>): void {
    this.selectableNodeIds = new Set(ids);
    this.applySelection();
  }

  setSelectedNode(id: string | null): void {
    const changed = this.selectedNodeId !== id;
    this.selectedNodeId = id;
    this.applySelection();
    if (id && changed) this.revealNode(id);
  }

  /** The operator shell owns overlays; the graph only needs their occluded
   *  viewport edges. Updating these insets never rebuilds cells or repaints the
   *  active route. A selected entity is nudged only if the new overlay hides it. */
  setSafeViewportInsets(insets: Partial<CanvasViewportInsets>): void {
    this.safeInsets = {
      top: Math.max(0, insets.top ?? 0),
      right: Math.max(0, insets.right ?? 0),
      bottom: Math.max(0, insets.bottom ?? 0),
      left: Math.max(0, insets.left ?? 0),
    };
    if (this.selectedNodeId) this.revealNode(this.selectedNodeId);
  }

  resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const wasNarrow = this.narrow;
    this.viewportWidth = w;
    this.viewportHeight = h;
    // Tablet widths, including the 730px target, fit the whole topology. Only
    // true phone widths apply the readable-scale/pan camera profile.
    this.narrow = w < 520;
    this.graph.resize(w, h);
    // Preserve an operator-moved camera during ordinary resize. Reframe only
    // when moving between the complete-topology and readable-phone profiles.
    if (this.nodeIds.size && wasNarrow !== this.narrow) this.fitInitialCamera();
  }

  /** Explicit zoom controls (wheel-zoom is locked). Step is a relative delta;
   *  X6 clamps to the same scale band the fit uses. */
  zoomIn(): void { this.graph.zoom(0.2, { minScale: 0.3, maxScale: 3 }); }
  zoomOut(): void { this.graph.zoom(-0.2, { minScale: 0.3, maxScale: 3 }); }
  fit(): void { this.fitCompleteTopology(); }

  destroy(): void {
    this.container.removeEventListener('touchstart', this.onTouchStart, true);
    this.container.removeEventListener('touchmove', this.onTouchMove, true);
    this.container.removeEventListener('touchend', this.onTouchEnd, true);
    this.container.removeEventListener('touchcancel', this.onTouchEnd, true);
    this.labelLayer.remove();
    this.graph.dispose();
  }

  // --- private ---

  /** Desktop shows the whole topology. A narrow viewport keeps the exact same
   *  graph but applies a readable camera floor: the edges may begin off-screen
   *  and remain reachable by pan instead of shrinking every control to dust. */
  private fitInitialCamera(): void {
    if (!this.narrow) {
      this.fitCompleteTopology();
      return;
    }
    this.graph.zoomToFit({ padding: this.fitPadding(24), maxScale: 1.1, minScale: 0.58 });
    const focus = this.selectedNodeId
      ?? [...this.engaged.nodes].find((id) => this.nodeIds.has(id));
    if (focus) this.revealNode(focus);
  }

  private fitCompleteTopology(): void {
    this.graph.zoomToFit({ ...LiveCanvas.FIT_OPTS, padding: this.fitPadding(48) });
  }

  private fitPadding(base: number): { top: number; right: number; bottom: number; left: number } {
    return {
      top: base + this.safeInsets.top,
      right: base + this.safeInsets.right,
      bottom: base + this.safeInsets.bottom,
      left: base + this.safeInsets.left,
    };
  }

  /** Keep the current scale and pan only as far as needed to expose the selected
   *  glyph. This is deliberately not `centerCell`: opening an inspector should
   *  not throw away the operator's spatial context. */
  private revealNode(id: string): void {
    const node = this.graph.getCellById(`node-${id}`);
    if (!node?.isNode()) return;
    const host = this.graph.container.getBoundingClientRect();
    const box = this.graph.localToClient(node.getBBox());
    const margin = 18;
    const visible = {
      left: host.left + this.safeInsets.left + margin,
      top: host.top + this.safeInsets.top + margin,
      right: host.right - this.safeInsets.right - margin,
      bottom: host.bottom - this.safeInsets.bottom - margin,
    };
    let dx = 0;
    let dy = 0;
    if (box.x < visible.left) dx = visible.left - box.x;
    else if (box.x + box.width > visible.right) dx = visible.right - (box.x + box.width);
    if (box.y < visible.top) dy = visible.top - box.y;
    else if (box.y + box.height > visible.bottom) dy = visible.bottom - (box.y + box.height);
    if (dx || dy) this.graph.translateBy(dx, dy);
  }

  private applySelection(): void {
    for (const id of this.nodeIds) {
      const glyph = this.graph.findViewByCell(`node-${id}`)?.container.querySelector('.live-glyph');
      if (!glyph) continue;
      glyph.classList.toggle('operator-selectable', this.selectableNodeIds.has(id));
      glyph.classList.toggle('operator-selected', this.selectedNodeId === id);
    }
  }

  /** Port layout mirrors the editor (`x6-canvas.ts:toNodeConfig`) for parity. */
  private portsFor(node: TopologyNode): PortItem[] {
    const desc = NODE_REGISTRY.get(node.kind);
    const layout = desc?.portLayout;
    return (node.ports ?? []).map((p) => {
      const group = p.direction === 'inlet' ? 'inlet' : 'outlet';
      const override = layout?.[p.id];
      if (override && desc) {
        const x = group === 'inlet' ? 0 : desc.size.width;
        return { id: p.id, group: `${group}-abs`, args: { x, y: override.y } };
      }
      return { id: p.id, group };
    });
  }

  /**
   * Inject the descriptor's SVG (its `data-part` hooks become live DOM via
   * DOMParser + importNode — namespace-correct). The value readout is a separate
   * HTML overlay (see addLabel / positionLabels), not part of the glyph.
   */
  private injectGlyph(cell: Node, markup: string): void {
    const glyph = this.graph.findViewByCell(cell)?.container.querySelector('.live-glyph');
    if (!glyph) return;
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.nodeName === 'parsererror') return;
    glyph.replaceChildren(document.importNode(root, true));
  }

  private readonly onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 2) return;
    const [a, b] = [event.touches[0], event.touches[1]];
    this.pinchActive = true;
    this.pinchDistance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    this.pinchCenter = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    this.suppressNodeClickUntil = Date.now() + 350;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    if (!this.pinchActive) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.touches.length < 2) return;
    const [a, b] = [event.touches[0], event.touches[1]];
    const distance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    const center = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    if (this.pinchDistance > 0 && distance > 0) {
      const currentScale = this.graph.zoom();
      const nextScale = Math.max(0.3, Math.min(3, currentScale * distance / this.pinchDistance));
      const rect = this.container.getBoundingClientRect();
      this.graph.zoom(nextScale, {
        absolute: true,
        minScale: 0.3,
        maxScale: 3,
        center: { x: this.pinchCenter.x - rect.left, y: this.pinchCenter.y - rect.top },
      });
      this.graph.translateBy(center.x - this.pinchCenter.x, center.y - this.pinchCenter.y);
    }
    this.pinchDistance = distance;
    this.pinchCenter = center;
    this.suppressNodeClickUntil = Date.now() + 350;
  };

  private readonly onTouchEnd = (event: TouchEvent): void => {
    if (!this.pinchActive) return;
    this.suppressNodeClickUntil = Date.now() + 350;
    if (event.touches.length === 0) {
      // Let the final touchend bubble so X6 can terminate the one-finger pan it
      // began before the second finger entered the gesture.
      this.pinchActive = false;
      this.pinchDistance = 0;
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Paint each node's live state onto its glyph — the `state-*` class, the
   *  `engaged` class (on a running route), the `--fill` var (bounded values), and
   *  its HTML value readout. Skips nodes whose combined signature is unchanged,
   *  so a shadow / route tick only touches what moved. */
  private applyRuntime(): void {
    for (const id of this.nodeIds) {
      const rt = this.runtime.get(id);
      // A faulted route's path overrides the node's own telemetry (which carries no
      // fault) — the whole route reads red. Otherwise: engaged ⇒ live, else self-state.
      const faulted = this.engaged.faultNodes.has(id);
      const engaged = this.engaged.nodes.has(id);
      const state = faulted ? 'fault' : (rt?.state ?? 'unknown');
      const sig = `${state}|${engaged}|${rt?.value ?? ''}|${rt?.fill ?? ''}|${rt?.unit ?? ''}`;
      if (this.appliedNode.get(id) === sig) continue;
      // The `.live-glyph` group carries `data-node-id` + `kind-*`; the live
      // `state-*` / `engaged` classes ride the same element (the scada contract).
      const glyph = this.graph.findViewByCell(`node-${id}`)?.container.querySelector('.live-glyph');
      if (!glyph) continue;
      applyStateClass(glyph, state);
      glyph.classList.toggle('engaged', engaged);
      // Reset when null so a tank that loses its reading falls back to the CSS
      // default rather than freezing at its last level.
      if (rt?.fill != null) (glyph as SVGElement).style.setProperty('--fill', String(rt.fill));
      else (glyph as SVGElement).style.removeProperty('--fill');
      const entry = this.labels.get(id);
      if (entry) {
        const text = rt?.value != null ? formatReading(rt.value, rt.unit) : '';
        entry.el.textContent = text;
        entry.el.style.display = text ? '' : 'none';
      }
      this.appliedNode.set(id, sig);
    }
  }

  /** Style each pipe by its route membership: flowing (water-tinted, marching, via
   *  the editor's `x6-flow` keyframe), fault (solid red), or resting (static). Only
   *  edges whose membership changed are rewritten, so this stays cheap per tick.
   *  Controller wires (`wire-*`) are left to the overlay renderer — skipped here. */
  private applyFlow(): void {
    const FLOW = { line: { stroke: '#0284c7', strokeWidth: SYMBOL.stroke + 0.5, strokeDasharray: 8, style: { animation: 'x6-flow 20s infinite linear' } } };
    const FAULT = { line: { stroke: STATE_COLORS.fault, strokeWidth: SYMBOL.stroke + 0.5, strokeDasharray: 0, style: { animation: '' } } };
    const REST = { line: { stroke: '#93a49a', strokeWidth: SYMBOL.stroke, strokeDasharray: 0, style: { animation: '' } } };
    for (const edge of this.graph.getEdges()) {
      const id = String(edge.id);
      if (!id.startsWith('pipe-')) continue; // controller wires keep their own style
      const pipeId = id.slice('pipe-'.length);
      const sig = this.engaged.faultPipes.has(pipeId) ? 'fault'
        : this.engaged.pipes.has(pipeId) ? 'flow'
        : 'rest';
      if (this.appliedFlow.get(pipeId) === sig) continue;
      edge.setAttrs(sig === 'flow' ? FLOW : sig === 'fault' ? FAULT : REST);
      this.appliedFlow.set(pipeId, sig);
    }
  }
}
