import { Component, inject, OnInit, OnDestroy, signal, computed, effect } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SystemEditorService, PANEL_LABELS, SLUG_PANELS } from '../../core/services/system-editor.service';
import { WorkspaceService } from '../../core/services/workspace.service';
import { BoardService } from '../../core/services/board.service';
import { BuildService } from '../../core/services/build.service';
import { TopologyX6TabComponent } from './topology-x6-tab/topology-x6-tab.component';
import { RemotesTabComponent } from './remotes-tab/remotes-tab.component';
import { ConfigTabComponent } from './config-tab/config-tab.component';
import { SitePanelComponent } from './site-panel/site-panel.component';
import { DeployPageComponent } from '../deploy/deploy-page.component';
import { WorkspaceRailComponent } from './workspace-rail.component';
import { ControllerSelectComponent } from './shared/controller-select.component';

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [
    WorkspaceRailComponent,
    ControllerSelectComponent,
    TopologyX6TabComponent,
    RemotesTabComponent,
    ConfigTabComponent,
    SitePanelComponent,
    DeployPageComponent,
  ],
  host: {
    class: 'flex-1 min-h-0 flex overflow-hidden',
    '[class.preview]': 'editor.readonly()',
  },
  styles: [`
    :host{--color-base-100:var(--op-shell);--color-base-200:var(--op-panel);--color-base-300:var(--op-border);--color-base-content:var(--op-ink)}.system-shell{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;background:transparent}.system-context{height:64px;min-height:64px;padding:0 20px;display:flex;align-items:center;gap:16px;border-bottom:1px solid var(--op-border);background:rgb(255 255 255/.88);box-shadow:0 5px 18px rgb(18 35 59/.045);backdrop-filter:blur(16px) saturate(1.2)}.system-context-copy{width:210px;min-width:0}.system-context-copy strong{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:17px}.system-context-copy span{display:block;margin-top:3px;color:var(--op-muted);font-size:11px}.system-workflow{min-width:0;flex:1;display:flex;justify-content:center}.controller-picker{flex:none}.system-content{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}@media(max-width:767.98px){.system-context{height:56px;min-height:56px;padding:6px 8px}.system-context-copy,.controller-picker{display:none}.system-workflow{width:100%;justify-content:stretch}}
  `],
  template: `
    <div class="system-shell workspace-page">
      <div class="system-context">
        <div class="system-context-copy"><strong>{{siteName()}}</strong><span>System · {{sectionLabel()}}</span></div>
        <div class="system-workflow"><app-workspace-rail /></div>

        @if (editor.panel() !== 'site') {
          <div class="controller-picker"><app-controller-select /></div>
        }
      </div>

      <!-- Commissioned lock: a live site's design is read-only until the admin opts
           in. Firmware (deploy) stays usable — that's how OTA reaches live devices. -->
      @if (locked()) {
        <div class="flex items-center gap-3 px-4 py-2 bg-warning/10 border-b border-warning/20 text-xs">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-warning shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span class="flex-1 text-base-content/70">This site is live. Design changes are locked to protect deployed devices.</span>
          <button class="btn btn-xs btn-warning btn-outline shrink-0" (click)="editor.enterDesignMode()">Enter design mode</button>
        </div>
      }

      <!-- Content: the design canvas stays mounted (display toggle) to preserve X6 state -->
      <div class="system-content">
        <main class="flex-1 min-h-0 min-w-0 flex flex-col"
          [style.display]="editor.panel() === 'design' ? 'flex' : 'none'">
          <app-topology-x6-tab />
        </main>

        @if (editor.panel() !== 'design') {
          <main class="flex-1 min-h-0 min-w-0 flex flex-col overflow-auto">
            <fieldset [disabled]="editor.readonly() && editor.panel() !== 'deploy'" class="flex-1 flex flex-col min-h-0">
              @switch (editor.panel()) {
                @case ('site') { <app-site-panel /> }
                @case ('remotes') { <app-remotes-tab /> }
                @case ('config') { <app-config-tab /> }
                @case ('deploy') { <app-deploy-page /> }
              }
            </fieldset>
          </main>
        }
      </div>
    </div>

    <!-- Save cue toast (workspace autosaves; this confirms it) -->
    @if (saveToastVisible()) {
      <div class="toast toast-start toast-bottom z-50">
        <div class="alert alert-success py-2 px-3 text-xs shadow-lg">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          <span>Saved</span>
        </div>
      </div>
    }
  `,
})
export class EditorComponent implements OnInit, OnDestroy {
  protected editor = inject(SystemEditorService);
  private workspace = inject(WorkspaceService);
  private boards = inject(BoardService);
  private build = inject(BuildService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  protected isPreview = signal(false);

  /** Show the commissioned-lock banner: site is live and not yet unlocked, and this
   *  isn't a route-level preview embed (which has no unlock affordance). */
  protected locked = computed(() => this.editor.locked() && !this.isPreview());

  // Sub-header state (reads off the workspace, like the other editor fields).
  protected siteName = computed(() => this.workspace.site()?.friendlyName ?? '');
  protected siteId = computed(() => this.workspace.site()?.id ?? '');
  protected sectionLabel = computed(() => PANEL_LABELS[this.editor.panel()]);
  // Save cue (moved here from the shell so the global top bar carries no editor state).
  protected saveToastVisible = signal(false);
  private saveToastTimer: ReturnType<typeof setTimeout> | null = null;

  private paramSub: { unsubscribe(): void } | null = null;

  constructor() {
    effect(() => {
      const t = this.editor.topology();
      if (t) this.runValidation();
    });

    let wasDirty = false;
    effect(() => {
      const dirty = this.workspace.dirty();
      if (wasDirty && !dirty) this.showSaveCue();
      wasDirty = dirty;
    });
  }

  private siteName_param: string | null = null;
  /** Last controller actually focused — guards needless re-focus on section switch. */
  private lastFocused: string | null = null;

  async ngOnInit() {
    this.siteName_param = this.route.snapshot.paramMap.get('name');

    const preview = this.route.snapshot.data['preview'] === true;
    this.isPreview.set(preview);

    if (!this.workspace.site() || this.workspace.site()?.id !== this.siteName_param) {
      if (this.siteName_param) {
        await this.workspace.load(this.siteName_param);
      }
    }

    this.paramSub = this.route.paramMap.subscribe(async (params) => {
      const systemId = params.get('config');
      const section = params.get('section');

      // The URL is the single source of truth for which section is shown. Bare
      // /site/:name → Overview; /system/:config → Design; /…/:section → that one.
      this.editor.panel.set(systemId ? (SLUG_PANELS[section ?? 'design'] ?? 'design') : 'site');

      // Focus a controller for the canvas + per-controller sections. Overview
      // has no controller in the URL, so fall back to the first for context.
      // Only re-focus when the controller actually changes (a section switch
      // keeps the same controller and must not reload its board).
      const target = systemId ?? this.workspace.siteTopology()?.controllers[0]?.id ?? null;
      if (target && target !== this.lastFocused) {
        this.lastFocused = target;
        await this.focusController(target, preview);
      }
    });
  }

  private async focusController(systemId: string, preview: boolean) {
    this.editor.focus(systemId, { readonly: preview });
    await this.boards.ensureLoaded();
    const device = this.editor.controllerDevice();
    if (device) {
      await this.boards.load(device.board);
    }
  }

  ngOnDestroy() {
    this.paramSub?.unsubscribe();
    if (this.saveToastTimer) clearTimeout(this.saveToastTimer);
    this.editor.clear();
    this.boards.clear();
  }

  private showSaveCue() {
    this.saveToastVisible.set(true);
    if (this.saveToastTimer) clearTimeout(this.saveToastTimer);
    this.saveToastTimer = setTimeout(() => this.saveToastVisible.set(false), 2000);
  }

  private validationGen = 0;

  private async runValidation() {
    const topology = this.workspace.siteTopology();
    const board = this.editor.board();
    const controllerId = this.workspace.activeControllerId();
    if (!topology || !board || !controllerId) return;
    const gen = ++this.validationGen;
    const result = await this.build.validate({
      kind: 'live',
      topology,
      board,
      controllerId,
    });
    if (gen !== this.validationGen) return;
    this.editor.setValidation(result);
  }
}
