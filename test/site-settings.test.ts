/** Structural guards for first-class site Settings and Automations pages. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function source(path: string): string { return readFileSync(resolve(process.cwd(), path), 'utf8'); }
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

const settings = source('src/app/pages/dashboard/widgets/site-controls.component.ts');
const automations = source('src/app/pages/automations/automations.component.ts');
const dashboard = source('src/app/pages/dashboard/dashboard.component.ts');

assert(!settings.includes('<dialog') && !settings.includes('modal-open'), 'site settings never open a modal navigation layer');
assert(!settings.includes('AutomationsManagerComponent'), 'site settings do not duplicate the Automations destination');
assert(settings.includes("type SettingsSection = 'operations' | 'routes' | 'equipment' | 'advanced'"), 'site settings use stable task categories');
assert(settings.includes('<app-tunable-numbers') && settings.includes('<app-tank-calibration'), 'existing settings functionality remains inline');
assert(settings.includes("'safety_override'"), 'advanced settings retains the confirmed safety-override command');
assert(automations.includes('manager-surface') && automations.includes('page-container'), 'automations is a bounded first-class page');
assert(!automations.includes('<dialog') && !automations.includes('modal-open'), 'automations page is not a dialog');
const takeover = dashboard.indexOf("adminViewing() && workspaceView !== 'insights'");
const workspaceBranch = dashboard.indexOf("@if (workspaceView === 'operate')");
assert(takeover >= 0 && takeover < workspaceBranch && dashboard.includes('Take control'), 'Operate and Settings share the explicit manager takeover gate');
assert(dashboard.includes("'node_set', { actuator, on: false }"), 'Stop All explicitly releases manual actuator claims');

console.log('site-settings: first-class page guards OK');
