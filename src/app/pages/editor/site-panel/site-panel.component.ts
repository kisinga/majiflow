import { Component, inject, computed } from '@angular/core';
import { Router } from '@angular/router';
import { WorkspaceService } from '../../../core/services/workspace.service';
import { SystemEditorService } from '../../../core/services/system-editor.service';
import { ConfirmService } from '../../../core/services/confirm.service';
import { CONTROLLER_COLORS } from '../../../shared/canvas/topology-overlays';
import { DeploymentCardComponent } from './deployment-card.component';
import { SectionHeaderComponent } from '../shared/section-header.component';
import { AddControllerComponent } from '../topology-x6-tab/add-controller.component';

/**
 * Site overview — the workspace home. A single scrolling column (like the other
 * sections): a few at-a-glance stats, how the site connects, the controllers as
 * cards, and the derived routes grouped by controller. Selecting a controller
 * focuses it on the shared canvas (Design) rather than navigating away.
 */
@Component({
  selector: 'app-site-panel',
  standalone: true,
  imports: [DeploymentCardComponent, SectionHeaderComponent, AddControllerComponent],
  host: { class: 'block min-h-full' },
  styles: [`
    :host{background:var(--op-shell,#fbfcfa)}
    .system-overview{display:flex;flex-direction:column;gap:22px}
    .overview-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
    .overview-stat{min-height:92px;padding:16px 18px;border:1px solid var(--op-border,#d7ded8);border-radius:15px;background:#fff;box-shadow:0 1px 2px rgb(21 32 25/.04)}
    .controller-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
    :host .surface{border:1px solid var(--op-border,#d7ded8);border-radius:15px;background:#fff;background-image:none;box-shadow:0 1px 2px rgb(21 32 25/.05);--tw-ring-shadow:0 0 #0000}
    :host .surface:hover{box-shadow:0 5px 16px rgb(21 32 25/.07)}
    @media(max-width:900px){.overview-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:639.98px){.system-overview{gap:18px}.overview-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.overview-stat{min-height:82px;padding:13px}.controller-grid{grid-template-columns:1fr}}
  `],
  template: `
    <div class="system-overview page-container">
      <app-section-header
        title="Overview"
        subtitle="How this site connects, its controllers, and the routes that move water between them." />

      <!-- At-a-glance stats -->
      <div class="overview-stats">
        <div class="overview-stat">
          <div class="text-2xl font-semibold tabular-nums">{{ systemEntries().length }}</div>
          <div class="text-xs text-base-content/50 mt-0.5">Controllers</div>
        </div>
        <div class="overview-stat">
          <div class="text-2xl font-semibold tabular-nums">{{ workspace.siteRoutes().length }}</div>
          <div class="text-xs text-base-content/50 mt-0.5">Routes</div>
        </div>
        <div class="overview-stat">
          <div class="text-2xl font-semibold tabular-nums">{{ nodeCount() }}</div>
          <div class="text-xs text-base-content/50 mt-0.5">Nodes</div>
        </div>
        <div class="overview-stat">
          <div class="text-2xl font-semibold flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full" [class]="isLocal() ? 'bg-success' : 'bg-primary'"></span>
            {{ isLocal() ? 'On-site' : 'Cloud' }}
          </div>
          <div class="text-xs text-base-content/50 mt-0.5">Connection</div>
        </div>
      </div>

      <!-- How this site connects -->
      <app-deployment-card />

      <!-- Controllers -->
      <div>
        <h2 class="text-base font-semibold mb-2.5">Controllers</h2>
        @if (systemEntries().length === 0) {
          <div class="surface px-6 py-10 text-center">
            <p class="text-sm text-base-content/50">No controllers yet.</p>
            <p class="text-xs text-base-content/40 mt-1 mb-4">Add a controller to start drawing this site's topology.</p>
            @if (!editor.readonly()) {
              <div class="inline-flex">
                <app-add-controller />
              </div>
            }
          </div>
        } @else {
          <div class="controller-grid">
            @for (entry of systemEntries(); track entry.id) {
              <div
                class="surface p-4 flex items-start gap-3 cursor-pointer transition-all group relative overflow-hidden"
                (click)="focus(entry.id)">
                <span class="absolute left-0 inset-y-0 w-1" [style.backgroundColor]="entry.color"></span>
                <div class="flex-1 min-w-0 pl-1">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold truncate">{{ entry.friendlyName }}</span>
                    @if (workspace.dirtyControllerIds().has(entry.id)) {
                      <span class="badge badge-warning badge-xs shrink-0" title="Unsaved changes">modified</span>
                    }
                  </div>
                  <div class="flex items-center gap-2 mt-1 text-xs text-base-content/50">
                    <span class="font-mono">{{ entry.board }}</span>
                    <span class="text-base-content/30">·</span>
                    <span>{{ entry.nodeCount }} node{{ entry.nodeCount !== 1 ? 's' : '' }}</span>
                  </div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <span class="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity">Open ›</span>
                  <button
                    class="btn btn-ghost btn-xs btn-square text-error opacity-50 hover:opacity-100 transition-opacity"
                    (click)="deleteSystem(entry.id, entry.friendlyName, $event)"
                    title="Delete controller">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            }
          </div>
        }
      </div>

      <!-- Routes -->
      <div>
        <h2 class="text-base font-semibold mb-2.5">Routes
          <span class="text-base-content/40 font-normal">({{ workspace.siteRoutes().length }})</span>
        </h2>
        @if (workspace.siteRoutes().length === 0) {
          <div class="surface px-6 py-10 text-center">
            <p class="text-sm text-base-content/50">No routes derived yet.</p>
            <p class="text-xs text-base-content/40 mt-1">Connect tanks, pumps and valves in Design to form routes.</p>
          </div>
        } @else {
          <div class="space-y-3">
            @for (group of routeGroups(); track group.controllerId) {
              <div class="surface overflow-hidden">
                <div class="px-4 py-2.5 flex items-center gap-2 border-b border-base-300/30">
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" [style.backgroundColor]="group.color"></span>
                  <span class="text-sm font-semibold truncate" [style.color]="group.color">{{ group.friendlyName }}</span>
                  <span class="ml-auto text-xs text-base-content/40">{{ group.routes.length }} route{{ group.routes.length !== 1 ? 's' : '' }}</span>
                </div>
                <div class="divide-y divide-base-300/20">
                  @for (route of group.routes; track route.key) {
                    <div class="px-4 py-2.5 hover:bg-base-200/40 transition-colors"
                         [style.borderLeftColor]="group.color" style="border-left-width: 2px;">
                      <div class="font-mono text-[11px] leading-snug break-all" [style.color]="group.color">
                        {{ route.displaySource }}
                        <span class="text-base-content/30">›</span>
                        {{ route.displayDest }}
                      </div>
                      @if (route.crossController) {
                        <div class="text-[10px] text-base-content/30 italic">via {{ route.destController }}</div>
                      }
                      <div class="flex items-center gap-2 mt-1 text-[10px] text-base-content/40">
                        <span>{{ route.valveCount }} valve{{ route.valveCount !== 1 ? 's' : '' }}</span>
                        @if (route.hasPump) { <span class="badge badge-ghost badge-xs">pump</span> }
                        @if (!route.monitored) { <span class="badge badge-ghost badge-xs">unmonitored</span> }
                      </div>
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        }
      </div>
    </div>
  `,
})
export class SitePanelComponent {
  protected workspace = inject(WorkspaceService);
  protected editor = inject(SystemEditorService);
  private confirmService = inject(ConfirmService);
  private router = inject(Router);

  protected isLocal = computed(() => this.workspace.deploymentMode() === 'local');
  protected nodeCount = computed(() => this.workspace.siteTopology()?.nodes.length ?? 0);

  /** Controllers with stable colors, board + node counts. */
  protected systemEntries = computed(() => {
    const topology = this.workspace.siteTopology();
    return (topology?.controllers ?? []).map((ctrl, i) => ({
      id: ctrl.id,
      friendlyName: ctrl.friendlyName ?? ctrl.id,
      board: ctrl.board,
      color: CONTROLLER_COLORS[i % CONTROLLER_COLORS.length],
      nodeCount: topology?.nodes.filter(n => n.anchorId === ctrl.id).length ?? 0,
    }));
  });

  /** Routes grouped by source controller, with boundary colors and clean names. */
  protected routeGroups = computed(() => {
    const routes = this.workspace.siteRoutes();
    const topology = this.workspace.siteTopology();
    if (!topology) return [];

    const controllerIds = topology.controllers.map(c => c.id);
    const controllerColor = new Map<string, string>();
    const controllerFriendly = new Map<string, string>();
    controllerIds.forEach((id, i) => {
      controllerColor.set(id, CONTROLLER_COLORS[i % CONTROLLER_COLORS.length]);
      controllerFriendly.set(id, topology.controllers.find(c => c.id === id)?.friendlyName ?? id);
    });

    const groups = new Map<string, Array<{
      key: string; displaySource: string; displayDest: string;
      crossController: boolean; destController: string;
      valveCount: number; hasPump: boolean; monitored: boolean;
    }>>();

    for (const route of routes) {
      const srcNode = topology.nodes.find(n => n.id === route.source);
      const destNode = topology.nodes.find(n => n.id === route.destination);
      const srcController = srcNode?.anchorId ?? 'unknown';
      const destController = destNode?.anchorId ?? 'unknown';

      const arr = groups.get(srcController) ?? [];
      arr.push({
        key: route.key,
        displaySource: route.source,
        displayDest: route.destination,
        crossController: srcController !== destController,
        destController: controllerFriendly.get(destController) ?? destController,
        valveCount: route.valves.length,
        hasPump: route.crossesPump,
        monitored: route.monitored,
      });
      groups.set(srcController, arr);
    }

    return controllerIds
      .filter(id => groups.has(id))
      .map(id => ({
        controllerId: id,
        friendlyName: controllerFriendly.get(id) ?? id,
        color: controllerColor.get(id) ?? '#666',
        routes: groups.get(id)!,
      }));
  });

  /** Focus a controller on the shared canvas and jump to the Design view. */
  protected focus(controllerId: string) {
    const siteId = this.workspace.site()?.id;
    if (!siteId) return;
    this.editor.panel.set('design');
    this.router.navigate(['/site', siteId, 'system', controllerId]);
  }

  protected async deleteSystem(systemId: string, friendlyName: string, event: Event) {
    event.stopPropagation();
    const confirmed = await this.confirmService.confirm({
      title: 'Delete Controller',
      message: `Delete "${friendlyName}"? All pipes to/from this controller will also be removed. If it was deployed as a device, it will be deregistered (reversible from the Devices page).`,
      confirmLabel: 'Delete',
      variant: 'error',
    });
    if (!confirmed) return;
    if (this.workspace.activeControllerId() === systemId) {
      this.workspace.unfocusController();
    }
    await this.workspace.removeController(systemId);
  }
}
