/**
 * X6 shape and port configuration factories.
 * Nodes use the built-in 'image' shape with SVG data URIs from NodeDescriptor.renderSvg().
 */
import { Shape } from '@antv/x6';
import type { Node, Edge } from '@antv/x6';
import type { NodeDescriptor } from '../../../core/models/entities.model';
import { UI_COLORS } from '../../../core/models/colors.model';
import { SYMBOL } from '@core';
import { svgDataUri } from './scada-shape';

// --- Shared router config (used by edges and drag connections) ---

export const MANHATTAN_ROUTER = {
  name: 'manhattan' as const,
  args: {
    step: 10,
    padding: { top: 20, right: 20, bottom: 20, left: 20 },
    excludeTerminals: ['source', 'target'],
    startDirections: ['right'],
    endDirections: ['left'],
  },
};

// --- Port groups ---

const portGroup = (side: 'left' | 'right') => ({
  position: side,
  attrs: {
    circle: { r: SYMBOL.port, fill: '#ffffff', stroke: '#64748b', strokeWidth: 2, magnet: true },
    text: { fontSize: 9, fill: '#475569' },
  },
  label: { position: side },
});

export const PORT_GROUPS = {
  inlet: portGroup('left'),
  outlet: portGroup('right'),
  'inlet-abs': { ...portGroup('left'), position: 'absolute' as const },
  'outlet-abs': { ...portGroup('right'), position: 'absolute' as const },
};

// --- Port spacing ---

export type PortItem = { id: string; group: string; args?: { x?: number; y?: number } };

export function spacePorts(ports: PortItem[], nodeHeight: number): PortItem[] {
  const byGroup = new Map<string, PortItem[]>();
  for (const p of ports) {
    const list = byGroup.get(p.group) ?? [];
    list.push(p);
    byGroup.set(p.group, list);
  }

  const result: PortItem[] = [];
  for (const [, items] of byGroup) {
    if (items.length <= 1) {
      result.push(...items);
    } else {
      items.forEach((p, i) => {
        if (p.args?.y != null) {
          result.push(p);
        } else {
          result.push({ ...p, args: { y: ((i + 1) / (items.length + 1)) * nodeHeight } });
        }
      });
    }
  }
  return result;
}

// --- Node config ---

export function buildNodeConfig(
  desc: NodeDescriptor,
  id: string,
  nodeData: Record<string, unknown>,
  x: number,
  y: number,
  ports: PortItem[],
  activeControllerId?: string,
  importCount?: number,
): Node.Metadata {
  const { width, height } = desc.size;
  return {
    id: `node-${id}`,
    shape: 'image',
    x,
    y,
    width,
    height,
    imageUrl: svgDataUri(desc.kind, nodeData, activeControllerId, importCount),
    ports: { groups: PORT_GROUPS, items: spacePorts(ports, height) },
    data: { nodeId: id, kind: desc.kind, ...nodeData },
  };
}

// --- Edge config ---

export interface EdgeHaData {
  pipeId: string;
  fromEntity?: string;
  toEntity?: string;
  flowWhen?: string;
}

export function buildEdgeConfig(
  id: string,
  sourceCell: string,
  sourcePort: string,
  targetCell: string,
  targetPort: string,
  data?: EdgeHaData,
): Edge.Metadata {
  return {
    id,
    shape: 'edge',
    source: { cell: sourceCell, port: sourcePort },
    target: { cell: targetCell, port: targetPort },
    attrs: {
      line: {
        stroke: UI_COLORS.pipe,
        strokeWidth: SYMBOL.stroke,
        targetMarker: { name: 'classic', size: 8 },
      },
    },
    router: MANHATTAN_ROUTER,
    connector: { name: 'rounded' },
    ...(data ? { data } : {}),
  };
}

// --- Drag edge (in-progress connections) ---

export function buildDragEdgeAttrs(): Edge.Metadata {
  return {
    attrs: {
      line: {
        stroke: UI_COLORS.pipe,
        strokeWidth: SYMBOL.stroke,
        strokeDasharray: '8,4',
        targetMarker: { name: 'classic', size: 8 },
      },
    },
    router: MANHATTAN_ROUTER,
    connector: { name: 'rounded' },
  };
}
