import { Component, inject, OnInit, signal } from '@angular/core';
import { DocsStore } from '../../core/stores/docs.store';
import { DocsImportComponent } from './docs-import.component';
import type { DocEntry } from '../../core/models/backend-api';
import { docCatColor } from './doc-colors';

/**
 * Documentation (admin). Read-only view of the `docs` collection — the product
 * narrative + per-node-kind prose surfaced in every site's documentation. The
 * source of truth is the repo `docs-content/*.md` files; content is never
 * authored here, only imported (drop the files → preview → confirm). Selecting a
 * doc renders its body for verification of what's live.
 */
@Component({
  selector: 'app-docs-page',
  standalone: true,
  imports: [DocsImportComponent],
  host: { class: 'flex-1 overflow-auto' },
  template: `
    <div class="page-container">
      <!-- Hero -->
      <div class="relative overflow-hidden rounded-2xl mb-6 ring-1 ring-white/10
                  bg-gradient-to-br from-cyan-500/15 via-sky-500/10 to-base-100">
        <div class="pointer-events-none absolute -top-16 -right-10 w-72 h-72 rounded-full bg-cyan-500/20 blur-3xl"></div>
        <div class="relative px-6 py-6 flex items-center gap-3 flex-wrap">
          <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-bold tracking-tight">Documentation</h1>
            <p class="text-sm text-base-content/60 mt-0.5">Product narrative + per-node docs shown in every site's documentation. Source of truth: <code>docs-content/*.md</code>.</p>
          </div>
          <button class="btn btn-primary btn-sm gap-1.5" (click)="showImport.set(true)">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M12 4v12m0 0l-4-4m4 4l4-4"/></svg>
            Import from .md
          </button>
        </div>
      </div>

      @if (loading()) {
        <div class="flex items-center justify-center py-24"><span class="loading loading-spinner loading-lg text-cyan-400"></span></div>
      } @else {
        <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
          <!-- List -->
          <div class="space-y-1.5">
            @for (d of docs(); track d.id) {
              <button class="group w-full text-left rounded-xl bg-base-100 ring-1 transition-all hover:-translate-y-px px-3.5 py-2.5 flex items-center gap-3"
                      [class]="selectedId() === d.id ? 'ring-cyan-400/50' : 'ring-base-300/40 hover:ring-base-300/70'"
                      (click)="select(d)">
                <span class="w-1.5 h-9 rounded-full shrink-0" [style.backgroundColor]="catColor(d.category)"></span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium truncate">{{ d.title || d.slug }}</div>
                  <div class="text-[11px] text-base-content/40 truncate">{{ d.category }} · {{ d.slug }} · #{{ d.order }}</div>
                  <div class="text-[10px] text-base-content/30">updated {{ fmtDate(d.updated) }}</div>
                </div>
              </button>
            }
            @if (docs().length === 0) {
              <div class="rounded-xl border border-dashed border-base-300/50 py-10 text-center text-sm text-base-content/40">
                No docs yet. Use <span class="font-medium">Import from .md</span> to load <code>docs-content/</code>.
              </div>
            }
          </div>

          <!-- Read-only detail -->
          <div class="rounded-2xl bg-base-100 ring-1 ring-base-300/40 p-5">
            @if (selected(); as d) {
              <div class="flex items-center gap-3 mb-3 pb-3 border-b border-base-300/30">
                <div class="min-w-0 flex-1">
                  <div class="text-base font-semibold truncate">{{ d.title || d.slug }}</div>
                  <div class="text-[11px] text-base-content/40">{{ d.category }} · {{ d.slug }} · order {{ d.order }} · updated {{ fmtDate(d.updated) }}</div>
                </div>
              </div>
              <div class="doc-preview rounded-lg border border-base-300/40 bg-white text-black p-5 overflow-auto min-h-[360px]" [innerHTML]="previewHtml()"></div>
            } @else {
              <div class="flex items-center justify-center min-h-[360px] text-sm text-base-content/40">Select a doc to view its content.</div>
            }
          </div>
        </div>
      }
    </div>

    @if (showImport()) {
      <app-docs-import (closed)="showImport.set(false)" />
    }
  `,
  styles: [`
    .doc-preview :is(h1,h2,h3){ font-weight:600; margin:.6em 0 .3em; }
    .doc-preview h1{ font-size:1.3rem; } .doc-preview h2{ font-size:1.1rem; } .doc-preview h3{ font-size:1rem; }
    .doc-preview p,.doc-preview li{ font-size:.8rem; line-height:1.5; }
    .doc-preview table{ width:100%; border-collapse:collapse; font-size:.72rem; margin:.5em 0; }
    .doc-preview th,.doc-preview td{ border:1px solid #e5e7eb; padding:4px 8px; text-align:left; }
    .doc-preview th{ background:#0c4a6e; color:#fff; }
    .doc-preview code{ background:#f1f5f9; padding:1px 4px; border-radius:3px; font-size:.72rem; }
    .doc-preview blockquote{ border-left:3px solid #bae6fd; padding-left:10px; color:#475569; }
  `],
})
export class DocsPageComponent implements OnInit {
  private docsStore = inject(DocsStore);

  protected loading = signal(true);
  protected docs = this.docsStore.list;
  protected selectedId = signal<string | null>(null);
  protected selected = signal<DocEntry | null>(null);
  protected previewHtml = signal('');
  protected showImport = signal(false);

  protected catColor(c: string): string { return docCatColor(c); }

  protected fmtDate(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async ngOnInit() {
    try {
      await this.docsStore.ensureLoaded();
    } finally {
      this.loading.set(false);
    }
  }

  protected async select(d: DocEntry) {
    this.selectedId.set(d.id);
    this.selected.set(d);
    // Injected via [innerHTML]: doc bodies are admin-curated source-of-truth
    // content (imported from the repo) — trusted. Do not wire to untrusted input.
    const { previewDoc } = await import('@core/docs');
    if (this.selectedId() !== d.id) return; // selection changed mid-render
    this.previewHtml.set(await previewDoc(d.body));
  }
}
