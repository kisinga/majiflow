# Navigation and Operator Workspace Implementation Plan

Status: implementation underway; the primary operator-workspace tranche is in production code

## Implementation checkpoint

Implemented in the first rewrite tranche:

- fixed, non-customizable operator workspace above the secondary widget grid;
- route dock with the existing route-card state machine and a correctly named Stop all active routes action;
- the existing X6 live renderer retained as the single desktop/mobile operator canvas, preserving `DashboardStore.activePath` highlighting;
- responsive camera floor on narrow screens, explicit zoom/Fit, pan surface, and Controls/Map phone modes;
- pump/valve selection from either the canvas or the Manual controls list;
- selection-only first step followed by an explicit manual action through `CommandLifecycleStore` sustained claims;
- desktop entity overlay and phone bottom sheet without resizing or rebuilding the graph;
- shared 44 px target and semantic motion tokens, including reduced-motion handling for canvas motion;
- mutually exclusive alert, persona, and account popovers, plus safer responsive navigation breakpoints;
- cloud production build and the complete TypeScript/codegen test suite verified.

Still required in later tranches:

- consolidate editor `X6Canvas` and operator `LiveCanvas` behind the planned shared core without changing route highlighting;
- persistent active-hold indicators when the entity panel is closed;
- partial-success reporting for multi-controller Stop all;
- versioned persisted-layout migration that removes structural route/map entries from storage;
- full cloud/device shell split and the wider rail/bottom-navigation redesign;
- pinch zoom, semantic label density, and on-device physical viewport testing;
- resolve the current Angular/esbuild device-build deadlock before producing the firmware asset manifest.

## Destination

Build one dependable operator experience in which:

- navigation, alerts, account tools, and development utilities never overlap;
- routes are the primary operating controls;
- the map is the dominant idle surface on larger screens and a dedicated mode on phones;
- pumps and valves can be selected from the map or a list;
- selection never actuates hardware;
- every actuation is an explicit second action with truthful lifecycle state;
- active manual holds remain visible even when their detail panel is closed;
- cloud and firmware builds share the operator workspace without dragging cloud-only code into firmware;
- route and fault highlighting cannot be regressed by selection, layout, or responsive behavior.

## Complexity standard

“Least complexity” means the fewest permanent concepts and authorities, not the fewest lines changed today.

The target has:

- one source of topology: `SiteTopology`;
- one source of runtime and active paths: `DashboardStore`;
- one source of command lifecycle: `CommandLifecycleStore`;
- one route-control behavior: the existing route-card state machine;
- one X6 canvas engine across editor, operator, desktop, tablet, mobile, cloud, and firmware;
- one entity-control content component across drawer, sheet, and list entry;
- one pure navigation-definition resolver;
- separate cloud and device shells selected at build/route level;
- no second command path for map interactions;
- no mobile-only scene model;
- no second rendering or gesture library;
- no general-purpose UI framework built inside the application.

Large boundary rewrites are acceptable where they remove branching and duplicated responsibility. Proven command, runtime, and highlighting logic is preserved.

## Rewrite boundary

Rewrite:

- application shell composition;
- primary dashboard composition;
- responsive operator workspace;
- manual entity selection and explicit controls;
- the canvas integration layer, consolidating the current editor and live wrappers around one X6 core;
- persisted layout migration for the new fixed workspace.

Preserve:

- backend and firmware protocols;
- topology schema unless a separately approved change is unavoidable;
- `DashboardStore.activePath` derivation;
- command dispatch, confirmation, refusal, expiry, and sustained-claim behavior;
- route-card semantics;
- topology editor capabilities and persisted topology behavior;
- device providers, SSE contract, and asset-manifest contract.

## Shell architecture

Make the application root a small router host.

- Cloud routes load a `CloudShell` containing the adaptive rail, site context, alerts, and account menu.
- Device routes load a small `DeviceShell` containing only local site context and the operator workspace.
- The shared operator workspace does not import cloud navigation, billing, partner, or administration components.
- Role, feature, and capability visibility comes from one pure navigation resolver with matrix tests.

This is simpler than one shell with many runtime conditions and prevents cloud-only shell code from consuming firmware flash.

Responsive global navigation:

- expanded rail at wide desktop widths;
- compact icon rail at intermediate widths;
- bottom primary navigation on phones;
- account, persona, and alerts are utilities, not peer destinations;
- persona switching lives inside a development-only account section.

## Operator workspace

The primary workspace is fixed and non-customizable. It sits above a secondary customizable insights grid.

Desktop:

- route dock at the inline start, approximately 256 px;
- map fills the remaining space;
- entity controls appear in an overlay drawer at the inline end;
- active manual holds remain visible independently of the drawer.

Phone:

- Controls and Map are local modes;
- Controls is the default and contains routes, manual entity list, holds, and Stop all routes;
- Map owns the usable content area rather than appearing as a small widget;
- selected entity controls appear as a bottom sheet;
- the same renderer, state, and panel content are used as desktop.

The map never becomes the only way to reach an entity. The Manual controls list is the accessible and operational fallback.

## Unified X6 canvas architecture

X6 is the single canvas platform. Mobile and desktop are responsive presentations of the same graph, not separate renderers. Editor and operator modes share one engine, node registry, pipe router, camera model, and coordinate system.

```text
TopologyCanvasCore (X6)
├── topology reconciliation
├── node and port registry
├── pipe routing and geometry
├── responsive camera
├── semantic zoom and labels
├── selection/hit-target overlay
├── EditorBehavior
│   ├── drag/connect
│   ├── history/snaplines
│   └── edit tools
└── OperatorBehavior
    ├── runtime state
    ├── active/fault paths
    └── entity selection
```

One library does not mean one monolithic component. X6 owns rendering, geometry, transforms, and graph interaction. Small behavior modules enable only the capabilities each mode needs.

The consolidation replaces the current architectural split between `X6Canvas` and `LiveCanvas`. It does not merge editor mutations into operator mode. Both consume the same core and registrations, while mode-specific behavior remains explicit and independently testable.

### Responsive camera

- X6 `autoResize` or one shared `ResizeObserver` follows the actual container.
- The camera preserves its world-space center across ordinary resize and orientation changes.
- An untouched initial overview may refit to the new aspect ratio; a user-moved viewport never refits automatically.
- Phone Map mode owns the gesture surface, so one-finger pan and two-finger pinch do not fight page scrolling.
- Desktop wheel behavior remains appropriate to its containing page; explicit zoom and Fit controls exist at every size.
- Overview, Active path, and Selected entity are explicit framing actions, never telemetry side effects.
- Semantic zoom changes label/detail density, not topology geometry.

### Dynamic nodes

The canonical operational glyphs remain X6 SVG nodes. They are registered once and reused in editor and operator modes. Runtime state updates node data/attributes without replacing cells.

X6 HTML/Angular nodes through `foreignObject` are allowed only when content genuinely requires framework layout or input. They are not the default because complex transformed HTML can clip or flicker. Operational controls remain outside graph nodes in the shared entity panel.

The canvas contract is fixed:

- `activePath` is the sole route/fault input;
- telemetry and selection never rebuild geometry;
- selection has its own presentation layer;
- telemetry never pans, zooms, or fits;
- opening a drawer or sheet never moves the camera;
- map targets stay at least 44 × 44 px in screen space;
- reduced motion removes animation without removing state;
- editor and operator modes render the same node and pipe vocabulary;
- no alternative renderer may be introduced for a breakpoint or build target.

### Replacement gate

X6 is replaced only if it fails a non-negotiable capability after the unified prototype is exercised at real sizes and on real devices. Any replacement must replace X6 everywhere. JointJS is the open-source evaluation candidate; yFiles is the commercial evaluation candidate. Mixing canvas libraries is not an accepted fallback.

### Canonical prototype direction

`artifacts/x6-canvas-operations.html` is the canonical product reference across desktop, tablet, and phone. It establishes the map-dominant workspace, left route hierarchy, independent entity selection, restrained canvas controls, on-demand desktop drawer, and compact phone bottom sheet.

The earlier standalone mobile study is superseded as a visual direction. Its useful findings—dedicated Map mode, Controls fallback, pan/pinch/fit, and semantic labels—have been recomposed inside the canonical operations prototype.

The former dynamic-node product mock is rejected. Dynamic nodes, editor/operator parity, and semantic zoom remain engineering requirements, but they are capability tests inside the canonical shell rather than a separate visual direction.

The implementation should carry forward the shared findings:

- routes remain large, stable controls outside the graph;
- the graph receives the largest flexible area;
- phone Controls and Map modes are composition changes around the same mounted canvas contract;
- tapping a pump or valve selects it and reveals detail but does not actuate it;
- manual action, route state, and selection use independent visual channels;
- camera controls and label-density rules are explicit at every viewport;
- desktop/tablet use an overlay drawer and phone uses a bottom sheet so opening controls does not resize or refit the graph;
- editor decorations are behavior-profile overlays, not a second node implementation.

Responsive panel invariants:

- phone entity controls are an intrinsic-height bottom sheet, never a desktop inspector stretched between `top` and `bottom`;
- the collapsed sheet cannot cover more than roughly one third of the usable map;
- its action keeps a fixed touch-target height and never grows with the sheet;
- phone Map entry frames the operational core at a readable scale; Fit remains the explicit full-topology overview;
- Stop all routes remains reachable while the map and entity sheet are open;
- overlays do not change graph container geometry or trigger an automatic refit;
- clipped labels, controls, or topology are release blockers rather than acceptable responsive degradation.

The prototypes intentionally use static SVG to make interaction decisions reviewable without changing production canvas code. They specify the target X6 behavior; they are not an alternative rendering architecture.

## Selection and manual control

Selection triggers:

- pump or valve on the live map;
- corresponding item in Manual controls;
- retained actuator status card, if shown.

Selection performs one local state update and opens entity detail. It sends zero commands.

Actuation requires a second target with physical intent in its label:

- Run pump;
- Stop pump;
- Hold valve open;
- Close valve.

The entity panel shows:

- entity, controller, and connectivity;
- reported runtime state;
- safety or permission constraints;
- one state-aware primary action;
- pending, confirmed, refused, expired, and offline state;
- a direct Stop action for an active claim.

Use pure functions to resolve topology nodes to controller and actuator metadata. Duplicate or unresolved IDs disable actuation with a diagnostic reason.

## Manual holds and route safety

- Active holds appear in a persistent workspace indicator with direct Stop.
- Leaving the workspace while a hold is active warns that the UI lease will lapse.
- Page refresh never asserts a hold without runtime/lifecycle evidence.
- Stop all routes retains its exact name because firmware does not clear manual claims with that action.
- Multi-controller Stop all reports full, partial, and total failure.
- A future Release manual holds action is separate work, not implied behavior.

## Design-system delta

Add only tokens and primitives required by the shell and workspace.

Interaction:

- minimum target: 44 px;
- primary and route targets: 56–64 px;
- one visible focus-ring token;
- semantic selected, pending, confirmed, hold, offline, fault, and refused states;
- color is paired with icon, shape, or text.

Motion:

- press feedback: 100 ms;
- state and navigation transitions: 120–180 ms;
- drawer and sheet: 240 ms;
- route progress and flow remain telemetry-derived and linear;
- command pending feedback is immediate;
- no new animation runtime;
- reduced motion removes transforms and continuous motion while preserving static route/fault state.

Avoid a generic component library project. Build only the navigation, control-state button, entity panel, drawer/sheet positioning, and status primitives that have multiple real consumers.

## Dashboard layout migration

- Routes and live map leave the customizable widget grid.
- The operator workspace cannot be hidden or reordered.
- Secondary usage, history, health, billing, and status widgets remain customizable.
- Version stored layouts and remove only structural route/map entries.
- Preserve order, width, and hidden state for every remaining widget.
- Migration is deterministic and idempotent in PocketBase and device localStorage.

## Firmware constraints

The device application is firmware payload.

- Build once with `npm run build:device`; do not bake site config into the app.
- Continue loading site topology from `/topology.json`.
- Preserve the pre-gzipped manifest and embedded `local-ui-assets.h` flow.
- Exclude cloud shells and cloud-only widgets at build time, not with CSS.
- Add no font, image, animation, or rendering dependency without a measured firmware case.
- Continue using the existing `/local/state` SSE stream; do not add polling.
- Report raw size, gzip size, asset count, largest assets, firmware image size, and OTA headroom in CI.
- Stay below the existing 700 KB warning line; do not raise the threshold to admit the redesign.
- Do not ship old and new dashboard implementations together in device firmware. Device rollback is by firmware release; cloud may use a lazy-loaded rollout flag.

## Delivery sequence

### 0. X6 capability spike and safety characterization

- Characterize current active, fault, rest, pan, zoom, and resize behavior.
- Build one shared X6 core with editor and operator behavior profiles in an isolated harness.
- Render the same topology, nodes, pipes, route state, and selection at 320, 390, 768, 1024, and 1440 px.
- Test phone pan, pinch, rotation, selection, semantic labels, and bottom-sheet behavior.
- Prove dynamic node updates without cell reconstruction or camera reset.
- Prove editor drag/connect/history behavior remains equivalent.
- Establish clean cloud/device bundle and firmware baselines.
- If any non-negotiable fails, run the identical harness against JointJS and yFiles and select one global replacement.

Exit: X6 is confirmed as the single canvas platform, or one global replacement is approved with measured evidence; no production behavior changed.

### 1. State model and design tokens

- Add pure entity resolution and navigation resolution.
- Add interaction, state, focus, layer, and motion tokens.
- Add tests for entity/controller mapping, permissions, and navigation visibility.

Exit: no duplicated state authority and no dashboard-specific command-state CSS.

### 2. Operator workspace vertical slice

- Move routes into the fixed dock/Controls mode.
- Add Manual controls, selection, explicit entity action, and active-hold indicator.
- Add the shared responsive X6 operator profile and mobile Map mode.
- Reuse the existing route and command lifecycle paths.

Exit: desktop and phone can complete route and manual-control tasks; selection sends no command; route highlighting parity is green.

### 3. Cloud and device shells

- Move cloud navigation into `CloudShell`.
- Add the minimal `DeviceShell`.
- Introduce adaptive rail, site context, bottom navigation, alerts, and account utility surfaces.
- Preserve guards, deep links, and browser history.

Exit: no overlap, correct role/capability visibility, and no cloud shell in the device dependency graph.

### 4. Layout migration and removal

- Version and migrate stored layouts.
- Remove duplicate primary widgets and direct-actuation cards.
- Delete superseded shell/dashboard code after parity.

Exit: no dual interaction model remains and secondary customization is preserved.

### 5. Firmware and release hardening

- Build cloud and device applications.
- Validate manifest, embedded assets, direct-controller cold load, cached reload, reconnect, and stale state.
- Compile representative firmware and record partition/OTA headroom.
- Run accessibility, browser, visual, performance, and real-device touch tests.

Exit: all acceptance criteria pass and the rollback path has been exercised.

## Blocking tests

- Map/list/card selection sends zero commands.
- An explicit entity action dispatches exactly once.
- Active route and fault styling is identical before and after selection work.
- Telemetry and selection do not rebuild geometry or reset the viewport.
- Pan, pinch, fit, resize, and target alignment work at supported sizes.
- Active manual holds remain visible with detail closed.
- Stop all routes does not imply manual claims were released.
- Navigation resolver passes every role/feature/capability permutation.
- Layout migration preserves every non-structural preference.
- Cloud and device builds pass; cloud-only code is absent from the device graph.
- Device manifest, asset table, firmware image, and OTA headroom remain valid.

## Acceptance criteria

- No navigation or utility overlap at 320, 390, 768, 1024, and 1440 px.
- The map dominates the idle desktop workspace and is genuinely usable in phone Map mode.
- Every action is reachable by keyboard and by a minimum 44 px pointer target.
- Selection and actuation are unambiguously separate.
- Pending, confirmed, refused, expired, offline, override, and partial-failure states are truthful.
- Route and fault highlighting cannot be changed by selection, panel state, telemetry cadence, or responsive layout.
- Mobile pan/pinch feels native and never fights page scrolling outside Map mode.
- Reduced-motion and 200% text retain all operational information.
- The device UI remains offline-capable, site-agnostic before `/topology.json`, and within firmware budgets.

## Deferred

- topology editor redesign;
- command, MQTT, firmware-control, or SSE protocol changes;
- global command palette;
- automatic map follow or auto-pan;
- selected-route preview highlighting;
- generalized inspection of every passive node;
- a global Release manual holds action;
- 3D rendering.
