import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthStore } from '../core/services/auth.store';
import { BackendService } from '../core/services/backend.service';
import { PersonaService, type PersonaSwitch } from '../core/services/persona.service';

interface PersonaOption {
  id: string;
  name: string;
}

/**
 * PersonaSwitcherComponent — the dev-only role simulator in the navbar. Visible
 * only when PersonaService's probe says the caller is allowlisted
 * (MAJI_PERSONA_EMAILS); in production it never renders. One click flips the
 * caller's own account to admin / partner / site-owner customer / outsider
 * customer and reloads the app under the new persona. The Partner persona keeps
 * the caller's current org unless another is picked; the site personas default
 * to the site in the current `/site/:name/...` route, else the first site.
 */
@Component({
  selector: 'app-persona-switcher',
  standalone: true,
  imports: [],
  styles: [`
    :host{display:block}.persona-inline{border-bottom:1px solid var(--op-border,#cfdae7)}.persona-summary{min-height:42px;padding:0 8px;display:flex;align-items:center;gap:8px;border-radius:9px;color:var(--op-ink,#12233b);cursor:pointer;list-style:none;font-size:12px}.persona-summary::-webkit-details-marker{display:none}.persona-summary:hover{background:var(--op-panel,#edf3f8)}.persona-summary svg{width:17px;height:17px;color:var(--op-muted,#60738a)}.persona-summary .loading{margin-left:auto}.persona-panel{display:grid;gap:6px;padding:4px 8px 10px}.persona-panel label{display:grid;gap:3px}.persona-panel label>span,.persona-label{color:var(--op-muted,#60738a);font-size:9px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.persona-actions{display:grid;grid-template-columns:1fr 1fr;gap:4px}.persona-actions button{min-height:36px;padding:0 7px;border-radius:8px;background:var(--op-panel,#edf3f8);text-align:left;font-size:10px}.persona-actions button:hover:not(:disabled){background:var(--op-blue-soft,#e0f2fe);color:var(--op-blue,#0369a1)}.persona-actions button:disabled{opacity:.45}
  `],
  template: `
    @if (persona.enabled()) {
    <details class="persona-inline">
      <summary
        class="persona-summary"
        title="Dev persona switcher"
        aria-label="Dev persona switcher"
        (click)="open()"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
        </svg>
        <span>Developer persona · {{ auth.role() }}</span>
        @if (persona.switching()) {
          <span class="loading loading-spinner loading-xs"></span>
        }
      </summary>

      <div class="persona-panel">

        @if (orgs().length > 0) {
          <label>
            <span>Partner organization</span>
            <select class="select select-bordered select-xs w-full" (change)="orgId.set($any($event.target).value)">
              @for (o of orgs(); track o.id) {
                <option [value]="o.id" [selected]="o.id === orgId()">{{ o.name }}</option>
              }
            </select>
          </label>
        }
        @if (sites().length > 0) {
          <label>
            <span>Owner site</span>
            <select class="select select-bordered select-xs w-full" (change)="siteId.set($any($event.target).value)">
              @for (s of sites(); track s.id) {
                <option [value]="s.id" [selected]="s.id === siteId()">{{ s.name }}</option>
              }
            </select>
          </label>
        }

        <div class="persona-actions">
          <button [disabled]="persona.switching()" (click)="go({ role: 'admin' })">Admin</button>
          <button [disabled]="persona.switching()" (click)="asPartner()">Partner</button>
          <button [disabled]="persona.switching() || !siteId()" (click)="asSiteOwner()">Site owner</button>
          <button [disabled]="persona.switching()" (click)="asCustomer()">No-site customer</button>
        </div>
      </div>
    </details>
    }
  `,
})
export class PersonaSwitcherComponent {
  protected persona = inject(PersonaService);
  protected auth = inject(AuthStore);
  private backend = inject(BackendService);
  private router = inject(Router);

  protected orgs = signal<PersonaOption[]>([]);
  protected sites = signal<PersonaOption[]>([]);
  protected orgId = signal('');
  protected siteId = signal('');
  private loaded = false;

  /** Lazy-load the org/site pickers on first open (best-effort: the partners
   *  collection is admin-only, so a switched-to-customer caller just keeps
   *  their current org). */
  protected open(): void {
    if (this.loaded) return;
    this.loaded = true;
    void this.load();
  }

  private async load(): Promise<void> {
    const current = (this.backend.pb.authStore.record?.['partner'] ?? '') as string;
    this.orgId.set(current);
    try {
      const orgs = await this.backend.pb.collection('partners').getFullList({ sort: 'name' });
      this.orgs.set(orgs.map((o) => ({ id: o.id, name: (o['name'] || o.id) as string })));
      if (!this.orgId() && orgs.length) this.orgId.set(orgs[0].id);
    } catch {
      /* not listable under the current persona — keep the current org */
    }
    try {
      const sites = await this.backend.siteList();
      this.sites.set(sites.map((s) => ({ id: s.id, name: (s['name'] || s.id) as string })));
      this.siteId.set(this.routeSite() || (sites[0]?.id ?? ''));
    } catch {
      /* no visible sites under the current persona */
    }
  }

  /** The site id when on a `/site/:name/...` page ('' elsewhere). */
  private routeSite(): string {
    return /^\/site\/([^/]+)/.exec(this.router.url)?.[1] ?? '';
  }

  protected asPartner(): void {
    // No org picked (or none listable) → omit `partner`: the server keeps the
    // caller's current org assignment.
    const org = this.orgId();
    this.go({ role: 'partner', ...(org ? { partner: org } : {}) });
  }

  protected asSiteOwner(): void {
    const site = this.siteId();
    if (!site) return;
    this.go({ role: 'customer', site, grantSite: true });
  }

  protected asCustomer(): void {
    // "No site": drop the caller from the selected site's owner list when one
    // is known; otherwise the bare role flip still applies.
    const site = this.siteId();
    this.go({ role: 'customer', ...(site ? { site, grantSite: false } : {}) });
  }

  protected go(input: PersonaSwitch): void {
    // switch() reloads the page on success; only a failure needs reporting.
    this.persona.switch(input).catch((err) => {
      this.persona.switching.set(false);
      console.error('[persona] switch failed:', err);
    });
  }
}
