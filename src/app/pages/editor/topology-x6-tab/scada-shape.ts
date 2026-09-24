/**
 * Converts a NodeDescriptor's renderSvg() output into a data URI
 * suitable for X6's image shape attrs.
 */
import { NODE_REGISTRY } from '../../../core/models/entities.model';
import { UI_COLORS } from '../../../core/models/colors.model';

export function svgDataUri(kind: string, data: Record<string, unknown>, activeControllerId?: string, importCount?: number): string {
  const desc = NODE_REGISTRY.get(kind);
  if (!desc) return '';
  let svg = desc.renderSvg(data);
  // Editor-only light presentation. The canonical glyph renderer remains
  // unchanged for firmware/docs exports; X6 gets white surfaces and dark labels.
  svg = svg
    .replaceAll(UI_COLORS.bg, '#ffffff')
    .replaceAll(UI_COLORS.text, '#12233b');
  if (data['disabled']) {
    // Wrap SVG content with reduced opacity for disabled entities
    svg = svg.replace(/^<svg([^>]*)>/, '<svg$1><g opacity="0.3">').replace(/<\/svg>\s*$/, '</g></svg>');
  }
  const anchorId = data['anchorId'] as string | undefined;
  const { width, height } = desc.size;
  let overlay = '';

  if (activeControllerId && anchorId && anchorId !== activeControllerId) {
    // Remote node — dashed border + satellite badge
    overlay += `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="4" fill="none" stroke="#6366f1" stroke-width="2" stroke-dasharray="4,3"/><text x="${width - 4}" y="10" text-anchor="end" font-size="8" fill="#6366f1" font-family="ui-monospace, monospace">&#x1F6F0;</text>`;
  }

  if (importCount && importCount > 0) {
    // Local node imported by other controllers — green dot indicator
    overlay += `<circle cx="${width - 6}" cy="6" r="4" fill="#10b981" stroke="white" stroke-width="1"/><text x="${width - 6}" y="8" text-anchor="middle" font-size="6" fill="white" font-family="ui-monospace, monospace" font-weight="bold">${importCount > 9 ? '9+' : importCount}</text>`;
  }

  if (overlay) {
    svg = svg.replace(/^<svg([^>]*)>/, `<svg$1><g>${overlay}</g>`);
  }

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
