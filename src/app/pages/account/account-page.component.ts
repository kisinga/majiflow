import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { BackendService } from '../../core/services/backend.service';
import { AuthStore } from '../../core/services/auth.store';
import { DEFAULT_NOTIFICATION_PREFS } from '../../core/models/alerts';
import { SiteThresholdsComponent } from './site-thresholds.component';

/** A site the signed-in user owns, for the per-site threshold editors. */
interface OwnedSite { id: string; name: string }

/**
 * Account / notifications page - per-user notification preferences plus the
 * per-site alert thresholds the enabled types depend on.
 *
 * The toggles (one `notification_prefs` row per user, find-or-create) gate which
 * alert types reach the in-app bell and whether the server also sends them via
 * WhatsApp/OpenWA or email. Two of those types have a tunable level, stored
 * per-site on the `sites` record: the tank-level alert (low/full %) and the
 * controller-offline alert (timeout). So when either is on, a thresholds section
 * appears below with one editor per owned site, showing only the fields for the
 * alerts that are actually enabled.
 */
@Component({
  selector: 'app-account-page',
  standalone: true,
  imports: [SiteThresholdsComponent],
  host: { class: 'flex-1 overflow-auto' },
  template: `
    <div class="content-pane space-y-6">
      <header>
        <h1 class="app-title text-lg font-bold">Notifications</h1>
        <p class="text-xs text-base-content/50 mt-0.5">{{ auth.user()?.email }}</p>
      </header>

      @if (loading()) {
        <div class="flex items-center justify-center py-24"><span class="loading loading-spinner loading-lg text-primary"></span></div>
      } @else {
        <section class="surface p-5 space-y-4">
          <div>
            <h2 class="font-semibold text-sm">Account details</h2>
            <p class="text-[11px] text-base-content/40 mt-0.5">Your contact details for support and account follow-up.</p>
          </div>

          <div class="grid sm:grid-cols-2 gap-3">
            <label class="flex flex-col gap-1">
              <span class="label-text text-xs text-base-content/60">Name</span>
              <input
                type="text"
                class="input input-bordered input-sm"
                [disabled]="savingProfile()"
                [value]="accountName()"
                (input)="setAccountName($any($event.target).value)"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="label-text text-xs text-base-content/60">Phone</span>
              <input
                type="tel"
                class="input input-bordered input-sm"
                placeholder="+254712345678"
                [disabled]="savingProfile()"
                [value]="accountPhone()"
                (input)="setAccountPhone($any($event.target).value)"
              />
            </label>
            <label class="flex flex-col gap-1 sm:col-span-2">
              <span class="label-text text-xs text-base-content/60">Email</span>
              <input type="email" class="input input-bordered input-sm" [value]="accountEmail()" disabled />
              <span class="text-[11px] text-base-content/40">Email changes are handled by an admin so account access stays controlled.</span>
            </label>
          </div>

          <div class="flex items-center gap-3 pt-2 border-t border-base-300/30">
            <button class="btn btn-primary btn-sm w-24" (click)="saveProfile()" [disabled]="savingProfile()">
              @if (savingProfile()) { <span class="loading loading-spinner loading-xs"></span> } @else { Save }
            </button>
            @if (profileSaved()) { <span class="text-xs text-emerald-400">Saved</span> }
            @if (profileError()) { <span class="text-xs text-error">{{ profileError() }}</span> }
          </div>
        </section>

        <!-- Which alerts, and where they go. Per-user; one Save commits the lot. -->
        <section class="surface p-5 space-y-4">
          <div>
            <h2 class="font-semibold text-sm">Alerts you receive</h2>
            <p class="text-[11px] text-base-content/40 mt-0.5">Choose which alerts reach the in-app bell, WhatsApp and email.</p>
          </div>

          <div class="space-y-2.5">
            @for (t of types; track t.key) {
              <label class="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5 shrink-0" [disabled]="saving()"
                  [checked]="value(t.key)" (change)="set(t.key, $any($event.target).checked)" />
                <span class="min-w-0">
                  <span class="text-sm">{{ t.label }}</span>
                  @if (t.hasThreshold && value(t.key)) {
                    <span class="block text-[11px] text-base-content/40">Set the level under Alert thresholds below.</span>
                  }
                </span>
              </label>
            }
          </div>

          <div class="pt-3 border-t border-base-300/30 space-y-3">
            <div class="space-y-2">
              <label class="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" class="toggle toggle-sm toggle-primary" [disabled]="saving()"
                  [checked]="channelWhatsApp()" (change)="setChannelWhatsApp($any($event.target).checked)" />
                <span class="text-sm">WhatsApp me alerts</span>
              </label>
              <div class="pl-12 max-w-sm">
                <div class="join w-full">
                  <select
                    class="select select-bordered select-sm join-item w-32"
                    [disabled]="saving() || !channelWhatsApp()"
                    [value]="whatsAppCountryCode()"
                    (change)="setWhatsAppCountryCode($any($event.target).value)"
                    aria-label="WhatsApp country code"
                  >
                    @for (c of countryCodes; track c.code) {
                      <option [value]="c.code">{{ c.label }}</option>
                    }
                  </select>
                  <input
                    type="tel"
                    class="input input-bordered input-sm join-item min-w-0 flex-1"
                    placeholder="0712345678"
                    [disabled]="saving() || !channelWhatsApp()"
                    [value]="whatsAppChatId()"
                    (input)="setWhatsAppChatId($any($event.target).value)"
                  />
                </div>
                <p class="text-[11px] text-base-content/40 mt-1">Kenyan numbers can be entered as 0712345678, +254712345678, or 254712345678.</p>
              </div>
            </div>
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" class="toggle toggle-sm toggle-primary" [disabled]="saving()"
                [checked]="channelEmail()" (change)="setChannelEmail($any($event.target).checked)" />
              <span class="text-sm">Email me alerts</span>
            </label>
            <p class="text-[11px] text-base-content/40 pl-12">Sent to {{ auth.user()?.email }} even when the app is closed. Requires email to be configured on the server.</p>
          </div>

          <div class="flex items-center gap-3 pt-2 border-t border-base-300/30">
            <button class="btn btn-primary btn-sm w-24" (click)="save()" [disabled]="saving()">
              @if (saving()) { <span class="loading loading-spinner loading-xs"></span> } @else { Save }
            </button>
            @if (saved()) { <span class="text-xs text-emerald-400">Saved</span> }
            @if (error()) { <span class="text-xs text-error">{{ error() }}</span> }
          </div>
        </section>

        @if (auth.isAdmin()) {
          <section class="surface p-5 space-y-4">
            <div>
              <h2 class="font-semibold text-sm">Test WhatsApp alert</h2>
              <p class="text-[11px] text-base-content/40 mt-0.5">Send a live test message to any number.</p>
            </div>

            <div class="join w-full max-w-sm">
              <select
                class="select select-bordered select-sm join-item w-32"
                [disabled]="testing()"
                [value]="testCountryCode()"
                (change)="setTestCountryCode($any($event.target).value)"
                aria-label="Test country code"
              >
                @for (c of countryCodes; track c.code) {
                  <option [value]="c.code">{{ c.label }}</option>
                }
              </select>
              <input
                type="tel"
                class="input input-bordered input-sm join-item min-w-0 flex-1"
                placeholder="0712345678"
                [disabled]="testing()"
                [value]="testNumber()"
                (input)="setTestNumber($any($event.target).value)"
              />
            </div>

            <div class="flex items-center gap-3">
              <button class="btn btn-secondary btn-sm w-28" (click)="sendTestNotification()" [disabled]="testing() || !testNumber().trim()">
                @if (testing()) { <span class="loading loading-spinner loading-xs"></span> } @else { Send test }
              </button>
              @if (testSent()) { <span class="text-xs text-emerald-400">Sent to {{ testSent() }}</span> }
              @if (testError()) { <span class="text-xs text-error">{{ testError() }}</span> }
            </div>
          </section>
        }

        <!-- Thresholds for the enabled alerts, per site. The values live on each
             site, so they're edited (and saved) per site, not with the prefs above. -->
        @if (showTank() || showOffline()) {
          <section class="surface p-5 space-y-4">
            <div>
              <h2 class="font-semibold text-sm">Alert thresholds</h2>
              <p class="text-[11px] text-base-content/40 mt-0.5">The levels that trigger the alerts above, set per site.</p>
            </div>

            @if (sites().length) {
              <div class="space-y-3">
                @for (s of sites(); track s.id) {
                  <div class="rounded-xl ring-1 ring-base-300/40 p-4 space-y-3">
                    <div class="text-xs font-semibold text-base-content/60">{{ s.name }}</div>
                    <app-site-thresholds [siteId]="s.id" [showTank]="showTank()" [showOffline]="showOffline()" />
                  </div>
                }
              </div>
            } @else {
              <p class="text-sm text-base-content/50 py-2">No sites yet. Thresholds appear here once you own a site.</p>
            }
          </section>
        }
      }
    </div>
  `,
})
export class AccountPageComponent implements OnInit {
  private backend = inject(BackendService);
  protected auth = inject(AuthStore);

  protected readonly types = [
    { key: 'alert_device_offline', label: 'Controller offline', hasThreshold: true },
    { key: 'alert_device_online', label: 'Controller back online', hasThreshold: false },
    { key: 'alert_fault', label: 'Faults (no flow, tank low, max runtime)', hasThreshold: false },
    { key: 'alert_tank', label: 'Tank level (low / full volume)', hasThreshold: true },
    { key: 'alert_run_start', label: 'Run started', hasThreshold: false },
    { key: 'alert_run_stop', label: 'Run stopped', hasThreshold: false },
    { key: 'alert_command_failed', label: 'Command did not apply', hasThreshold: false },
  ] as const;

  protected loading = signal(true);
  protected saving = signal(false);
  protected saved = signal(false);
  protected error = signal<string | null>(null);
  protected savingProfile = signal(false);
  protected profileSaved = signal(false);
  protected profileError = signal<string | null>(null);
  protected accountName = signal('');
  protected accountEmail = signal('');
  protected accountPhone = signal('');
  protected testing = signal(false);
  protected testNumber = signal('');
  protected testCountryCode = signal(DEFAULT_NOTIFICATION_PREFS.whatsapp_country_code);
  protected testSent = signal('');
  protected testError = signal<string | null>(null);

  // Alert-type toggles. The email/WhatsApp channels are tracked separately.
  // Offline/online pairs and run transitions are opt-in (noisy); the rest default on.
  private flags = signal<Record<string, boolean>>({
    alert_device_offline: false,
    alert_device_online: false,
    alert_fault: true,
    alert_tank: true,
    alert_run_start: false,
    alert_run_stop: false,
    alert_command_failed: true,
  });
  protected channelEmail = signal(DEFAULT_NOTIFICATION_PREFS.channel_email);
  // WhatsApp defaults on; users can still turn it off explicitly.
  protected channelWhatsApp = signal(DEFAULT_NOTIFICATION_PREFS.channel_whatsapp);
  protected whatsAppChatId = signal(DEFAULT_NOTIFICATION_PREFS.whatsapp_chat_id);
  protected whatsAppCountryCode = signal(DEFAULT_NOTIFICATION_PREFS.whatsapp_country_code);
  private recordId = '';

  protected readonly countryCodes = [
    { code: '254', label: 'KE +254' },
    { code: '255', label: 'TZ +255' },
    { code: '256', label: 'UG +256' },
    { code: '250', label: 'RW +250' },
    { code: '44', label: 'UK +44' },
  ] as const;

  /** Sites the user owns - each gets a threshold editor in the section below. */
  protected sites = signal<OwnedSite[]>([]);

  // The thresholds section follows the live toggle state (immediate feedback),
  // not the last-saved prefs: tank-level → low/full %, controller-offline → timeout.
  protected showTank = computed(() => this.flags()['alert_tank'] ?? true);
  protected showOffline = computed(() => this.flags()['alert_device_offline'] ?? false);

  protected value(key: string): boolean {
    return this.flags()[key] ?? true;
  }
  protected set(key: string, v: boolean): void {
    this.flags.update((f) => {
      const next = { ...f, [key]: v };
      // Recovery is the other half of the offline subscription: enabling
      // "Controller offline" implies wanting "back online" too (the user can
      // still uncheck it). Opting into offline without recovery is how the
      // "never got the back-online notification" gap kept recurring.
      if (key === 'alert_device_offline' && v) next['alert_device_online'] = true;
      return next;
    });
    this.saved.set(false); // edits invalidate the "Saved" confirmation
  }
  protected setChannelEmail(v: boolean): void {
    this.channelEmail.set(v);
    this.saved.set(false);
  }
  protected setChannelWhatsApp(v: boolean): void {
    this.channelWhatsApp.set(v);
    this.saved.set(false);
  }
  protected setWhatsAppChatId(v: string): void {
    this.whatsAppChatId.set(v);
    this.saved.set(false);
  }
  protected setWhatsAppCountryCode(v: string): void {
    this.whatsAppCountryCode.set(v);
    this.saved.set(false);
  }
  protected setAccountName(v: string): void {
    this.accountName.set(v);
    this.profileSaved.set(false);
  }
  protected setAccountPhone(v: string): void {
    this.accountPhone.set(v);
    this.profileSaved.set(false);
  }
  protected setTestNumber(v: string): void {
    this.testNumber.set(v);
    this.testSent.set('');
    this.testError.set(null);
  }
  protected setTestCountryCode(v: string): void {
    this.testCountryCode.set(v);
    this.testSent.set('');
    this.testError.set(null);
  }

  async ngOnInit() {
    const user = this.auth.user();
    if (!user) { this.loading.set(false); return; }
    void this.loadSites(user.id);
    try {
      const profile = await this.backend.accountProfile();
      this.accountName.set(profile.name);
      this.accountEmail.set(profile.email);
      this.accountPhone.set(profile.phone);

      const r = await this.backend.pb
        .collection('notification_prefs')
        .getFirstListItem(this.backend.pb.filter('user = {:u}', { u: user.id }), { requestKey: 'prefs:edit' });
      this.recordId = r['id'];
      this.flags.set({
        alert_device_offline: r['alert_device_offline'] === true, // opt-in
        alert_device_online: r['alert_device_online'] === true,  // opt-in
        alert_fault: r['alert_fault'] !== false,
        alert_tank: r['alert_tank'] !== false,
        alert_run_start: r['alert_run_start'] === true, // opt-in
        alert_run_stop: r['alert_run_stop'] === true,   // opt-in
        alert_command_failed: r['alert_command_failed'] !== false,
      });
      this.channelEmail.set(r['channel_email'] === true);
      this.channelWhatsApp.set(r['channel_whatsapp'] === true);
      this.whatsAppChatId.set((r['whatsapp_chat_id'] ?? '') as string);
      this.whatsAppCountryCode.set((r['whatsapp_country_code'] ?? DEFAULT_NOTIFICATION_PREFS.whatsapp_country_code) as string);
    } catch {
      // No row yet - defaults already loaded.
    } finally {
      this.loading.set(false);
    }
  }

  protected async saveProfile(): Promise<void> {
    this.savingProfile.set(true);
    this.profileSaved.set(false);
    this.profileError.set(null);
    try {
      const profile = await this.backend.accountSave({
        name: this.accountName().trim(),
        phone: this.accountPhone().trim(),
      });
      this.accountName.set(profile.name);
      this.accountEmail.set(profile.email);
      this.accountPhone.set(profile.phone);
      this.profileSaved.set(true);
    } catch (err) {
      this.profileError.set(String(err));
    } finally {
      this.savingProfile.set(false);
    }
  }

  /** Load the sites this user owns, for the per-site threshold editors. */
  private async loadSites(userId: string): Promise<void> {
    try {
      // Display name is the `name` field; the owners multi-relation is `owner`
      // (see BackendService.siteLoad). Non-admins are already list-scoped to their
      // sites server-side, but filtering keeps it correct for admins too.
      const rows = await this.backend.pb.collection('sites').getFullList({
        filter: this.backend.pb.filter('owner ~ {:u}', { u: userId }),
        fields: 'id,name',
        sort: 'name',
        requestKey: 'prefs:sites',
      });
      this.sites.set(rows.map((r) => ({ id: r['id'], name: (r['name'] as string) || r['id'] })));
    } catch {
      // Leave empty - the thresholds section shows a gentle empty state.
    }
  }

  async save() {
    const user = this.auth.user();
    if (!user) return;
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    const body = {
      user: user.id,
      ...this.flags(),
      channel_whatsapp: this.channelWhatsApp(),
      whatsapp_chat_id: this.whatsAppChatId().trim(),
      whatsapp_country_code: this.whatsAppCountryCode(),
      channel_email: this.channelEmail(),
    };
    try {
      if (this.recordId) {
        await this.backend.pb.collection('notification_prefs').update(this.recordId, body);
      } else {
        const r = await this.backend.pb.collection('notification_prefs').create(body);
        this.recordId = r['id'];
      }
      this.saved.set(true); // stays until the next edit clears it
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async sendTestNotification(): Promise<void> {
    this.testing.set(true);
    this.testSent.set('');
    this.testError.set(null);
    try {
      const res = await this.backend.sendTestNotification({
        number: this.testNumber().trim(),
        countryCode: this.testCountryCode(),
      });
      this.testSent.set(res.chatId);
    } catch (err) {
      this.testError.set(String(err));
    } finally {
      this.testing.set(false);
    }
  }
}
