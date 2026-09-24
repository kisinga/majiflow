import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { WorkspaceService } from '../../../core/services/workspace.service';
import { BoardService } from '../../../core/services/board.service';
import type { TemplateListEntry } from '../../../core/models/backend-api';

/**
 * Add-Controller toolbar control for the topology editor: the dropdown plus its
 * two modals (blank board, or from a template). Self-contained — creates the
 * controller via WorkspaceService and navigates to its system view. Gated by the
 * parent's readonly check (only mounted when editing is allowed).
 */
@Component({
  selector: 'app-add-controller',
  standalone: true,
  host: { class: 'contents' },
  template: `
    <div class="dropdown dropdown-end">
      <button tabindex="0" type="button" class="design-tool">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9zM12 1v3M12 20v3M1 12h3M20 12h3"/>
        </svg>
        <span>Add controller</span>
      </button>
      <ul tabindex="0" class="controller-menu dropdown-content menu z-30 w-52 p-2">
        <li><button type="button" (click)="openBlankControllerModal()">Blank controller…</button></li>
        <li><button type="button" (click)="openTemplateModal()">From template…</button></li>
      </ul>
    </div>

    <!-- Blank Controller Modal -->
    @if (showBlankModal()) {
      <dialog class="modal modal-open" style="position: fixed;">
        <div class="modal-box max-w-sm">
          <h3 class="font-bold text-lg mb-4">Add Blank Controller</h3>

          <div class="space-y-3">
            <div>
              <label class="label text-xs">Friendly Name</label>
              <input type="text" class="input input-sm input-bordered w-full"
                placeholder="e.g. Main Pump Controller"
                [value]="blankName()"
                (input)="blankName.set($any($event.target).value)"
                (keydown.enter)="createBlankController()" />
            </div>

            <div>
              <label class="label text-xs">Board</label>
              <select class="select select-sm select-bordered w-full"
                [value]="blankBoard()"
                (change)="blankBoard.set($any($event.target).value)">
                <option value="">-- select board --</option>
                @for (b of boards.boards(); track b.model) {
                  <option [value]="b.model">{{ b.label }}</option>
                }
              </select>
            </div>
          </div>

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" (click)="showBlankModal.set(false)">Cancel</button>
            <button class="btn btn-primary btn-sm" [disabled]="!blankName().trim() || !blankBoard()" (click)="createBlankController()">
              @if (addingController()) {
                <span class="loading loading-spinner loading-xs"></span>
              }
              Create
            </button>
          </div>
        </div>
        <div class="modal-backdrop" (click)="showBlankModal.set(false)"></div>
      </dialog>
    }

    <!-- Template Modal -->
    @if (showTemplateModal()) {
      <dialog class="modal modal-open" style="position: fixed;">
        <div class="modal-box max-w-md">
          <h3 class="font-bold text-lg mb-4">Add Controller from Template</h3>

          @if (templates().length === 0) {
            <p class="text-sm text-base-content/40 py-6 text-center">No templates available.</p>
          } @else {
            <p class="text-xs text-base-content/40 mb-2">Create a controller from a template.</p>
            <div class="space-y-1 max-h-60 overflow-auto">
              @for (entry of templates(); track entry.name) {
                <button
                  class="btn btn-ghost btn-sm w-full justify-start gap-3 font-normal"
                  [disabled]="addingController()"
                  (click)="addFromTemplate(entry.name)"
                >
                  <span class="font-medium">{{ entry.friendlyName || entry.name }}</span>
                  <span class="text-xs text-base-content/40 font-mono">{{ entry.board }}</span>
                </button>
              }
            </div>
          }

          <div class="modal-action">
            <button class="btn btn-ghost btn-sm" (click)="showTemplateModal.set(false)">Cancel</button>
          </div>
        </div>
        <div class="modal-backdrop" (click)="showTemplateModal.set(false)"></div>
      </dialog>
    }
  `,
  styles: [`
    .controller-menu { margin-top: 6px; border: 1px solid var(--op-border, #d7ded8); border-radius: 11px; background: #fff; box-shadow: 0 16px 42px rgb(21 32 25 / .16); color: var(--op-ink, #152019); }
    .controller-menu button { min-height: 42px; width: 100%; border-radius: 8px; font-size: 12px; text-align: left; }
    .controller-menu button:hover { background: var(--op-panel, #f3f6f2); }
  `],
})
export class AddControllerComponent {
  protected workspace = inject(WorkspaceService);
  protected boards = inject(BoardService);
  private router = inject(Router);

  protected showBlankModal = signal(false);
  protected showTemplateModal = signal(false);
  protected blankName = signal('');
  protected blankBoard = signal('');
  protected addingController = signal(false);
  protected templates = signal<TemplateListEntry[]>([]);

  protected async openBlankControllerModal() {
    this.blankName.set('');
    this.blankBoard.set('');
    await this.boards.ensureLoaded();
    this.showBlankModal.set(true);
  }

  protected async createBlankController() {
    const name = this.blankName().trim();
    const board = this.blankBoard();
    if (!name || !board) return;

    this.addingController.set(true);
    try {
      const controllerId = await this.workspace.addBlankController(name, board);
      this.showBlankModal.set(false);
      const siteId = this.workspace.site()?.id;
      if (siteId) {
        this.router.navigate(['/site', siteId, 'system', controllerId]);
      }
    } finally {
      this.addingController.set(false);
    }
  }

  protected async openTemplateModal() {
    this.templates.set([]);
    this.showTemplateModal.set(true);
  }

  protected async addFromTemplate(templateName: string) {
    this.addingController.set(true);
    try {
      const controllerId = await this.workspace.addControllerFromTemplate(templateName);
      this.showTemplateModal.set(false);
      const siteId = this.workspace.site()?.id;
      if (siteId) {
        this.router.navigate(['/site', siteId, 'system', controllerId]);
      }
    } finally {
      this.addingController.set(false);
    }
  }
}
