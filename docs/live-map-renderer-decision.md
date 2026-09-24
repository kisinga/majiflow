# Unified Canvas Platform Decision

Status: X6 is the default platform; validate the unified architecture before considering replacement

## Decision

Use one canvas library everywhere.

X6 remains the default for:

- topology editing;
- desktop operator maps;
- tablet and mobile operator maps;
- cloud builds;
- firmware-packaged device builds.

Do not introduce a separate live renderer, a mobile renderer, or a second gesture/camera library. If X6 fails a non-negotiable requirement, replace it across every canvas surface with one library that passes the same acceptance harness.

## Why the current mobile map is not evidence against X6

The present implementation makes product-level choices that constrain X6:

- the dashboard hides the map on phones;
- `LiveMapComponent` fixes its height to a dashboard-widget shape;
- wheel zoom is disabled because the map sits inside a scrolling dashboard;
- no complete mobile gesture contract exists;
- the editor and live map have separate wrapper classes;
- labels are managed as a live-map-specific layer;
- responsive behavior is based on the dashboard layout rather than a canvas camera policy.

Replacing the library without changing those decisions would reproduce the same problem.

X6 already provides responsive container sizing, pan, zoom, fit, custom SVG markup, HTML nodes through `foreignObject`, ports, routers, and cell updates. The first task is to use those capabilities through one coherent architecture.

Official references:

- [X6 responsive graph, resize, pan, and zoom](https://x6.antv.antgroup.com/en/tutorial/basic/graph)
- [X6 custom SVG and HTML node rendering](https://x6.antv.antgroup.com/en/tutorial/basic/node)
- [X6 port layout and mutation](https://x6.antv.antgroup.com/en/tutorial/basic/port)
- [X6 node and edge tools](https://x6.antv.antgroup.com/tutorial/intermediate/tools)

## Architecture

```text
                     SiteTopology
                          │
                          ▼
                TopologyCanvasCore (X6)
               ┌──────────┼──────────┐
               │          │          │
        Node registry   Pipe model   Camera
               │          │          │
      ┌────────┴───┐      │     semantic zoom
      │            │      │     pan/pinch/fit
 EditorBehavior  OperatorBehavior   resize policy
      │            │
 drag/connect    nodeRuntime
 history/tools   activePath
 persistence     selection overlay
```

### `TopologyCanvasCore`

The core owns only shared canvas responsibilities:

- create and dispose the X6 `Graph`;
- reconcile topology structure into stable cells;
- register canonical nodes, ports, edges, and routers;
- maintain node and pipe lookup maps;
- expose coordinate conversion and viewport operations;
- run the shared responsive camera;
- host semantic labels and constant-size interaction targets;
- emit semantic canvas events such as `entitySelected` and `viewportChanged`.

It does not know about Angular routes, backend services, firmware commands, widget layouts, or user permissions.

### `EditorBehavior`

The editor profile enables:

- node dragging;
- port connection;
- selection and deletion;
- history;
- snaplines;
- edge vertices and segment tools;
- topology persistence.

Existing editor behavior is characterized before consolidation and must remain equivalent afterward.

### `OperatorBehavior`

The operator profile enables:

- read-only topology geometry;
- runtime node state;
- active and fault path styling;
- screen-space entity selection;
- semantic label density;
- explicit overview, active-path, and selected-entity framing.

It cannot drag nodes, connect ports, mutate topology, or issue hardware commands.

### Angular boundary

An Angular host owns lifecycle and inputs. X6 owns the graph DOM.

```ts
type CanvasMode = 'editor' | 'operator';
type CanvasPresentation = 'desktop' | 'tablet' | 'phone';

interface TopologyCanvasInputs {
  topology: SiteTopology;
  mode: CanvasMode;
  presentation: CanvasPresentation;
  runtime?: ReadonlyMap<string, NodeRuntime>;
  activePath?: ActivePath;
  selectedNodeId?: string | null;
}
```

`presentation` affects camera constraints, label density, and hit-target size. It never selects another renderer or changes topology geometry.

## Responsive camera contract

### Container behavior

- The graph always derives its size from a real container.
- Use X6 `autoResize` or one shared `ResizeObserver`, not separate per-screen implementations.
- A resize updates the viewport without reconstructing cells.
- The camera stores the world coordinate at viewport center.
- Ordinary resize and orientation change preserve that center.
- An untouched initial overview may refit after an aspect-ratio change.
- Once the operator pans or zooms, resize never silently resets the view.

### Input behavior

- Desktop: background drag pans; page wheel behavior remains available when the map is embedded; explicit `+`, `−`, and Fit controls are present.
- Dedicated phone Map mode: one-finger drag pans and two-finger pinch zooms around the midpoint.
- Pointer movement above the tap threshold cancels entity selection.
- Browser zoom is not disabled globally. Only the active map gesture surface uses an appropriate `touch-action` policy.
- All framing actions call the same X6 camera methods.

### Framing behavior

- Overview fits all enabled topology with safe padding.
- Active path frames the current active/fault node and pipe bounds only when explicitly requested.
- Selected entity frames one node only when explicitly requested.
- Telemetry, command state, selection, drawer state, and bottom-sheet state never move the camera.
- Opening a drawer overlays the canvas; it does not change container width in the first release.

## Dynamic rendering contract

### Canonical SVG nodes

Pumps, valves, tanks, sources, sensors, filters, and other operational glyphs remain SVG-based X6 nodes.

- Register each node kind once.
- Use the same registration in editor and operator modes.
- Update runtime appearance through X6 data/attribute APIs.
- Do not replace the cell or inject a new glyph on every snapshot.
- Route engagement and entity telemetry remain independent presentation dimensions.
- Selected state is a third independent dimension and cannot overwrite either.

### HTML and Angular nodes

X6 can render HTML and framework components with SVG `foreignObject`. Use this only when the node needs layout or input that SVG cannot reasonably express.

The X6 documentation notes that complex HTML nodes may clip or flicker when their internal styles use transforms, positioning, or opacity. Therefore:

- operational glyphs default to SVG;
- editable forms, menus, and manual-control actions stay outside the graph;
- any Angular-node use gets an isolated compatibility and performance test;
- editor and operator modes cannot use different implementations of the same node kind.

### Semantic zoom

Semantic zoom is a presentation policy over one set of cells:

- overview: show topology structure plus selected, active, and fault labels;
- operational: add important readings and entity names;
- detailed: add secondary values, port labels where relevant, and engineering detail.

Changing level of detail updates visibility and screen-space overlays. It never removes cells, reroutes edges, or changes `activePath`.

## Route highlighting protection

`DashboardStore.activePath` remains the only operational path input.

- `OperatorBehavior` maps `nodes`, `pipes`, `faultNodes`, and `faultPipes` to stable X6 cells.
- A pipe has one applied state: rest, flow, or fault.
- A node combines runtime, engagement, and fault without losing any dimension.
- Selection is rendered by a separate overlay/tool layer.
- Camera and semantic zoom cannot mutate edge attributes that encode route state.
- Structural topology reconciliation reapplies runtime, path, selection, and label state in a defined order.

The current `applyFlow()` and `activePath` behavior is frozen until characterization tests exist.

## Mobile composition

Mobile uses the same X6 graph and node registrations.

- Controls and Map are workspace modes; Controls is the default.
- Map mounts in a dedicated, correctly sized surface rather than a compressed dashboard card.
- The map owns gestures only while Map mode is active.
- Route/fault status and Stop all routes remain reachable above the map.
- Entity selection opens the shared control content as a bottom sheet.
- Closing the sheet changes neither route highlighting nor the camera.
- Manual controls in Controls mode provide a complete non-spatial alternative.

This is responsive composition around one canvas, not a mobile renderer.

## Why not introduce another library

### Native SVG or Canvas

Owning another renderer creates two implementations of nodes, pipes, routing, camera behavior, runtime painting, selection, accessibility, and regression tests. That violates the consistency requirement even if the second renderer is smaller.

### Three.js

Three.js adds a separate scene, camera, GPU-rendering, hit-testing, text, accessibility, and context lifecycle for a flat SVG-oriented domain. It provides no compensating product capability.

### JointJS

JointJS is the closest open-source global replacement. It supports SVG, ports, routers, custom nodes, and monitoring/editor use cases. It is not introduced beside X6. It is evaluated only if X6 fails the unified capability spike.

### yFiles

yFiles is the strongest commercial global replacement, with Angular, touch, advanced routing, and multiple rendering backends. Its licensing and controller/IP deployment implications must be resolved before a trial can become an architectural choice.

## Capability spike

Build the shared canvas outside the production dashboard first.

### Required scenarios

- editor mode with node drag, connect, undo/redo, and edge tools;
- desktop operator mode with map-dominant layout and control drawer;
- tablet operator mode with compact route dock;
- phone Map mode with pan, pinch, fit, semantic labels, selection, and bottom sheet;
- runtime transitions through unknown, off, on, unavailable, and fault;
- active path and fault path changes during selection and camera movement;
- dynamic tank level, pump state, valve state, and reading labels;
- topology structural change followed by full state reapplication;
- reduced motion;
- cloud and device builds.

### Test topologies

- every repository topology fixture;
- the largest supported real topology;
- tightly packed nodes;
- crossing and reverse-direction pipes;
- multiple ports per side;
- multiple simultaneous active routes;
- fault and active paths sharing nodes or pipes;
- duplicate or unresolved entity IDs.

### Go/no-go gates

X6 remains selected only if:

- one graph definition renders consistently across editor and operator modes;
- all supported widths and orientation changes work without cell reconstruction;
- phone pan and pinch are reliable on representative iOS and Android devices;
- dynamic nodes update without flicker or viewport reset;
- route highlighting remains behaviorally identical under selection and resize;
- editor capabilities remain intact;
- the device application remains within flash and OTA budgets;
- no second renderer or gesture framework is required.

## Replacement rule

If X6 fails a non-negotiable gate:

1. Freeze the same scene, interaction, editor, route-highlight, mobile, accessibility, and firmware acceptance harness.
2. Prototype JointJS and yFiles against that harness.
3. Select at most one replacement.
4. Replace editor and operator canvases together.
5. Do not ship a mixed transition state in device firmware.

The decision is global because consistent behavior is a product requirement, not an implementation preference.

## Current conclusion

X6 likely satisfies the requirements. The immediate problem is the split canvas architecture and the dashboard’s responsive policy, not proven incapability in X6.

The next correct step is consolidation and capability proof, not a library migration.
