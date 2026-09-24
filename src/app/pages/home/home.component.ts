import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { SitesStore } from '../../core/stores/sites.store';
import { AuthStore } from '../../core/services/auth.store';
import { FeatureFlagsService } from '../../core/services/feature-flags.service';
import { siteColor, initials } from '../../core/util/site-colors';
import type { SiteListEntry } from '../../core/models/backend-api';

/**
 * Post-login landing + role-aware redirect. Admins go to /overview. Customers
 * see their sites — straight to the dashboard if they own one, else a picker.
 * Shares the "bright hero over dark cards" balance with the Sites catalog.
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink],
  host: { class: 'flex-1 overflow-auto' },
  template: `
    <div class="page-container">
      @if (loading()) {
        <div class="flex items-center justify-center py-24"><span class="loading loading-spinner loading-lg text-primary"></span></div>
      } @else if (error()) {
        <div class="alert alert-error text-sm">{{ error() }}</div>
      } @else if (sites()?.length === 0) {
        <div class="rounded-2xl border border-dashed border-base-300/50 py-16 px-6 text-center">
          <div class="w-12 h-12 mx-auto mb-4 rounded-2xl bg-base-200 ring-1 ring-base-300/40 flex items-center justify-center text-base-content/40" aria-hidden="true">
            <svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0H5m14 0h2M5 21H3m4-14h2m-2 4h2m6-4h2m-2 4h2"/></svg>
          </div>
          <p class="text-base font-medium">No sites yet</p>
          <p class="text-sm text-base-content/50 mt-1 max-w-sm mx-auto leading-relaxed">Your installer assigns sites to your account. Reach out to them to get access to your dashboard.</p>
        </div>
      } @else {
        <!-- Bright hero band -->
        <div class="relative overflow-hidden rounded-2xl mb-8 ring-1 ring-white/10
                    bg-gradient-to-br from-cyan-500/15 via-sky-500/10 to-base-100">
          <div class="pointer-events-none absolute -top-16 -right-10 w-72 h-72 rounded-full bg-cyan-500/20 blur-3xl"></div>
          <div class="relative px-6 py-7 sm:px-8">
            <h1 class="app-title text-2xl font-bold">Your sites</h1>
            <p class="text-sm text-base-content/60 mt-1">Pick a site to see its tanks, flow and pumps live.</p>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
          @for (s of sites() ?? []; track s.id) {
            <a [routerLink]="['/site', s.id, 'dashboard']"
               [attr.aria-label]="s.friendlyName + ' — ' + s.controllerCount + ' controllers, ' + s.nodeCount + ' nodes'"
               class="group relative overflow-hidden rounded-2xl bg-base-100 ring-1 ring-base-300/40 hover:ring-primary/40 transition-all hover:-translate-y-0.5 p-5 flex gap-4">
              <div class="absolute inset-y-0 left-0 w-1 opacity-80" [style.backgroundColor]="color(s.friendlyName)" aria-hidden="true"></div>
              <div class="pointer-events-none absolute -top-10 -right-10 w-32 h-32 rounded-full bg-primary/0 group-hover:bg-primary/10 blur-2xl transition-all duration-300" aria-hidden="true"></div>
              <div class="w-12 h-12 rounded-2xl flex items-center justify-center text-white font-bold shadow-lg shrink-0"
                [style.backgroundColor]="color(s.friendlyName)" aria-hidden="true">{{ init(s.friendlyName) }}</div>
              <div class="relative flex-1 min-w-0">
                <div class="font-semibold truncate group-hover:text-primary transition-colors">{{ s.friendlyName }}</div>
                <div class="text-xs text-base-content/50 mt-0.5">{{ s.controllerCount }} controllers · {{ s.nodeCount }} nodes</div>
              </div>
              <svg xmlns="http://www.w3.org/2000/svg" class="relative h-5 w-5 text-base-content/30 group-hover:text-primary self-center transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class HomeComponent {
  private auth = inject(AuthStore);
  private sitesStore = inject(SitesStore);
  private flags = inject(FeatureFlagsService);
  private router = inject(Router);

  protected loading = signal(true);
  protected error = signal<string | null>(null);
  protected sites = signal<SiteListEntry[] | null>(null);

  constructor() {
    void this.route();
  }

  /** Role-aware redirect: partners land on their org home when the
   *  partner_portal flag is on, admins (and flag-off partners) on /overview,
   *  customers on their sites below. Awaits the flags bootstrap so a flag-off
   *  partner is never bounced through a gated route. */
  private async route(): Promise<void> {
    await this.flags.ready;
    if (this.auth.isPartner() && this.flags.isEnabled('partner_portal')) {
      void this.router.navigate(['/partner']);
      return;
    }
    if (this.auth.isManager()) {
      void this.router.navigate(['/overview']);
      return;
    }
    void this.load();
  }

  protected color(name: string): string { return siteColor(name); }
  protected init(name: string): string { return initials(name); }

  private async load(): Promise<void> {
    try {
      const sites = await this.sitesStore.ensureLoaded();
      if (sites.length === 1) {
        void this.router.navigate(['/site', sites[0].id, 'dashboard']);
        return;
      }
      this.sites.set(sites);
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.loading.set(false);
    }
  }
}
