import { Component, inject, input, output, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SystemEditorService } from '../../../core/services/system-editor.service';
import { WorkspaceService } from '../../../core/services/workspace.service';
import { defaultSensorVMaxV, type PinCap, type FieldDef } from '@core';
import type { TopologyNode } from '../../../core/models/topology.model';
import type { NodeDescriptor } from '../../../core/models/entities.model';
import { ZodFieldDirective } from '../../../core/utils/field-validation';
import { FieldErrorComponent } from '../../../shared/field-error/field-error.component';
import { ZodInputComponent } from '../../../shared/zod-input/zod-input.component';
import { TankCalibrationVisualComponent } from '../../../shared/tank-calibration-visual/tank-calibration-visual.component';

/**
 * Editable property panel for the selected topology node: name / controller /
 * enabled, the entity-declared field list (including the two-step pin/channel
 * selector), derived tank-pressure calibration readouts, and the "imported by"
 * summary. Mounted by `topology-sidebar` only when a node is selected; emits
 * `updateField` / `deleteNode` back up to the editor.
 */
@Component({
  selector: 'app-node-properties',
  standalone: true,
  imports: [FormsModule, ZodFieldDirective, FieldErrorComponent, ZodInputComponent, TankCalibrationVisualComponent],
  template: `
    <div class="sidebar-section">
      <button type="button" class="sidebar-title" (click)="toggleNode()">
        <span>{{ desc().label }}
        @if (desc().experimental) { <span class="badge badge-ghost badge-xs ml-1">experimental</span> }
        @if (isRemoteNode(node())) {
          <span class="badge badge-ghost badge-xs ml-1">Remote: {{ controllerNameFor(node()) }}</span>
        }</span>
        <svg class="section-chevron" [class.is-open]="expanded()" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 5 5 5-5 5"/></svg>
      </button>
      @if (expanded()) {
      <div class="sidebar-fields">
        <!-- Standard fields: Name + Controller + Enabled -->
        <label class="sidebar-label">Name</label>
        <div class="sidebar-control">
          <app-zod-input
            [schema]="desc().schema"
            fieldKey="name"
            inputClass="w-full font-mono"
            [value]="$any(node()).name"
            (valueChange)="updateField.emit({ nodeId: node().id, field: 'name', value: $event })" />
        </div>
        <label class="sidebar-label">Controller</label>
        <select class="select select-xs select-bordered w-full font-mono"
          [ngModel]="$any(node()).anchorId"
          [ngModelOptions]="{ standalone: true }"
          (ngModelChange)="updateField.emit({ nodeId: node().id, field: 'anchorId', value: $event })">
          @for (ctrl of allControllers(); track ctrl.id) {
            <option [value]="ctrl.id">{{ ctrl.friendlyName }}</option>
          }
        </select>
        <label class="sidebar-label">Enabled</label>
        <input type="checkbox" class="toggle toggle-xs toggle-success"
          [ngModel]="!$any(node()).disabled"
          (ngModelChange)="updateField.emit({ nodeId: node().id, field: 'disabled', value: !$event })" />
        <!-- Entity-specific fields -->
        @for (field of desc().sidebarFields; track field.key) {
          @if (isFieldVisible(field, $any(node())) && (!isRemoteNode(node()) || field.type !== 'pin') && !hiddenForVisual($any(node()), field.key)) {
          <label class="sidebar-label">{{ field.label }}@if (field.hint) {<span class="sidebar-info" [title]="field.hint" aria-label="info"> ⓘ</span>}</label>
          <div class="sidebar-control">
            @if (field.type === 'pin') {
              <!-- Hidden mirror control: holds the real pin value, carries the validator -->
              <input type="hidden"
                [name]="'pin-' + node().id + '-' + field.key"
                [ngModelOptions]="{ standalone: true }"
                [zodField]="{ schema: desc().schema, key: field.key }"
                #pinCtrl="ngModel"
                [ngModel]="$any(node())[field.key] ?? ''"
                (ngModelChange)="$event" />
              <!-- Two-step channel selector: transport group → channel (stacked so the
                   channel label, which can include a node name, reads in the narrow panel) -->
              <div class="flex flex-col gap-1 min-w-0 w-full"
                [class.pin-invalid]="pinCtrl.touched && pinCtrl.invalid">
                <select class="select select-xs select-bordered w-full font-mono min-w-0"
                  [class.select-warning]="!(pinCtrl.touched && pinCtrl.invalid) && !$any(node())[field.key]"
                  [ngModel]="activeGroup(node().id, field.key, $any(node())[field.key] ?? '', field.pinCap, $any(node()).anchorId)"
                  [ngModelOptions]="{ standalone: true }"
                  [name]="'grp-' + node().id + '-' + field.key"
                  (ngModelChange)="onTransportChange(node().id, field.key, $event, field.pinCap, $any(node()).anchorId)"
                  (blur)="pinCtrl.control.markAsTouched()">
                  <option value="">-- transport --</option>
                  @for (group of editor.channelGroupsForController($any(node()).anchorId ?? '', field.pinCap); track group.provider) {
                    <option [value]="group.provider">{{ group.label }}</option>
                  }
                </select>
                @if (activeGroupChannels(node().id, field.key, $any(node())[field.key] ?? '', field.pinCap, $any(node()).anchorId); as channels) {
                  @if (channels.length > 1) {
                    <select class="select select-xs select-bordered w-full font-mono min-w-0"
                      [name]="'ch-' + node().id + '-' + field.key"
                      [ngModelOptions]="{ standalone: true }"
                      [ngModel]="$any(node())[field.key]"
                      (ngModelChange)="updateField.emit({ nodeId: node().id, field: field.key, value: $event })"
                      (blur)="pinCtrl.control.markAsTouched()">
                      <option value="">-- channel --</option>
                      @for (ch of channels; track ch.id) {
                        <!-- This field's own pin shows clean + selectable; others keep
                             their owner suffix and stay disabled (taken elsewhere). -->
                        @let isOwn = ch.id === $any(node())[field.key];
                        <option [value]="ch.id" [disabled]="!!ch.usedBy && !isOwn">
                          {{ ch.label }}{{ ch.usedBy && !isOwn ? ' (' + ch.usedBy + ')' : '' }}
                        </option>
                      }
                    </select>
                  }
                }
              </div>
              <app-field-error [control]="pinCtrl" />
            } @else if (field.type === 'number') {
              <app-zod-input
                [schema]="desc().schema"
                [fieldKey]="field.key"
                type="number"
                inputClass="w-full font-mono"
                [placeholder]="numberPlaceholder($any(node()), field)"
                [min]="0"
                [value]="$any(node())[field.key]"
                (valueChange)="updateField.emit({ nodeId: node().id, field: field.key, value: $event })" />
            } @else if (field.type === 'select') {
              <select class="select select-xs select-bordered w-full font-mono"
                [name]="'sel-' + node().id + '-' + field.key"
                [ngModelOptions]="{ standalone: true }"
                [ngModel]="$any(node())[field.key]"
                (ngModelChange)="updateField.emit({ nodeId: node().id, field: field.key, value: $event })">
                @for (opt of field.options ?? []; track opt.value) {
                  <option [value]="opt.value">{{ opt.label }}</option>
                }
              </select>
            } @else if (field.type === 'toggle') {
              <input type="checkbox" class="toggle toggle-xs toggle-success"
                [name]="'tog-' + node().id + '-' + field.key"
                [ngModelOptions]="{ standalone: true }"
                [ngModel]="!!$any(node())[field.key]"
                (ngModelChange)="updateField.emit({ nodeId: node().id, field: field.key, value: $event })" />
            } @else {
              <app-zod-input
                [schema]="desc().schema"
                [fieldKey]="field.key"
                inputClass="w-full font-mono"
                [policy]="field.inputPolicy"
                [placeholder]="field.placeholder"
                [value]="$any(node())[field.key]"
                (valueChange)="updateField.emit({ nodeId: node().id, field: field.key, value: $event })" />
            }
          </div>
          }
        }
      </div>

      <!-- Tank level monitoring: the calibration model as a picture (schematic +
           psi/ADC bars + usable resolution), replacing stacked number readouts. -->
      @if (node().kind === 'tank' && $any(node()).level_monitored) {
        <div class="mt-3 pt-3 border-t border-base-300/30">
          <h4 class="sidebar-title">Calibration</h4>
          <app-tank-calibration-visual
            [uid]="node().id"
            [heightM]="$any(node()).height_m ?? null"
            [dropM]="$any(node()).pressure_elevation_m ?? 0"
            [sensorMaxPsi]="$any(node()).pressure_sensor_max_psi ?? null"
            (editField)="updateField.emit({ nodeId: node().id, field: $event.field, value: $event.value })" />
        </div>
      }


      <!-- Remote imports — read-only info showing which controllers import this local node. -->
      @if (!isRemoteNode(node()) && nodeImporterNames(node().id).length > 0) {
        <div class="mt-3 pt-3 border-t border-base-300/30">
          <h4 class="sidebar-title">Imported By</h4>
          <div class="flex flex-wrap gap-1">
            @for (name of nodeImporterNames(node().id); track name) {
              <span class="badge badge-secondary badge-xs">{{ name }}</span>
            }
          </div>
          <div class="text-[10px] text-base-content/40 mt-1">
            Other controllers have imported this node as a remote reference.
          </div>
        </div>
      }

      @if (!desc().singleton) {
        <button type="button" class="delete-action" (click)="deleteNode.emit(node().id)">Delete {{ desc().label }}</button>
      }
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      font-size: 12px;
      color: var(--op-ink, #12233b);
    }
    button:focus-visible, select:focus-visible { outline: 3px solid color-mix(in srgb, var(--op-blue, #0369a1) 30%, transparent); outline-offset: 1px; }
    .sidebar-section { padding: 8px 12px 14px; border-bottom: 1px solid var(--op-border, #cfdae7); }
    .sidebar-title {
      min-height: 44px; width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
      color: var(--op-muted, #60738a); background: none; border: none; padding: 0 3px;
      font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; cursor: pointer;
    }
    .sidebar-title:hover { color: var(--op-ink, #12233b); }
    .section-chevron { width: 16px; height: 16px; flex: none; transition: transform var(--motion-selection, 170ms) var(--ease-standard, ease); }
    .section-chevron.is-open { transform: rotate(90deg); }
    .sidebar-fields { display: grid; grid-template-columns: minmax(5rem, auto) minmax(0, 1fr); gap: 8px 10px; align-items: center; }
    .sidebar-label { color: var(--op-muted, #60738a); font-size: 10px; font-weight: 650; line-height: 1.3; }
    .sidebar-control { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    :host ::ng-deep .sidebar-control :is(input:not([type='hidden']), select), select.select { min-height: 40px; border-color: var(--op-border, #cfdae7); border-radius: 9px; background: #fff; color: var(--op-ink, #12233b); }
    .sidebar-info {
      cursor: help; font-size: 10px;
      color: var(--op-muted, #60738a);
    }
    .sidebar-info:hover { color: var(--op-ink, #12233b); }
    .delete-action { min-height: 44px; width: 100%; margin-top: 14px; border: 1px solid color-mix(in srgb, var(--op-red, #c93636) 52%, var(--op-border, #cfdae7)); border-radius: 9px; color: var(--op-red, #c93636); background: #fff; font-size: 12px; font-weight: 800; }
    .delete-action:hover { background: color-mix(in srgb, var(--op-red, #c93636) 6%, #fff); }
    @media (prefers-reduced-motion: reduce) { .section-chevron { transition: none; } }
  `],
})
export class NodePropertiesComponent {
  protected editor = inject(SystemEditorService);
  private workspace = inject(WorkspaceService);

  // --- Inputs / outputs ---
  node = input.required<TopologyNode>();
  desc = input.required<NodeDescriptor>();
  updateField = output<{ nodeId: string; field: string; value: any }>();
  deleteNode = output<string>();

  // --- Section collapse ---
  protected expanded = signal(true);
  protected toggleNode() { this.expanded.update((v) => !v); }

  protected isFieldVisible(field: FieldDef, node: Record<string, unknown>): boolean {
    if (!field.visibleWhen) return true;
    const value = node[field.visibleWhen.key];
    if ('eq' in field.visibleWhen) return value === field.visibleWhen.eq;
    if ('in' in field.visibleWhen) return (field.visibleWhen.in as ReadonlyArray<unknown>).includes(value as string);
    if ('neq' in field.visibleWhen) return value !== field.visibleWhen.neq;
    return true;
  }

  /** All controllers for the node assignment dropdown. */
  protected allControllers = computed(() => {
    const topology = this.workspace.siteTopology();
    return topology?.controllers.map(c => ({
      id: c.id,
      friendlyName: c.friendlyName ?? c.id,
    })) ?? [];
  });

  /** True when a node's anchorId differs from the active controller. */
  protected isRemoteNode(node: TopologyNode): boolean {
    return node.anchorId !== this.workspace.activeControllerId();
  }

  /** Friendly name of the controller that owns this node. */
  protected controllerNameFor(node: TopologyNode): string {
    const topology = this.workspace.siteTopology();
    const ctrl = topology?.controllers.find(c => c.id === node.anchorId);
    return ctrl?.friendlyName ?? node.anchorId;
  }

  /** Names of controllers that have imported this local node as remote. */
  protected nodeImporterNames(nodeId: string): string[] {
    const topology = this.workspace.siteTopology();
    if (!topology) return [];
    return topology.remoteImports
      .filter(ri => ri.nodeId === nodeId)
      .map(ri => {
        const ctrl = topology.controllers.find(c => c.id === ri.controllerId);
        return ctrl?.friendlyName ?? ri.controllerId;
      });
  }

  // --- Two-step channel selector helpers ---

  /** Tracks user's transport group selection per field (survives value clearing). */
  private selectedGroups = new Map<string, string>();

  /** Resolve active group: explicit selection > derived from value > empty.
   *  Uses the NODE'S controller so pin options stay correct even when the
   *  editor is focused on a different controller. */
  protected activeGroup(
    nodeId: string,
    fieldKey: string,
    currentValue: string,
    cap?: PinCap,
    nodeAnchorId: string = this.editor.controllerId() ?? '',
  ): string {
    const key = `${nodeId}:${fieldKey}`;
    const explicit = this.selectedGroups.get(key);
    if (explicit) return explicit;
    if (!currentValue) return '';
    const groups = this.editor.channelGroupsForController(nodeAnchorId, cap);
    for (const g of groups) {
      if (g.channels.some(ch => ch.id === currentValue)) return g.provider;
    }
    return '';
  }

  /** Channels in the active group for step 2. */
  protected activeGroupChannels(
    nodeId: string,
    fieldKey: string,
    currentValue: string,
    cap?: PinCap,
    nodeAnchorId: string = this.editor.controllerId() ?? '',
  ): Array<{ id: string; label: string; caps: PinCap[]; usedBy?: string }> {
    const groupId = this.activeGroup(nodeId, fieldKey, currentValue, cap, nodeAnchorId);
    if (!groupId) return [];
    const groups = this.editor.channelGroupsForController(nodeAnchorId, cap);
    const group = groups.find(g => g.provider === groupId);
    return group?.channels ?? [];
  }

  /** When transport group changes, auto-select if single channel or clear. */
  protected onTransportChange(
    nodeId: string,
    field: string,
    groupId: string,
    cap?: PinCap,
    nodeAnchorId: string = this.editor.controllerId() ?? '',
  ) {
    const key = `${nodeId}:${field}`;
    this.selectedGroups.set(key, groupId);
    if (!groupId) { this.updateField.emit({ nodeId, field, value: '' }); return; }
    const groups = this.editor.channelGroupsForController(nodeAnchorId, cap);
    const group = groups.find(g => g.provider === groupId);
    if (!group) { this.updateField.emit({ nodeId, field, value: '' }); return; }
    if (group.channels.length === 1) {
      this.updateField.emit({ nodeId, field, value: group.channels[0].id });
    } else {
      this.updateField.emit({ nodeId, field, value: '' });
    }
  }

  // --- Tank calibration visual ---

  /** Fields the calibration visual owns and edits, so they drop out of the flat
   *  field list for a level-monitored tank (no duplicate inputs). */
  private static readonly TANK_VISUAL_FIELDS = new Set([
    'height_m', 'pressure_elevation_m',
  ]);

  protected hiddenForVisual(node: { kind?: string; level_monitored?: unknown }, key: string): boolean {
    return node.kind === 'tank' && node.level_monitored === true
      && NodePropertiesComponent.TANK_VISUAL_FIELDS.has(key);
  }

  /** Placeholder for a number field: states the value codegen will ASSUME when the
   *  field is left blank, so an empty input reads as "defaulting to X" rather than
   *  as a silently-set value. The field's `[value]` binds to the node's own value
   *  (empty when unset), so what's shown always equals what's saved and baked — no
   *  display-only prefill that can drift from the persisted node. The two sensor
   *  voltage fields are the only ones whose blank-default isn't obvious; the v_max
   *  assumption is resolved through the same helper codegen uses. */
  protected numberPlaceholder(node: Record<string, unknown>, field: FieldDef): string {
    if (field.key === 'pressure_v_min') return '0 (V at 0 psi)';
    if (field.key === 'pressure_v_max') return `${defaultSensorVMaxV(this.boardAdcRangeForNode(node))} (board range)`;
    return field.placeholder ?? '';
  }

  /** ADC input range of this node's pressure pin (`PinDef.adc_full_scale_v`,
   *  default 3.3), resolved against the node's OWN controller board. */
  private boardAdcRangeForNode(node: Record<string, unknown>): number {
    const pin = node['pressure_pin'];
    if (typeof pin !== 'string' || !pin) return 3.3;
    const anchorId = typeof node['anchorId'] === 'string' ? node['anchorId'] : undefined;
    const board = anchorId ? this.workspace.boards().get(anchorId) : this.editor.board();
    const def = board?.pins.find(p => p.gpio === pin || p.connector === pin);
    return def?.adc_full_scale_v ?? 3.3;
  }
}
