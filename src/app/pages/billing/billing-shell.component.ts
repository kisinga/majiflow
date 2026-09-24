import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { BackendService } from '../../core/services/backend.service';
import { AuthStore } from '../../core/services/auth.store';
import { BillingService, type BillingSettings, type Invoice, type MeterDevice } from './billing.service';
import { BillingPageErrorComponent } from './billing-ui';
import { formatMoney, pbMessage } from './billing-format';

interface AttentionRow {
  tone: 'error' | 'warning';
  text: string;
  link: string[];
  linkText: string;
}

/** Meters with no uplink in this window are surfaced on the attention banner. */
const METER_SILENCE_MS = 48 * 3_600_000;

/**
 * BillingShellComponent (`/site/:name/billing`) — page chrome for the tenant
 * billing section: back link, title, the section tab bar (icons + live count
 * badges), the absent-when-calm attention banner, and the capability gate.
 * Child pages render inside the outlet and inject this shell for the site id.
 *
 * Gating is two-layer (per the billing spec): the `billing_module` feature flag
 * guards the routes; the per-site `tenant_billing` capability is probed here on
 * load. Three distinct outcomes: probing (spinner), probe FAILED (page error +
 * retry — a network error must not read as an entitlement fact), and answered
 * (true → tabs; false → the "not enabled" empty state).
 */
@Component({
  selector: 'app-billing-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, BillingPageErrorComponent],
  host: { class: 'flex-1 min-h-0 min-w-0 flex overflow-hidden' },
  styles: [`
    :host{--op-shell:#fbfcfa;--op-panel:#f3f6f2;--op-border:#d7ded8;--op-ink:#152019;--op-muted:#68756d;--color-base-100:var(--op-shell);--color-base-200:var(--op-panel);--color-base-300:var(--op-border);--color-base-content:var(--op-ink)}.billing-page{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;background:var(--op-shell);color:var(--op-ink)}.billing-context{height:64px;min-height:64px;padding:0 24px;display:flex;align-items:center;border-bottom:1px solid var(--op-border)}.billing-context h1{margin:0;font-size:18px;font-weight:800}.billing-context p{margin:3px 0 0;color:var(--op-muted);font-size:11px}.billing-scroll{flex:1;min-height:0;overflow:auto}.billing-content{display:flex;flex-direction:column;gap:20px}@media(max-width:767.98px){.billing-context{display:none}}
  `],
  template: `
    <div class="billing-page"><header class="billing-context"><div><h1>{{siteName()||'Site'}}</h1><p>Billing · meters, accounts, invoices and payments</p></div></header><div class="billing-scroll"><div class="billing-content page-container">

      @if (probeError(); as pe) {
        <app-billing-page-error [text]="pe" (retry)="retryProbe()" />
      } @else if (capability() === null) {
        <div class="flex items-center justify-center py-24"><span class="loading loading-spinner loading-lg"></span></div>
      } @else if (capability() === false) {
        <div class="rounded-2xl border border-dashed border-base-300/50 py-16 text-center">
          <p class="text-base font-medium">Tenant billing is not enabled for this site</p>
          <p class="text-sm text-base-content/50 mt-1">Contact your provider to enable the billing module on this site.</p>
        </div>
      } @else {
        <!-- Attention: needs-your-eyes signals, absent when calm (same principle
             as the dashboard banner). -->
        @for (a of attention(); track a.text) {
          <div class="alert text-sm py-2" role="alert"
               [class]="a.tone === 'error' ? 'alert-error' : 'alert-warning'">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            </svg>
            <span class="flex-1">{{ a.text }}</span>
            <a [routerLink]="a.link" class="link link-hover font-medium shrink-0">{{ a.linkText }} →</a>
          </div>
        }

        <!-- Section tab bar: horizontally scrollable on mobile instead of a
             ragged wrap; badges carry the live overdue/pending counts. -->
        <nav class="flex gap-1 overflow-x-auto rounded-xl border border-base-300/40 bg-base-100 p-1" aria-label="Billing sections">
          <a [routerLink]="['/site', siteId(), 'billing']" [routerLinkActiveOptions]="{ exact: true }" routerLinkActive="btn-active"
             class="btn btn-ghost btn-sm shrink-0 whitespace-nowrap">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 17l5-5 4 4 8-8"/>
            </svg>
            Overview
          </a>
          <a [routerLink]="['/site', siteId(), 'billing', 'meters']" routerLinkActive="btn-active"
             class="btn btn-ghost btn-sm shrink-0 whitespace-nowrap">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z"/>
            </svg>
            Meters
            @if (pendingCommands() > 0) {
              <span class="badge badge-info badge-xs tabular-nums">{{ pendingCommands() }}</span>
            }
          </a>
          <a [routerLink]="['/site', siteId(), 'billing', 'tenants']" routerLinkActive="btn-active"
             class="btn btn-ghost btn-sm shrink-0 whitespace-nowrap">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
            </svg>
            Tenants &amp; units
          </a>
          <a [routerLink]="['/site', siteId(), 'billing', 'invoices']" routerLinkActive="btn-active"
             class="btn btn-ghost btn-sm shrink-0 whitespace-nowrap">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
            Invoices
            @if (overdueInvoices().length > 0) {
              <span class="badge badge-warning badge-xs tabular-nums">{{ overdueInvoices().length }}</span>
            }
          </a>
          <a [routerLink]="['/site', siteId(), 'billing', 'settings']" routerLinkActive="btn-active"
             class="btn btn-ghost btn-sm shrink-0 whitespace-nowrap">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
            Settings
          </a>
        </nav>
        <router-outlet />
      }
    </div></div></div>
  `,
})
export class BillingShellComponent {
  private route = inject(ActivatedRoute);
  private backend = inject(BackendService);
  private billing = inject(BillingService);
  private auth = inject(AuthStore);

  readonly siteId = signal(this.route.snapshot.paramMap.get('name') ?? '');
  readonly siteName = signal('');
  /** null = probing; true/false once the capability endpoint answered. */
  readonly capability = signal<boolean | null>(null);
  /** Set when the capability probe itself failed — distinct from a definitive false. */
  protected probeError = signal('');

  /** Attention-banner inputs, loaded once the capability check passes. */
  protected overdueInvoices = signal<Invoice[]>([]);
  protected pendingCommands = signal(0);
  protected failedCommands = signal(0);
  protected settings = signal<BillingSettings | null>(null);
  protected meters = signal<MeterDevice[]>([]);

  /** Delete rules on the billing master-data collections are admin-only. */
  readonly isAdmin = computed(() => this.auth.isAdmin());

  /** The absent-when-calm rows: overdue debt, armed auto-disconnection,
   *  failed/expired downlinks, silent meters. */
  protected attention = computed<AttentionRow[]>(() => {
    const id = this.siteId();
    const rows: AttentionRow[] = [];
    const overdue = this.overdueInvoices();
    if (overdue.length > 0) {
      const total = overdue.reduce((s, i) => s + Math.max(0, i.total_minor - i.allocated_minor), 0);
      const currency = overdue.find((i) => i.currency)?.currency || 'KES';
      rows.push({
        tone: 'warning',
        text: `${overdue.length} overdue invoice${overdue.length === 1 ? '' : 's'} totalling ${formatMoney(total, currency)}.`,
        link: ['/site', id, 'billing', 'invoices'],
        linkText: 'Invoices',
      });
    }
    if (this.settings()?.auto_valve_enabled) {
      rows.push({
        tone: 'warning',
        text: 'Auto-disconnection is armed — overdue accounts past the warn window get their valve closed automatically.',
        link: ['/site', id, 'billing', 'settings'],
        linkText: 'Settings',
      });
    }
    const failed = this.failedCommands();
    if (failed > 0) {
      rows.push({
        tone: 'error',
        text: `${failed} valve command${failed === 1 ? '' : 's'} failed or expired in the last 7 days.`,
        link: ['/site', id, 'billing', 'meters'],
        linkText: 'Meters',
      });
    }
    const silent = this.meters().filter((m) => {
      const t = m.last_uplink_at ? Date.parse(m.last_uplink_at) : 0;
      return !t || Date.now() - t > METER_SILENCE_MS;
    }).length;
    if (silent > 0) {
      rows.push({
        tone: 'warning',
        text: `${silent} meter${silent === 1 ? '' : 's'} with no contact in over 48 hours.`,
        link: ['/site', id, 'billing', 'meters'],
        linkText: 'Meters',
      });
    }
    return rows;
  });

  constructor() {
    const id = this.siteId();
    if (id) void this.load(id);
  }

  protected retryProbe(): void {
    this.probeError.set('');
    this.capability.set(null);
    void this.load(this.siteId());
  }

  private async load(siteId: string): Promise<void> {
    try {
      const { site } = await this.backend.siteLoad(siteId);
      this.siteName.set(site.friendlyName);
    } catch { /* name is cosmetic */ }
    try {
      this.capability.set(await this.billing.capability(siteId));
    } catch (e) {
      // 403 = caller isn't an owner of this site (e.g. a partner): billing is
      // owner-only, so render the "not enabled" state, not a retryable error.
      // Any other failure (network/5xx) is NOT "not enabled" — show the error
      // state with a retry instead of an entitlement fact.
      if ((e as { status?: number })?.status === 403) {
        this.capability.set(false);
        return;
      }
      this.probeError.set(pbMessage(e));
      return;
    }
    if (this.capability() === true) void this.loadAttention(siteId);
  }

  /** Secondary surface: any failed leg degrades to its zero value so the
   *  banner just stays quiet for that row. */
  private async loadAttention(siteId: string): Promise<void> {
    const [overdue, pending, failed, settings, meters] = await Promise.all([
      this.billing.listOverdueInvoices(siteId).catch(() => [] as Invoice[]),
      this.billing.countPendingValveCommands(siteId).catch(() => 0),
      this.billing.countFailedValveCommands(siteId).catch(() => 0),
      this.billing.loadSettings(siteId).catch(() => null),
      this.billing.listMeters(siteId).catch(() => [] as MeterDevice[]),
    ]);
    this.overdueInvoices.set(overdue);
    this.pendingCommands.set(pending);
    this.failedCommands.set(failed);
    this.settings.set(settings);
    this.meters.set(meters);
  }
}
