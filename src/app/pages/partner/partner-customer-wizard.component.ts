import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { createEmptySiteTopology } from '@core';
import { BackendService } from '../../core/services/backend.service';
import { CustomersStore } from '../../core/stores/customers.store';
import { SitesStore } from '../../core/stores/sites.store';
import { SectionHeaderComponent } from '../editor/shared/section-header.component';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A throwaway-but-handoff password: long enough for the policy, readable
 *  enough to dictate over the phone. Shown once, never stored in the UI. */
function generatePassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/**
 * Customer onboarding wizard (/partner/customers/new) — the guided version of
 * what a partner can do by hand: create the customer account (role=customer,
 * partner = the caller's org — both forced by the users collection rule) and
 * optionally their first site (owner = the new customer). The password is a
 * one-time handoff: no invite email goes out (out of scope for v1), so the
 * partner passes it to the customer, who must change it on first login.
 */
@Component({
  selector: 'app-partner-customer-wizard',
  standalone: true,
  imports: [RouterLink, SectionHeaderComponent],
  host: { class: 'flex-1 overflow-auto' },
  template: `
    <div class="content-pane space-y-6">
      <app-section-header title="New customer" subtitle="Create the account and, optionally, their first site." />

      @if (done(); as d) {
        <!-- One-time handoff -->
        <div class="surface p-5 space-y-4">
          <div class="flex items-center gap-2 text-success">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <p class="font-medium">Customer created</p>
          </div>
          <p class="text-sm text-base-content/60 leading-relaxed">
            Pass these credentials to <span class="font-medium text-base-content">{{ d.name }}</span> now —
            the password is shown once and not stored anywhere you can retrieve later.
            <span class="font-medium text-base-content">The customer must change it on first login.</span>
          </p>
          <div class="rounded-xl bg-base-200 ring-1 ring-base-300/40 p-4 space-y-2 font-mono text-sm">
            <div class="flex items-center justify-between gap-3">
              <span class="text-base-content/50">Email</span><span class="truncate">{{ d.email }}</span>
            </div>
            <div class="flex items-center justify-between gap-3">
              <span class="text-base-content/50">Password</span>
              <span class="flex items-center gap-2 min-w-0">
                <span class="truncate select-all">{{ d.password }}</span>
                <button class="btn btn-ghost btn-xs shrink-0" (click)="copy(d.password)">{{ copied() ? 'Copied' : 'Copy' }}</button>
              </span>
            </div>
            @if (d.siteName) {
              <div class="flex items-center justify-between gap-3">
                <span class="text-base-content/50">Site</span><span class="truncate">{{ d.siteName }}</span>
              </div>
            }
          </div>
          <div class="flex justify-end gap-2 pt-1">
            <button class="btn btn-sm btn-ghost" (click)="reset()">Add another</button>
            <a routerLink="/partner" class="btn btn-sm border-0 bg-cyan-400 text-slate-950 hover:bg-cyan-300">Done</a>
          </div>
        </div>
      } @else {
        <div class="surface p-5 space-y-4">
          <label class="flex flex-col">
            <span class="label-text mb-1">Customer name</span>
            <input type="text" class="input input-bordered w-full" placeholder="e.g. Jane Mwangi" #nameI />
          </label>
          <label class="flex flex-col">
            <span class="label-text mb-1">Email</span>
            <input type="email" class="input input-bordered w-full" placeholder="jane@example.com" #emailI />
          </label>
          <label class="flex flex-col">
            <span class="label-text mb-1">Phone <span class="text-base-content/40">(optional)</span></span>
            <input type="tel" class="input input-bordered w-full" placeholder="+254712345678" #phoneI />
          </label>

          <label class="flex items-center gap-2 cursor-pointer pt-1">
            <input type="checkbox" class="checkbox checkbox-sm" [checked]="withSite()"
                   (change)="withSite.set($any($event.target).checked)" />
            <span class="text-sm">Create their first site now</span>
          </label>
          @if (withSite()) {
            <label class="flex flex-col">
              <span class="label-text mb-1">Site name</span>
              <input type="text" class="input input-bordered w-full" placeholder="e.g. Riverside Farm"
                     [value]="siteName()" (input)="siteName.set($any($event.target).value)" />
            </label>
          }

          @if (formError()) { <p class="text-error text-xs">{{ formError() }}</p> }

          <div class="flex justify-end gap-2 pt-1">
            <a routerLink="/partner" class="btn btn-sm btn-ghost" [class.btn-disabled]="busy()">Cancel</a>
            <button class="btn btn-sm border-0 bg-cyan-400 text-slate-950 hover:bg-cyan-300"
                    [disabled]="busy()"
                    (click)="submit(nameI.value, emailI.value, phoneI.value)">
              @if (busy()) { <span class="loading loading-spinner loading-xs"></span> }
              Create customer
            </button>
          </div>
        </div>
      }
    </div>
  `,
})
export class PartnerCustomerWizardComponent {
  private backend = inject(BackendService);
  private customersStore = inject(CustomersStore);
  private sitesStore = inject(SitesStore);

  protected busy = signal(false);
  protected withSite = signal(true);
  protected siteName = signal('');
  protected copied = signal(false);
  protected formError = signal<string | null>(null);
  protected done = signal<{ name: string; email: string; password: string; siteName: string } | null>(null);

  protected async submit(name: string, email: string, phone: string): Promise<void> {
    const n = name.trim();
    const e = email.trim().toLowerCase();
    const site = this.siteName().trim();
    if (!n) return this.formError.set('Name is required.');
    if (!EMAIL_RE.test(e)) return this.formError.set('A valid email is required.');
    if (this.withSite() && !site) return this.formError.set('Site name is required (or untick the site step).');

    const orgId = this.backend.pb.authStore.record?.['partner'] as string | undefined;
    if (!orgId) return this.formError.set('Your account has no partner organization assigned.');

    this.busy.set(true);
    this.formError.set(null);
    const password = generatePassword();
    try {
      // The users create rule forces role=customer + partner=own org; the
      // sites create guard (guardOwnerCreate) lets a partner seed a site only
      // for their own customers.
      const user = await this.backend.pb.collection('users').create({
        name: n,
        email: e,
        phone: phone.trim(),
        emailVisibility: true,
        password,
        passwordConfirm: password,
        role: 'customer',
        partner: orgId,
      });
      if (this.withSite()) {
        const slug = site.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        await this.backend.pb.collection('sites').create({
          name: site,
          slug,
          draft_topology: createEmptySiteTopology(),
          owner: [user.id],
        });
      }
      this.customersStore.invalidate();
      this.sitesStore.invalidate();
      this.done.set({ name: n, email: e, password, siteName: this.withSite() ? site : '' });
    } catch (err) {
      this.formError.set(this.msg(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // Clipboard unavailable (permissions) — the field is select-all-able.
    }
  }

  protected reset(): void {
    this.done.set(null);
    this.formError.set(null);
    this.siteName.set('');
  }

  private msg(err: unknown): string {
    const e = err as { message?: string; data?: { data?: Record<string, { message?: string }> } };
    const field = e?.data?.data ? Object.values(e.data.data)[0]?.message : undefined;
    return field || e?.message || 'Something went wrong.';
  }
}
