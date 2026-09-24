/**
 * Framework-agnostic X6 topology canvas manager.
 * Owns Graph lifecycle. Knows nothing about Angular.
 * All entity-specific logic is driven by the NODE_REGISTRY.
 */
import { Graph, Shape } from '@antv/x6';
import { Export } from '@antv/x6-plugin-export';
import { History } from '@antv/x6-plugin-history';
import { Snapline } from '@antv/x6-plugin-snapline';
import type { Node, Edge as X6Edge } from '@antv/x6';
import { NODE_REGISTRY } from '../../../core/models/entities.model';
import { UI_COLORS } from '../../../core/models/colors.model';
import type { RenderableTopology, PipeSegment, TopologyNode } from '../../../core/models/topology.model';
import { buildNodeConfig, buildEdgeConfig, buildDragEdgeAttrs, MANHATTAN_ROUTER } from './x6-shapes';
import type { TopologyGraph } from '../shared/derive-routes';
import { pipesFromSource, pipesToDestination, connectedPipes, pipesAlongPath } from '@core';
import type { Selection } from '../shared/selection';

export type { Selection };

export interface CanvasEvents {
  onNodesMoved(positions: Map<string, { x: number; y: number }>): void;
  onPipeCreated(from: string, to: string): void;
  onPipeDeleted(pipeId: string): void;
  onSelected(selection: Selection | null): void;
  onDanglingPipe(from: string, graphPos: { x: number; y: number }, clientPos: { x: number; y: number }): void;
  /** Right-click / long-press on a node. `clientPos` is in viewport coords for menu placement. */
  onNodeContextMenu?(nodeId: string, clientPos: { x: number; y: number }): void;
}

// --- Helpers ---

interface NodeData { nodeId: string; kind: string; [k: string]: unknown }

function getNodeData(node: { getData: () => unknown }): NodeData | null {
  const d = node.getData() as Record<string, unknown> | undefined;
  if (d && typeof d['nodeId'] === 'string' && typeof d['kind'] === 'string') {
    return d as NodeData;
  }
  return null;
}

function extractNodeData(node: TopologyNode): Record<string, unknown> {
  // Pull out structural fields; the rest is entity data for renderSvg
  const { ports: _, position: __, ...data } = node;
  return data;
}

function stripPrefix(id: string, prefix: string): string | null {
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

// --- Inject flow animation CSS (once per document) ---

const FLOW_STYLE_ID = 'x6-flow-animation';
function ensureFlowStyles(): void {
  if (document.getElementById(FLOW_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FLOW_STYLE_ID;
  style.textContent = `@keyframes x6-flow { to { stroke-dashoffset: -1000; } }
@media (prefers-reduced-motion: reduce) { .x6-edge path { animation: none !important; } }`;
  document.head.appendChild(style);
}

// --- Canvas class ---

export class X6Canvas {
  private graph!: Graph;

  /** Expose the underlying X6 graph for overlays (boundary rects, etc). */
  get graphInstance(): Graph { return this.graph; }
  private history: History;
  private events: CanvasEvents;

  /** Active controller for remote-node styling. */
  activeControllerId?: string;
  /** Map of nodeId → count of other controllers importing this node. Used for canvas badges. */
  nodeImportCounts?: Map<string, number>;

  private nodeIds = new Set<string>();
  private positionTimer: ReturnType<typeof setTimeout> | null = null;
  private rendering = false;
  private highlightedEdges = new Set<string>();
  private highlightedNodes = new Set<string>();
  private disabledPipes = new Set<string>();

  constructor(container: HTMLElement, events: CanvasEvents, options?: { async?: boolean; grid?: boolean; background?: boolean }) {
    this.events = events;
    ensureFlowStyles();

    this.graph = new Graph({
      container,
      width: 800,
      height: 600,
      async: options?.async ?? true,
      grid: options?.grid === false
        ? { visible: false }
        // The editor uses the same light operational canvas as the live map.
        // Geometry and highlight layers are unchanged; this is presentation only.
        : { visible: true, type: 'dot', args: [{ color: '#cbd9e8' }] },
      background: options?.background === false
        ? false
        : { color: '#eaf2f8' },
      panning: { enabled: true, eventTypes: ['leftMouseDown'], modifiers: [] },
      mousewheel: { enabled: true, factor: 1.1, minScale: 0.2, maxScale: 3 },
      connecting: {
        allowBlank: false,
        allowMulti: false,
        allowLoop: false,
        allowNode: false,
        snap: { radius: 30 },
        router: MANHATTAN_ROUTER,
        connector: { name: 'rounded' },
        validateMagnet({ magnet }) {
          return magnet?.getAttribute('port-group')?.startsWith('outlet') ?? false;
        },
        validateConnection({ sourceCell, targetCell, targetMagnet }) {
          if (!sourceCell || !targetCell) return false;
          if (sourceCell.id === targetCell.id) return false;
          return targetMagnet?.getAttribute('port-group')?.startsWith('inlet') ?? false;
        },
        createEdge() {
          return new Shape.Edge(buildDragEdgeAttrs());
        },
      },
    });

    this.graph.use(new Snapline({ enabled: true }));
    this.graph.use(new Export());

    this.history = new History({ enabled: true });
    this.graph.use(this.history);

    this.wireEvents();
  }

  // --- Public API ---

  /** Toggle read-only mode: disables node dragging and port connections. Pan/zoom remain active. */
  setReadonly(readonly: boolean): void {
    this.graph.options.interacting = readonly
      ? { nodeMovable: false, magnetConnectable: false }
      : true;
  }

  /** Incrementally reconcile the graph with the topology. */
  render(topology: RenderableTopology): void {
    this.rendering = true;
    this.nodeIds.clear();

    const desiredNodes = new Map<string, Node.Metadata>();
    const desiredEdges = new Map<string, X6Edge.Metadata>();

    for (let i = 0; i < topology.nodes.length; i++) {
      const node = topology.nodes[i];
      const fallbackPos = { x: (i % 4) * 160 + 50, y: Math.floor(i / 4) * 120 + 50 };
      const cfg = this.toNodeConfig(node, fallbackPos);
      if (cfg) {
        desiredNodes.set(String(cfg.id), cfg);
        this.nodeIds.add(node.id);
      }
    }

    for (const pipe of topology.pipes) {
      const cfg = this.toEdgeConfig(pipe);
      if (cfg) desiredEdges.set(String(cfg['id']), cfg);
    }

    this.graph.startBatch('render');

    // Remove stale cells
    for (const cell of this.graph.getCells()) {
      const id = String(cell.id);
      if (cell.isNode() && !desiredNodes.has(id)) cell.remove();
      if (cell.isEdge() && !desiredEdges.has(id)) cell.remove();
    }

    // Add or update nodes
    for (const [id, cfg] of desiredNodes) {
      const existing = this.graph.getCellById(id);
      if (existing?.isNode()) {
        const pos = existing.getPosition();
        if (cfg.x != null && cfg.y != null && (pos.x !== cfg.x || pos.y !== cfg.y)) {
          existing.setPosition(cfg.x, cfg.y);
        }
        // Update data and re-render SVG via imageUrl
        existing.setData(cfg.data, { overwrite: true });
        if (cfg['imageUrl']) {
          existing.setAttrByPath('image/xlinkHref', cfg['imageUrl']);
        }
      } else {
        this.graph.addNode(cfg);
      }
    }

    // Collect disabled node IDs for pipe dimming
    const disabledNodeIds = new Set(
      topology.nodes.filter(n => n.disabled).map(n => n.id),
    );

    // Add or update edges — dim pipes touching disabled nodes
    for (const [id, cfg] of desiredEdges) {
      const existing = this.graph.getCellById(id);
      if (!existing) {
        this.graph.addEdge(cfg);
      } else if (existing.isEdge() && cfg['data']) {
        existing.setData(cfg['data'], { overwrite: true });
      }
    }
    // Track and style pipes touching disabled nodes
    this.disabledPipes.clear();
    for (const pipe of topology.pipes) {
      const fromNode = pipe.from.split(':')[0];
      const toNode = pipe.to.split(':')[0];
      const isDimmed = disabledNodeIds.has(fromNode) || disabledNodeIds.has(toNode);
      if (isDimmed) this.disabledPipes.add(pipe.id);
      const edge = this.graph.getCellById(`pipe-${pipe.id}`);
      if (edge?.isEdge()) {
        edge.setAttrs({
          line: {
            strokeOpacity: isDimmed ? 0.15 : 1,
            strokeDasharray: isDimmed ? '2,4' : 0,
          },
        });
      }
    }

    this.graph.stopBatch('render');
    this.rendering = false;
  }

  /** Full reset — used only for initial load. */
  reset(topology: RenderableTopology): void {
    this.graph.clearCells();
    this.render(topology);
    this.fitContent();
  }

  /** Highlight routes through the selected entity. */
  highlight(selection: Selection | null, tg: TopologyGraph): void {
    this.clearHighlights();
    if (!selection) return;

    if (selection.kind === 'pipe') {
      this.highlightEdge(selection.pipeId, UI_COLORS.selected, 3.5, 1);
      const connected = connectedPipes(tg, selection.pipeId);
      for (const pid of connected) {
        if (pid !== selection.pipeId) {
          this.highlightEdge(pid, UI_COLORS.selected, 2.5, 0.4, true);
        }
      }
    }

    if (selection.kind === 'route') {
      // Highlight the route's EXACT path, not every pipe between its endpoints —
      // otherwise parallel routes (same source/dest, different valves) all light up.
      const routePipes = pipesAlongPath(tg, selection.route.nodeSequence);
      for (const pid of routePipes) {
        this.highlightEdge(pid, UI_COLORS.selected, 2.5, 0.8, true);
      }
      for (const nid of selection.sharedNodeIds ?? []) {
        this.highlightNode(nid, UI_COLORS.warning);
      }
    }

    if (selection.kind === 'node') {
      if (!tg.hasNode(selection.nodeId)) return;
      const attrs = tg.getNodeAttributes(selection.nodeId);
      const desc = NODE_REGISTRY.get(attrs.kind);

      let pipeIds: string[];
      if (desc?.routeSource) {
        pipeIds = pipesFromSource(tg, selection.nodeId);
      } else if (desc?.role === 'terminal') {
        pipeIds = pipesToDestination(tg, selection.nodeId);
      } else {
        // Passthrough: find any edge touching this node, then trace connected
        pipeIds = [];
        tg.forEachEdge(selection.nodeId, (_edge, edgeAttrs) => {
          pipeIds.push(...connectedPipes(tg, edgeAttrs.pipeId));
        });
      }

      for (const pid of pipeIds) {
        this.highlightEdge(pid, UI_COLORS.selected, 2.5, 0.5, true);
      }
    }
  }

  undo(): void { this.history.undo(); }
  redo(): void { this.history.redo(); }
  zoomIn(): void { this.graph.zoom(0.2); }
  zoomOut(): void { this.graph.zoom(-0.2); }

  fitContent(): void {
    this.graph.zoomToFit({ padding: 40, maxScale: 1.5, minScale: 0.3 });
  }

  resize(w: number, h: number): void {
    if (w > 0 && h > 0) this.graph.resize(w, h);
  }

  getViewportCenter(): { x: number; y: number } {
    const { sx, sy } = this.graph.scale();
    const { tx, ty } = this.graph.translate();
    const area = this.graph.getGraphArea();
    return {
      x: Math.round((-tx + area.width / 2) / sx),
      y: Math.round((-ty + area.height / 2) / sy),
    };
  }

  /**
   * Export the current canvas as a self-contained SVG string with all images inlined.
   *
   * `viewBox` overrides X6's default `getContentBBox()`-derived viewBox. Pass it
   * when the default misses content — e.g. Manhattan-router intermediate points
   * live in the DOM but not in X6's cell model, so callers can measure the live
   * stage via `getBBox()` and pass the result here.
   */
  exportSvg(viewBox?: { x: number; y: number; width: number; height: number }): Promise<string> {
    return new Promise((resolve) => {
      this.graph.toSVG((svg: string) => {
        resolve(svg);
      }, {
        preserveDimensions: false,
        copyStyles: false,
        ...(viewBox ? { viewBox } : {}),
        beforeSerialize: (_svg: SVGSVGElement) => {
          // X6 renders nodes as <image xlink:href="data:image/svg+xml;charset=utf-8,...">
          // The export plugin's serializeImages skips data URIs, so these survive as-is.
          // Browsers won't render SVG-via-<image>-data-URI when printing to PDF.
          // Fix: decode each SVG data URI and inline its content as a <g>.
          const images = Array.from(_svg.querySelectorAll('image'));
          for (const img of images) {
            const href = img.getAttribute('xlink:href') || img.getAttribute('href') || '';
            if (!href.startsWith('data:image/svg+xml')) continue;

            const svgText = decodeURIComponent(href.replace(/^data:image\/svg\+xml[^,]*,/, ''));
            const parser = new DOMParser();
            const doc = parser.parseFromString(svgText, 'image/svg+xml');
            const innerSvg = doc.documentElement;

            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            // Position the inlined SVG at the same location as the <image>
            const x = img.getAttribute('x') || '0';
            const y = img.getAttribute('y') || '0';
            const w = img.getAttribute('width');
            const h = img.getAttribute('height');
            g.setAttribute('transform', `translate(${x},${y})`);

            // Copy the SVG viewBox scaling if dimensions differ
            const vb = innerSvg.getAttribute('viewBox');
            if (vb && w && h) {
              const [, , vw, vh] = vb.split(/[\s,]+/).map(Number);
              if (vw && vh) {
                const sx = parseFloat(w) / vw;
                const sy = parseFloat(h) / vh;
                if (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001) {
                  g.setAttribute('transform', `translate(${x},${y}) scale(${sx},${sy})`);
                }
              }
            }

            // Move all children from the parsed SVG into the <g>
            while (innerSvg.firstChild) {
              g.appendChild(innerSvg.firstChild);
            }

            img.parentNode!.replaceChild(g, img);
          }

          return _svg;
        },
      });
    });
  }

  destroy(): void {
    if (this.positionTimer) clearTimeout(this.positionTimer);
    this.graph.dispose();
  }

  // --- Private: event wiring ---

  private wireEvents(): void {
    this.graph.on('node:click', ({ node }) => {
      const data = getNodeData(node);
      if (data) this.events.onSelected({ kind: 'node', nodeId: data.nodeId });
    });

    this.graph.on('edge:click', ({ edge }) => {
      const pipeId = stripPrefix(String(edge.id), 'pipe-');
      if (pipeId) this.events.onSelected({ kind: 'pipe', pipeId });
    });

    this.graph.on('blank:click', () => {
      this.events.onSelected(null);
    });

    this.graph.on('node:contextmenu', ({ node, e }) => {
      const data = getNodeData(node);
      if (!data) return;
      this.events.onNodeContextMenu?.(data.nodeId, {
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
      });
    });

    this.graph.on('node:moved', () => {
      if (this.rendering) return;
      if (this.positionTimer) clearTimeout(this.positionTimer);
      this.positionTimer = setTimeout(() => this.persistNodePositions(), 300);
    });

    this.graph.on('edge:connected', ({ edge }) => {
      const src = edge.getSourceCellId();
      const srcPort = edge.getSourcePortId();
      const tgt = edge.getTargetCellId();
      const tgtPort = edge.getTargetPortId();
      edge.remove();
      if (!src || !tgt || !srcPort || !tgtPort) return;
      this.events.onPipeCreated(
        `${stripPrefix(src, 'node-') ?? src}:${srcPort}`,
        `${stripPrefix(tgt, 'node-') ?? tgt}:${tgtPort}`,
      );
    });

    this.graph.on('edge:removed', ({ edge }) => {
      if (this.rendering) return;
      if (stripPrefix(String(edge.id), 'pipe-')) return; // real pipe being deleted, not a drag edge
      const src = edge.getSourceCellId();
      const srcPort = edge.getSourcePortId();
      if (!src || !srcPort) return;
      const target = edge.getTargetPoint();
      if (!target) return;
      const clientPoint = this.graph.localToClient(target);
      this.events.onDanglingPipe(
        `${stripPrefix(src, 'node-') ?? src}:${srcPort}`,
        { x: Math.round(target.x), y: Math.round(target.y) },
        { x: Math.round(clientPoint.x), y: Math.round(clientPoint.y) },
      );
    });
  }

  // --- Private: config builders ---

  private toNodeConfig(node: TopologyNode, fallbackPos?: { x: number; y: number }): Node.Metadata | null {
    const desc = NODE_REGISTRY.get(node.kind);
    if (!desc) return null;
    const layout = desc.portLayout;
    const ports = (node.ports ?? []).map(p => {
      const group = p.direction === 'inlet' ? 'inlet' : 'outlet';
      const override = layout?.[p.id];
      if (override) {
        const x = group === 'inlet' ? 0 : desc.size.width;
        return { id: p.id, group: `${group}-abs`, args: { x, y: override.y } };
      }
      return { id: p.id, group };
    });
    const importCount = this.nodeImportCounts?.get(node.id);
    const pos = node.position ?? fallbackPos ?? { x: 50, y: 50 };
    return buildNodeConfig(desc, node.id, extractNodeData(node), pos.x, pos.y, ports, this.activeControllerId, importCount);
  }

  private toEdgeConfig(pipe: PipeSegment): X6Edge.Metadata | null {
    const [fromNode, fromPort] = pipe.from.split(':');
    const [toNode, toPort] = pipe.to.split(':');
    if (!fromNode || !fromPort || !toNode || !toPort) return null;
    if (!this.nodeIds.has(fromNode) || !this.nodeIds.has(toNode)) return null;
    return buildEdgeConfig(`pipe-${pipe.id}`, `node-${fromNode}`, fromPort, `node-${toNode}`, toPort);
  }

  private persistNodePositions(): void {
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of this.graph.getNodes()) {
      const data = getNodeData(node);
      if (!data) continue;
      const pos = node.getPosition();
      positions.set(data.nodeId, { x: Math.round(pos.x), y: Math.round(pos.y) });
    }
    if (positions.size > 0) this.events.onNodesMoved(positions);
  }

  private highlightEdge(pipeId: string, color: string, width: number, opacity: number, animate = false): void {
    const edge = this.graph.getCellById(`pipe-${pipeId}`);
    if (!edge?.isEdge()) return;

    edge.setAttrs({
      line: {
        stroke: color, strokeWidth: width, strokeOpacity: opacity,
        ...(animate ? {
          strokeDasharray: 5,
          style: { animation: 'x6-flow 30s infinite linear' },
        } : {}),
      },
    });
    this.highlightedEdges.add(pipeId);
  }

  private clearHighlights(): void {
    for (const pid of this.highlightedEdges) {
      const edge = this.graph.getCellById(`pipe-${pid}`);
      if (edge?.isEdge()) {
        const isDimmed = this.disabledPipes.has(pid);
        edge.setAttrs({
          line: {
            stroke: UI_COLORS.pipe,
            strokeWidth: 2.5,
            strokeOpacity: isDimmed ? 0.15 : 1,
            strokeDasharray: isDimmed ? '2,4' : 0,
            style: { animation: '' },
          },
        });
        edge.removeTools();
      }
    }
    this.highlightedEdges.clear();

    for (const nid of this.highlightedNodes) {
      const node = this.graph.getCellById(`node-${nid}`);
      if (node?.isNode()) node.removeTools();
    }
    this.highlightedNodes.clear();
  }

  private highlightNode(nodeId: string, color: string): void {
    const node = this.graph.getCellById(`node-${nodeId}`);
    if (!node?.isNode()) return;
    node.addTools([{
      name: 'boundary',
      args: { padding: 6, attrs: { fill: 'none', stroke: color, strokeWidth: 2.5, strokeDasharray: '5,3' } },
    }]);
    this.highlightedNodes.add(nodeId);
  }
}
