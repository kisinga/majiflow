import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SystemEditorService, PANEL_LABELS, PANEL_SLUGS, type EditorPanel } from '../../core/services/system-editor.service';
import { WorkspaceService } from '../../core/services/workspace.service';

type SectionState = 'complete' | 'active' | 'untouched';

interface Section {
  id: EditorPanel;
  icon: string;
  /** Plain-language hint shown on hover. */
  hint: string;
}

/**
 * The system workflow control — a compact segmented stepper inside the System
 * page header. The invariant global site rail owns destination navigation; this only moves
 * through the ordered firmware-design workflow.
 * for "which part of this site am I working on": Overview (site-wide), then the
 * per-controller sections. Each row is a real browser link
 * (`/site/:name/system/:config/:section`), so sections are bookmarkable and the
 * back/forward buttons work. Labels + URL slugs come from the editor service
 * (the single source the breadcrumb shares); active state tracks `editor.panel`,
 * which the editor sets from the URL.
 */
@Component({
  selector: 'app-workspace-rail',
  standalone: true,
  imports: [RouterLink],
  host: { class: 'shrink-0' },
  styles: [`
    :host{display:block;width:min(100%,620px);min-width:0}.workflow-nav{min-height:44px;padding:3px;display:flex;align-items:center;gap:2px;overflow-x:auto;scrollbar-width:none;border:1px solid var(--op-border,#d7ded8);border-radius:12px;background:var(--op-panel-strong,#e8eee9)}.workflow-nav::-webkit-scrollbar{display:none}.workflow-link{position:relative;min-height:36px;padding:0 11px;display:flex;align-items:center;gap:7px;flex:none;border-radius:9px;color:var(--op-muted,#68756d);font-size:11px;font-weight:700;transition:background var(--motion-press,130ms) var(--ease-standard,ease),color var(--motion-press,130ms) var(--ease-standard,ease),box-shadow var(--motion-selection,170ms) var(--ease-standard,ease),transform var(--motion-press,130ms) var(--ease-standard,ease)}.workflow-link:hover{background:rgb(255 255 255/.65);color:var(--op-ink,#152019)}.workflow-link:active:not(.is-disabled){transform:scale(.985)}.workflow-link.is-active{background:#fff;color:var(--op-blue,#196ca6);box-shadow:0 1px 3px rgb(21 32 25/.1)}.workflow-link.is-disabled{opacity:.35;pointer-events:none}.workflow-link svg{width:16px;height:16px;flex:none}.complete-dot{width:6px;height:6px;border-radius:50%;background:#147448}.preview-badge{margin-left:4px;padding:4px 7px;border-radius:999px;background:#e0f2fe;color:#0369a1;font:700 9px ui-sans-serif,sans-serif}@media(max-width:767.98px){:host{width:100%}.workflow-nav{width:100%}.workflow-link{min-width:42px;flex:1;justify-content:center;padding-inline:8px}.workflow-link span:not(.complete-dot){display:none}}
  `],
  template: `
    <nav class="workflow-nav" aria-label="System workflow">
      @for (s of sections; track s.id) {
        @let disabled = isDisabled(s.id);
        <a [routerLink]="disabled ? null : linkFor(s.id)" [attr.aria-disabled]="disabled" [title]="disabled ? disabledHint(s.id) : s.hint" class="workflow-link" [class.is-active]="state(s.id)==='active'" [class.is-disabled]="disabled">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.7">
            <path stroke-linecap="round" stroke-linejoin="round" [attr.d]="s.icon" />
          </svg>
          <span>{{ labels[s.id] }}</span>
          @if (!disabled && state(s.id) === 'complete') { <span class="complete-dot" title="Set up"></span> }
        </a>
      }
      @if (editor.readonly()) { <span class="preview-badge">Preview</span> }
    </nav>
  `,
})
export class WorkspaceRailComponent {
  protected editor = inject(SystemEditorService);
  private workspace = inject(WorkspaceService);

  protected readonly labels = PANEL_LABELS;

  private siteId = computed(() => this.workspace.site()?.id ?? '');
  private ctrlId = this.editor.controllerId;

  protected readonly sections: Section[] = [
    { id: 'site',        hint: 'Site-wide: connection, controllers and routes',
      icon: 'M3 7l9-4 9 4M4 10v10h16V10M9 21v-6h6v6' },
    { id: 'design',      hint: 'Lay out tanks, pumps, valves and sensors',
      icon: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z' },
    { id: 'config',      hint: 'Board, pins, buses and safety timings',
      icon: 'M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z' },
    { id: 'remotes',     hint: 'Share sensors between controllers on the same LAN',
      icon: 'M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244' },
    { id: 'deploy',      hint: 'Generate the controller firmware bundle',
      icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  ];

  /** The browser link for a section (null while it can't be addressed yet). */
  protected linkFor(id: EditorPanel): string[] | null {
    const site = this.siteId();
    if (!site) return null;
    if (id === 'site') return ['/site', site];
    const ctrl = this.ctrlId();
    if (!ctrl) return null;
    return ['/site', site, 'system', ctrl, PANEL_SLUGS[id]];
  }

  protected isDisabled(id: EditorPanel): boolean {
    // Per-controller sections need a controller selected. Sharing (remotes) is
    // cross-controller LAN-UDP that never touches the cloud, so it works in cloud +
    // own-server alike — it is NOT gated by deployment mode.
    if (id !== 'site' && !this.ctrlId()) return true;
    return false;
  }

  protected disabledHint(_id: EditorPanel): string {
    return 'Add a controller in Design first';
  }

  private states = computed(() => {
    const t = this.editor.topology();
    const m = new Map<EditorPanel, SectionState>();
    m.set('site', (t?.controllers?.length ?? 0) > 0 ? 'complete' : 'untouched');
    m.set('design', (t?.nodes?.length ?? 0) > 0 && (t?.pipes?.length ?? 0) > 0 ? 'complete' : 'untouched');
    const device = this.editor.controllerDevice();
    m.set('config', device?.name && device?.board ? 'complete' : 'untouched');
    m.set('remotes', (t?.remoteImports?.length ?? 0) > 0 ? 'complete' : 'untouched');
    m.set('deploy', 'untouched');
    m.set(this.editor.panel(), 'active');
    return m;
  });

  protected state(id: EditorPanel): SectionState {
    return this.states().get(id) ?? 'untouched';
  }

}
