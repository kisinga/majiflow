/**
 * Dashboard layout model — pure TS, no Angular imports, unit-testable.
 *
 * A layout is an ordered list of {@link LayoutItem}s (array position = render
 * order). Layouts are stored as JSON in the `dashboard_layouts` PocketBase
 * collection and mirrored to localStorage for instant paint; both paths parse
 * through {@link parseLayout}, which rejects ANY corruption — or a stale
 * schema version — so callers fall back to the auto-derived default layout
 * instead of rendering garbage (or a hierarchy we've since corrected).
 */

export interface LayoutItem {
  /** Registry def id (e.g. 'tank', 'route-card', 'live-map'). */
  widgetId: string;
  /** Unique per placed widget (e.g. 'widget/pump-ctrl/tank1_level', 'route/pump-ctrl/0'). */
  instanceId: string;
  /** Of 12 grid columns: 4 = ⅓, 6 = ½, 12 = full. */
  w: 4 | 6 | 12;
  hidden: boolean;
  /** Zone label the grid renders as a section header. NOT stored — the shell
   *  derives it from the widget id (WIDGET_ZONE in default-layout.ts) so every
   *  layout, stored or fresh, renders its labels; it only rides along on
   *  items at render time. */
  section?: string;
}

const WIDTHS = new Set([4, 6, 12]);
const OPERATIONAL_WIDGETS = new Set(['route-card', 'live-map']);
const reportingOnly = (items: LayoutItem[]): LayoutItem[] =>
  items.filter((item) => !OPERATIONAL_WIDGETS.has(item.widgetId));

/** Stored-blob schema version. Bump when the curated default hierarchy changes
 *  in a way that should reset saved layouts: stale versions fail parsing and
 *  every viewer falls back to the new default (their widgets, our order). */
export const LAYOUT_VERSION = 2;

/**
 * Validate an unknown blob as a layout. Returns null on any corruption —
 * wrong shape, wrong version, non-array items, missing/wrong-typed fields,
 * unknown width, duplicate instanceIds (they crash the grid's `@for track`
 * with NG0955) — so the caller falls back to the auto-derived layout.
 */
export function parseLayout(json: unknown): LayoutItem[] | null {
  if (typeof json !== 'object' || json === null) return null;
  const blob = json as Record<string, unknown>;
  const version = blob['v'];
  if ((version !== 1 && version !== LAYOUT_VERSION) || !Array.isArray(blob['items'])) return null;
  const out: LayoutItem[] = [];
  const seen = new Set<string>();
  for (const it of blob['items']) {
    if (typeof it !== 'object' || it === null) return null;
    const o = it as Record<string, unknown>;
    if (typeof o['widgetId'] !== 'string' || !o['widgetId']) return null;
    if (typeof o['instanceId'] !== 'string' || !o['instanceId']) return null;
    if (typeof o['w'] !== 'number' || !WIDTHS.has(o['w'])) return null;
    if (typeof o['hidden'] !== 'boolean') return null;
    if (seen.has(o['instanceId'])) return null;
    seen.add(o['instanceId']);
    // Version 1 was a mixed operator/reporting dashboard. Operations now owns
    // routes and the live topology, so those instances never enter Insights.
    if (version === 1 && (o['widgetId'] === 'route-card' || o['widgetId'] === 'live-map')) continue;
    out.push({ widgetId: o['widgetId'], instanceId: o['instanceId'], w: o['w'] as 4 | 6 | 12, hidden: o['hidden'] });
  }
  return out;
}

/** Serialize for storage (PocketBase JSON field / localStorage). Section labels
 *  are stripped — zones are derived from the widget id at render time. */
export function serializeLayout(items: LayoutItem[]): string {
  return JSON.stringify({
    v: LAYOUT_VERSION,
    items: items.map(({ widgetId, instanceId, w, hidden }) => ({ widgetId, instanceId, w, hidden })),
  });
}

/**
 * Merge a stored layout with the freshly auto-derived one. The stored layout
 * wins on order, widths and visibility for every instance it knows; any
 * derived REPORTING instance missing from the stored layout is appended (in
 * derived order, with its derived visibility) so a widget that appears after a
 * save is never silently invisible. Route cards and the live map belong to the
 * fixed Operate workspace, so they are stripped from both sides of the merge —
 * including already-persisted v2 rows.
 */
export function resolveLayout(stored: LayoutItem[] | null, derived: LayoutItem[]): LayoutItem[] {
  const reportingDerived = reportingOnly(derived);
  if (!stored) return reportingDerived;
  const reportingStored = reportingOnly(stored);
  const known = new Set(reportingStored.map((i) => i.instanceId));
  return [...reportingStored, ...reportingDerived.filter((i) => !known.has(i.instanceId))];
}

// --- Edit-mode helpers (pure; the grid and its tests share them) ------------

/** Move the item at `from` to `to` (array position = render order). Out-of-range
 *  indices clamp; a no-op returns the same array. */
export function moveItem(items: LayoutItem[], from: number, to: number): LayoutItem[] {
  const clamp = (n: number) => Math.max(0, Math.min(items.length - 1, n));
  const f = clamp(from);
  const t = clamp(to);
  if (f === t) return items;
  const out = [...items];
  const [moved] = out.splice(f, 1);
  out.splice(t, 0, moved);
  return out;
}

/** The width control's cycle: ⅓ → ½ → full → ⅓. */
export function cycleWidth(w: 4 | 6 | 12): 4 | 6 | 12 {
  return w === 4 ? 6 : w === 6 ? 12 : 4;
}

/**
 * Pick the effective layout from a site's `dashboard_layouts` rows: the user's
 * personal override (user = uid) beats the shared site default (user = '').
 * Rows with an unparseable layout fall through to the next candidate.
 */
export function pickEffectiveLayout(
  rows: { user?: string; layout?: unknown }[],
  uid: string,
): LayoutItem[] | null {
  const candidates = [
    ...(uid ? rows.filter((r) => r.user === uid) : []),
    ...rows.filter((r) => !r.user),
  ];
  for (const r of candidates) {
    const items = parseLayout(r.layout);
    if (items) return items;
  }
  return null;
}
