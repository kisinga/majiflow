import { Component, inject, OnInit, signal } from '@angular/core';
import { BrandingService } from '../../core/services/branding.service';
import { PartnerService, type PartnerOrg } from './partner.service';
import { SectionHeaderComponent } from '../editor/shared/section-header.component';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Partner org profile (/partner/org) — the self-serve surface for the org
 * record behind the admin-only partners collection: display name, brand
 * colors, and the logo upload. Saving re-applies the branding to the
 * partner's own shell via BrandingService; customers see the new branding on
 * their next load (the /branding endpoint serves it to anyone in the org).
 */
@Component({
  selector: 'app-partner-org',
  standalone: true,
  imports: [SectionHeaderComponent],
  host: { class: 'flex-1 overflow-auto' },
  template: `
    <div class="content-pane space-y-6">
      <app-section-header title="Organization" subtitle="Your brand, shown to every customer in your organization." />

      @if (loading()) {
        <div class="flex items-center justify-center py-24"><span class="loading loading-spinner loading-lg text-cyan-400"></span></div>
      } @else if (org(); as o) {
        @if (status(); as st) {
          <div class="alert text-sm py-2" [class]="st.ok ? 'alert-success' : 'alert-error'">
            <span>{{ st.text }}</span>
            <button class="btn btn-ghost btn-xs" (click)="status.set(null)">Dismiss</button>
          </div>
        }

        <div class="surface p-5 space-y-5">
          <!-- Logo -->
          <div class="flex items-center gap-4">
            <div class="w-16 h-16 rounded-2xl bg-base-200 ring-1 ring-base-300/40 flex items-center justify-center overflow-hidden shrink-0">
              @if (logoUrl(); as url) {
                <img [src]="url" alt="Organization logo" class="w-full h-full object-contain" />
              } @else {
                <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7 text-base-content/25" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              }
            </div>
            <div>
              <label class="btn btn-sm btn-ghost ring-1 ring-white/10 cursor-pointer" [class.btn-disabled]="busy()">
                <input type="file" accept="image/jpeg,image/png,image/svg+xml,image/webp" class="hidden" (change)="uploadLogo($event)" />
                {{ o.logo_url ? 'Replace logo' : 'Upload logo' }}
              </label>
              <p class="text-xs text-base-content/40 mt-1.5">PNG, JPG, SVG or WebP, up to 2 MB.</p>
            </div>
          </div>

          <!-- Name -->
          <label class="flex flex-col">
            <span class="label-text mb-1">Organization name</span>
            <input type="text" class="input input-bordered w-full" #nameI [value]="o.name ?? ''" />
          </label>
          <p class="text-xs text-base-content/40 -mt-3">Slug: <span class="font-mono">{{ o.slug }}</span> (fixed — ask an admin to change it)</p>

          <!-- Brand colors -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label class="flex flex-col">
              <span class="label-text mb-1">Primary color</span>
              <span class="flex items-center gap-2">
                <input type="color" class="w-10 h-10 rounded cursor-pointer bg-transparent shrink-0"
                       [value]="validHex(primaryI?.value) ? primaryI.value : '#22d3ee'"
                       (input)="primaryI.value = $any($event.target).value" />
                <input type="text" class="input input-bordered w-full font-mono" placeholder="#22d3ee"
                       #primaryI [value]="o.brand_primary ?? ''" />
              </span>
            </label>
            <label class="flex flex-col">
              <span class="label-text mb-1">Accent color</span>
              <span class="flex items-center gap-2">
                <input type="color" class="w-10 h-10 rounded cursor-pointer bg-transparent shrink-0"
                       [value]="validHex(accentI?.value) ? accentI.value : '#0369a1'"
                       (input)="accentI.value = $any($event.target).value" />
                <input type="text" class="input input-bordered w-full font-mono" placeholder="#0369a1"
                       #accentI [value]="o.brand_accent ?? ''" />
              </span>
            </label>
          </div>
          <p class="text-xs text-base-content/40 -mt-3">Leave a color empty to fall back to the MajiFlow default.</p>

          @if (formError()) { <p class="text-error text-xs">{{ formError() }}</p> }

          <div class="flex justify-end gap-2">
            <button class="btn btn-sm border-0 bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                    [disabled]="busy()"
                    (click)="save(nameI.value, primaryI.value, accentI.value)">
              @if (busy()) { <span class="loading loading-spinner loading-xs"></span> }
              Save
            </button>
          </div>
        </div>
      }
    </div>
  `,
})
export class PartnerOrgComponent implements OnInit {
  private partner = inject(PartnerService);
  private branding = inject(BrandingService);

  protected loading = signal(true);
  protected busy = signal(false);
  protected org = signal<PartnerOrg | null>(null);
  protected logoUrl = signal('');
  protected formError = signal<string | null>(null);
  protected status = signal<{ ok: boolean; text: string } | null>(null);

  async ngOnInit() {
    try {
      const org = await this.partner.getOrg();
      this.org.set(org);
      this.logoUrl.set(org.logo_url ?? '');
    } catch (err) {
      this.status.set({ ok: false, text: this.msg(err) });
    } finally {
      this.loading.set(false);
    }
  }

  protected validHex(v: string | undefined): boolean {
    return !!v && HEX_RE.test(v.trim());
  }

  protected async save(name: string, primary: string, accent: string): Promise<void> {
    const n = name.trim();
    const p = primary.trim();
    const a = accent.trim();
    if (!n) return this.formError.set('Name is required.');
    if (p && !HEX_RE.test(p)) return this.formError.set('Primary color must be a #rrggbb hex value.');
    if (a && !HEX_RE.test(a)) return this.formError.set('Accent color must be a #rrggbb hex value.');
    this.busy.set(true);
    this.formError.set(null);
    try {
      const org = await this.partner.patchOrg({ name: n, brand_primary: p, brand_accent: a });
      this.org.set(org);
      await this.branding.refresh(); // apply to this shell immediately
      this.status.set({ ok: true, text: 'Saved — your customers see the new branding on their next load.' });
    } catch (err) {
      this.formError.set(this.msg(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async uploadLogo(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > LOGO_MAX_BYTES) {
      this.status.set({ ok: false, text: 'Logo exceeds the 2 MB limit.' });
      input.value = '';
      return;
    }
    this.busy.set(true);
    try {
      const org = await this.partner.uploadLogo(file);
      this.org.set(org);
      // Cache-bust so the preview (and the navbar logo after refresh) shows
      // the new file even when the filename is unchanged.
      this.logoUrl.set((org.logo_url ?? '') + '?t=' + Date.now());
      await this.branding.refresh();
      this.status.set({ ok: true, text: 'Logo updated.' });
    } catch (err) {
      this.status.set({ ok: false, text: this.msg(err) });
    } finally {
      this.busy.set(false);
      input.value = '';
    }
  }

  private msg(err: unknown): string {
    return (err as { message?: string })?.message || 'Something went wrong.';
  }
}
