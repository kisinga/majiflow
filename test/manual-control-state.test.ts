import { resolveManualControl, type ManualControlEntityState } from '../src/app/pages/dashboard/manual-control-state.ts';

let passed = 0;
function assert(ok: unknown, name: string): void {
  if (!ok) throw new Error(name);
  console.log(`  ✓ ${name}`);
  passed++;
}

const base: ManualControlEntityState = {
  kind: 'valve', state: 'off', online: true, held: false, routeControlled: false, phase: null,
};
const state = (patch: Partial<ManualControlEntityState> = {}, armed = true, control = true) =>
  resolveManualControl({ ...base, ...patch }, armed, control);

console.log('Inline manual-control state matrix\n==================================');
assert(state({}, false).action === 'Locked' && !state({}, false).canActuate, 'idle actuator stays inert until the local gate is armed');
assert(state().action === 'Hold' && state().canActuate, 'armed idle actuator requires the hold action');
assert(state({ held: true }).action === 'Release' && state({ held: true }).canActuate, 'an owned claim uses the same hold gesture to release');
assert(state({ held: true }, false).action === 'Held' && !state({ held: true }, false).canActuate, 'disarming locks claim release while preserving truthful held state');
assert(state({ online: false, held: true }).action === 'Offline' && !state({ online: false, held: true }).canActuate, 'offline wins over an actionable release label');
assert(state({}, true, false).action === 'Read only' && !state({}, true, false).canActuate, 'read-only users cannot actuate');
assert(state({ phase: 'pending' }).action === 'Sending…' && !state({ phase: 'pending' }).canActuate, 'pending command blocks duplicate dispatch');
assert(state({ phase: 'pending', state: 'off', held: false }).reported === 'Starting', 'pending claim reports the start direction');
assert(state({ phase: 'pending', state: 'on', held: false }).reported === 'Releasing', 'pending release stays truthful after the local claim is dropped');
assert(state({ phase: 'refused' }).action === 'Retry' && state({ phase: 'refused' }).reported === 'Refused', 'refusal is explicit and retryable');
assert(state({ phase: 'expired' }).action === 'Retry' && state({ phase: 'expired' }).reported === 'Unconfirmed', 'expired confirmation is explicit and retryable');
assert(state({ state: 'fault' }).action === 'Fault' && !state({ state: 'fault' }).canActuate, 'faulted actuator cannot acquire a claim');
assert(state({ state: 'on', routeControlled: true }).action === 'In use' && !state({ state: 'on', routeControlled: true }).canActuate, 'route-owned actuator cannot be mistaken for a manual claim');
assert(state({ state: 'on' }).action === 'In use' && !state({ state: 'on' }).canActuate, 'unowned reported-on actuator requires Stop All rather than claim theft');
assert(state({ held: true, routeControlled: true }).canActuate, 'owned manual claim can be released while a route also owns the actuator');
assert(state({ kind: 'valve', state: 'on' }).reported === 'Open', 'valve state uses valve language');
assert(state({ kind: 'pump', state: 'on' }).reported === 'Running', 'pump state uses pump language');
assert(state({ state: 'unknown' }).reported === 'Unknown', 'unknown telemetry is not presented as off');

console.log(`\n${passed} passed, 0 failed`);
