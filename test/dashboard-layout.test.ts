/**
 * Dashboard layout model (src/app/widgets/layout.ts): parseLayout rejects any
 * corruption or stale schema version so callers fall back to the auto-derived
 * layout; resolveLayout lets the stored layout win while appending
 * newly-derived instances; section labels are a render-time concern (the
 * shell derives them from the widget id), never stored.
 *
 * Usage: npx tsx test/dashboard-layout.test.ts
 */
import { parseLayout, serializeLayout, resolveLayout, moveItem, cycleWidth, pickEffectiveLayout, LAYOUT_VERSION, type LayoutItem } from "../src/app/widgets/layout";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string, detail?: string) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); failed++; }
}

console.log("Dashboard layout model");
console.log("======================\n");

const VALID: LayoutItem[] = [
  { widgetId: "live-map", instanceId: "live-map", w: 12, hidden: false },
  { widgetId: "route-card", instanceId: "route/pump-ctrl/0", w: 4, hidden: true },
  { widgetId: "tank", instanceId: "widget/pump-ctrl/tank1_level", w: 6, hidden: false },
];
const wrap = (items: unknown, v = LAYOUT_VERSION) => ({ v, items });

// --- parseLayout: valid input ------------------------------------------------
{
  const out = parseLayout(JSON.parse(JSON.stringify(wrap(VALID))));
  assert(out !== null && out.length === 3, "parses a valid layout");
  assert(JSON.stringify(out) === JSON.stringify(VALID), "preserves order, widths, hidden flags");
  const empty = parseLayout(wrap([]));
  assert(empty !== null && empty.length === 0, "empty items is a valid (empty) layout");
}

// --- v1 → v2 migration: reporting survives, operator widgets move out --------
{
  const migrated = parseLayout({ v: 1, items: VALID });
  assert(migrated?.length === 1 && migrated[0].widgetId === 'tank', 'v1 migration drops route/map instances');
  assert(migrated?.[0].w === 6 && migrated[0].hidden === false, 'v1 migration preserves supported widget width/visibility');
}

// --- parseLayout: corruption / staleness → null --------------------------------
{
  assert(parseLayout(null) === null, "rejects null");
  assert(parseLayout(undefined) === null, "rejects undefined");
  assert(parseLayout("not json") === null, "rejects a string");
  assert(parseLayout(42) === null, "rejects a number");
  assert(parseLayout(VALID) === null, "rejects a bare (unversioned) array");
  assert(parseLayout(wrap(VALID, 0)) === null, "rejects a stale schema version");
  assert(parseLayout(wrap(VALID, LAYOUT_VERSION + 1)) === null, "rejects a future schema version");
  assert(parseLayout({ v: LAYOUT_VERSION }) === null, "rejects missing items");
  assert(parseLayout({ items: VALID }) === null, "rejects missing version");
  assert(parseLayout(wrap([null])) === null, "rejects null items");
  assert(parseLayout(wrap([{ instanceId: "x", w: 4, hidden: false }])) === null, "rejects missing widgetId");
  assert(parseLayout(wrap([{ widgetId: "tank", w: 4, hidden: false }])) === null, "rejects missing instanceId");
  assert(parseLayout(wrap([{ widgetId: "tank", instanceId: "x", hidden: false }])) === null, "rejects missing w");
  assert(parseLayout(wrap([{ widgetId: "tank", instanceId: "x", w: 4 }])) === null, "rejects missing hidden");
  assert(parseLayout(wrap([{ widgetId: "tank", instanceId: "x", w: 5, hidden: false }])) === null, "rejects unknown width 5");
  assert(parseLayout(wrap([{ widgetId: "tank", instanceId: "x", w: "4", hidden: false }])) === null, "rejects string width");
  assert(parseLayout(wrap([{ widgetId: "", instanceId: "x", w: 4, hidden: false }])) === null, "rejects empty widgetId");
  assert(parseLayout(wrap([{ widgetId: "tank", instanceId: "x", w: 4, hidden: 0 }])) === null, "rejects non-boolean hidden");
  // One bad item poisons the whole blob (partial layouts misrender).
  assert(parseLayout(wrap([...VALID, { widgetId: "tank" }])) === null, "one corrupt item rejects the whole layout");
  // Duplicate instanceIds crash the grid's @for track (NG0955) — reject outright.
  assert(parseLayout(wrap([VALID[0], VALID[1], VALID[0]])) === null, "duplicate instanceIds reject the whole layout");
}

// --- serialize/parse round-trip -------------------------------------------------
{
  const blob = JSON.parse(serializeLayout(VALID)) as Record<string, unknown>;
  assert(blob["v"] === LAYOUT_VERSION && Array.isArray(blob["items"]), "serialize emits the versioned wrapper");
  const round = parseLayout(JSON.parse(serializeLayout(VALID)));
  assert(JSON.stringify(round) === JSON.stringify(VALID), "serialize → parse round-trips");
}

// --- resolveLayout -----------------------------------------------------------------
{
  const derived: LayoutItem[] = [
    { widgetId: "live-map", instanceId: "live-map", w: 12, hidden: false },
    { widgetId: "route-card", instanceId: "route/pump-ctrl/0", w: 4, hidden: false },
    { widgetId: "tank", instanceId: "widget/pump-ctrl/tank1_level", w: 4, hidden: false },
    { widgetId: "timeline", instanceId: "widget/pump-ctrl/activity", w: 12, hidden: false },
  ];
  const automatic = resolveLayout(null, derived);
  assert(automatic.map((i) => i.widgetId).join(',') === 'tank,timeline', "null stored → reporting-only derived layout");

  // Stored wins: order, width and visibility come from the stored rows.
  const stored: LayoutItem[] = [
    { widgetId: "tank", instanceId: "widget/pump-ctrl/tank1_level", w: 6, hidden: true },
    { widgetId: "live-map", instanceId: "live-map", w: 12, hidden: false },
  ];
  const out = resolveLayout(stored, derived)!;
  assert(out[0].instanceId === "widget/pump-ctrl/tank1_level" && out[1].instanceId === "widget/pump-ctrl/activity",
    "stored order wins over derived order");
  assert(out[0].w === 6 && out[0].hidden === true, "stored width/visibility win over derived");
  assert(!out.some((item) => item.widgetId === 'live-map' || item.widgetId === 'route-card'),
    "operator map/routes cannot re-enter Insights during merge");

  // New derived instances (a widget that appeared after the layout was saved)
  // append rather than going invisible, honoring the derived visibility.
  assert(out.length === 2 && out[1].instanceId === "widget/pump-ctrl/activity",
    "derived instances missing from stored are appended", JSON.stringify(out.map((i) => i.instanceId)));
  assert(out[1].hidden === false, "appended instance keeps its derived (defaultVisible) visibility");

  const migrated = resolveLayout(parseLayout({ v: 1, items: VALID }), derived);
  assert(!migrated.some((item) => item.widgetId === 'live-map' || item.widgetId === 'route-card'),
    "v1 migration stays reporting-only after derived merge");

  // A derived instance whose def defaults to hidden stays hidden when appended.
  const derivedHidden: LayoutItem[] = [
    ...derived,
    { widgetId: "health-history", instanceId: "health-history", w: 12, hidden: true },
  ];
  const out2 = resolveLayout(stored, derivedHidden)!;
  const hh = out2.find((i) => i.instanceId === "health-history");
  assert(hh?.hidden === true, "defaultVisible:false instance appends hidden");
}

// --- Edit-mode helpers ---------------------------------------------------------
{
  const three: LayoutItem[] = [
    { widgetId: "a", instanceId: "a", w: 4, hidden: false },
    { widgetId: "b", instanceId: "b", w: 4, hidden: false },
    { widgetId: "c", instanceId: "c", w: 4, hidden: false },
  ];
  const moved = moveItem(three, 0, 2);
  assert(moved.map((i) => i.instanceId).join(",") === "b,c,a", "moveItem moves first to last", moved.map((i) => i.instanceId).join(","));
  assert(moveItem(three, 1, 1) === three, "moveItem no-op returns the same array");
  assert(moveItem(three, 0, 99).map((i) => i.instanceId).join(",") === "b,c,a", "moveItem clamps an out-of-range target");
  assert(three[0].instanceId === "a", "moveItem does not mutate the input");

  assert(cycleWidth(4) === 6 && cycleWidth(6) === 12 && cycleWidth(12) === 4, "cycleWidth cycles 4 → 6 → 12 → 4");
}

// --- pickEffectiveLayout: user row beats site default ------------------------------
{
  const personal: LayoutItem[] = [{ widgetId: "tank", instanceId: "widget/c/t", w: 12, hidden: false }];
  const shared: LayoutItem[] = [{ widgetId: "live-map", instanceId: "live-map", w: 12, hidden: false }];
  const rows = [
    { user: "", layout: JSON.parse(serializeLayout(shared)) },
    { user: "u1", layout: JSON.parse(serializeLayout(personal)) },
    { user: "u2", layout: VALID },
  ];
  const forU1 = pickEffectiveLayout(rows, "u1");
  assert(JSON.stringify(forU1) === JSON.stringify(personal), "the user's own row beats the site default");
  const forU3 = pickEffectiveLayout(rows, "u3");
  assert(JSON.stringify(forU3) === JSON.stringify(shared), "a user without a personal row gets the site default");
  assert(pickEffectiveLayout([{ user: "u1", layout: "garbage" }, { user: "", layout: JSON.parse(serializeLayout(shared)) }], "u1") !== null,
    "a corrupt personal row falls through to the site default");
  assert(pickEffectiveLayout([{ user: "u1", layout: VALID }], "u1") === null,
    "a stale (unversioned) personal row falls through to nothing → auto-derived");
  assert(pickEffectiveLayout([], "u1") === null, "no rows → null (auto-derived)");
  assert(pickEffectiveLayout(rows, "") === null || JSON.stringify(pickEffectiveLayout(rows, "")) === JSON.stringify(shared),
    "signed-out uid only ever sees the shared default");
}

// --- Reset-to-default path (pure half) -----------------------------------------------
{
  // After reset() clears the stored rows, the shell resolves with stored = null,
  // which is exactly the auto-derived layout.
  const derived: LayoutItem[] = [{ widgetId: "timeline", instanceId: "widget/c/activity", w: 12, hidden: false }];
  const out = resolveLayout(null, derived);
  assert(JSON.stringify(out) === JSON.stringify(derived), "reset (stored = null) resolves to the auto-derived reporting layout");
}

// --- Section labels: render-time only, never stored -----------------------------------
{
  const items: LayoutItem[] = [
    { widgetId: "tank", instanceId: "widget/c/tank", w: 4, hidden: false, section: "Status & controls" },
  ];
  const blob = JSON.parse(serializeLayout(items)) as { items: Record<string, unknown>[] };
  assert(blob.items.every((i) => !("section" in i)), "serializeLayout strips section labels (derived at render)");
  const merged = resolveLayout(parseLayout(JSON.parse(serializeLayout(items))), items);
  assert(merged.length === 1 && merged[0].section === undefined,
    "stored items carry no section — the shell re-derives zones from the widget id");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
