import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { RouterOutlet, RouterLink, Router, NavigationEnd } from '@angular/router';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { AuthStore } from './core/services/auth.store';
import { RealtimeService } from './core/services/realtime.service';
import { TrackingService } from './core/services/tracking.service';
import { FeatureFlagsService } from './core/services/feature-flags.service';
import { BrandingService } from './core/services/branding.service';
import { BackendService } from './core/services/backend.service';
import { ConfirmDialogComponent } from './shared/confirm-dialog/confirm-dialog.component';
import { AlertsCenterComponent } from './shared/alerts-center.component';
import { PersonaSwitcherComponent } from './shared/persona-switcher.component';
import { NavigationIconComponent } from './shared/navigation-icon.component';
import { BRAND_LOGO_SVG } from './shared/brand-logo';
import { DEVICE_MODE } from './core/tokens/device-mode';
import { resolveNavigation, type NavigationItem } from './core/navigation';
import { CapabilitiesService } from './widgets/capabilities.service';
import { filter } from 'rxjs';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, ConfirmDialogComponent, AlertsCenterComponent, PersonaSwitcherComponent, NavigationIconComponent],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected auth = inject(AuthStore);
  protected branding = inject(BrandingService);
  protected deviceMode = inject(DEVICE_MODE);
  private backend = inject(BackendService);
  private capabilities = inject(CapabilitiesService);
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);
  private swUpdate = inject(SwUpdate);
  private realtime = inject(RealtimeService);

  // Instantiated at bootstrap so first-touch attribution is captured no matter
  // which public page the inbound link lands on.
  private tracking = inject(TrackingService);

  // Loads the operator feature flags at bootstrap so guards/nav never wait long.
  protected featureFlags = inject(FeatureFlagsService);

  /** Live SSE stream state — drives the global "Reconnecting…" banner. */
  protected connection = this.realtime.connection;

  protected logoSvg: SafeHtml;
  protected mobileLogoSvg: SafeHtml;
  private currentUrl = signal('/overview');
  /** Collapsed is the default; expansion adds labels and site context only. */
  protected railExpanded = signal(false);

  /** The site workspace currently carried by the URL. The global rail changes
   *  vocabulary at this boundary: platform navigation outside a site, operational
   *  navigation inside one. The route remains the source of truth. */
  protected siteId = computed(() => /^\/site\/([^/?#]+)/.exec(this.currentUrl())?.[1] ?? '');
  protected inSite = computed(() => !!this.siteId());
  protected accountInitials = computed(() => {
    const email = this.auth.user()?.email?.trim();
    if (!email) return this.deviceMode ? 'L' : 'U';
    const stem = email.split('@')[0];
    const words = stem.split(/[._-]+/).filter(Boolean);
    return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : stem.slice(0, 2)).toUpperCase();
  });
  protected shellSiteName = signal('');
  private shellSiteGeneration = 0;
  private siteCapabilities = computed<ReadonlySet<string>>(() => {
    const siteId = this.siteId();
    if (!siteId || this.deviceMode) return new Set();
    const state = this.capabilities.capabilities(siteId)();
    return new Set(Array.isArray(state) ? state : []);
  });
  protected navigationItems = computed(() => resolveNavigation({
    workspace: this.inSite() ? 'site' : 'platform',
    siteId: this.siteId() || undefined,
    role: this.auth.role(),
    deviceMode: this.deviceMode,
    features: new Set([
      ...(this.featureFlags.isEnabled('billing_module') ? ['billing_module'] : []),
      ...(this.featureFlags.isEnabled('partner_portal') ? ['partner_portal'] : []),
    ]),
    capabilities: this.siteCapabilities(),
  }));
  protected primaryNavigation = computed(() => this.navigationItems().filter((item) => item.position === 'primary'));
  protected footerNavigation = computed(() => this.navigationItems().filter((item) => item.position === 'footer'));
  /** Persistent high-frequency destinations. Billing and other infrequent items
   * remain in the mobile sheet so the bottom bar never exceeds five targets. */
  protected mobileBottomNavigation = computed(() => {
    const items = this.navigationItems();
    if (this.inSite()) {
      const core = ['operate', 'insights', 'automations', 'system', 'settings'];
      return core.flatMap((id) => items.filter((item) => item.id === id));
    }
    return [...items.filter((item) => item.position === 'primary').slice(0, 4), ...items.filter((item) => item.position === 'footer').slice(0, 1)];
  });

  /** RouteLinkActive cannot distinguish `/site/:id` (System) from every other
   *  site child. Match the resolved destination explicitly so exactly one
   *  primary destination owns the active state at a time. */
  protected navigationActive(item: NavigationItem): boolean {
    const current = this.currentUrl().split(/[?#]/, 1)[0].replace(/\/$/, '');
    const destination = item.link.join('/').replace(/\/$/, '');
    if (item.id === 'system') return current === destination || current.startsWith(`${destination}/system/`);
    return current === destination || current.startsWith(`${destination}/`);
  }

  // Set once the service worker has fetched a new app version and is ready to
  // activate it. Surfaces a "Reload" toast; the new build only takes over after
  // a full reload, so we let the user pick the moment.
  protected updateReady = signal(false);

  // Public, full-bleed pages (landing + login + pricing) bring their own branded
  // layout, so the app shell hides its top bar there.
  protected isPublic = computed(() => {
    const url = this.currentUrl().split(/[?#]/, 1)[0];
    return url === '/' || url === '' || url.startsWith('/login') || url.startsWith('/pricing') || url.startsWith('/features') || url.startsWith('/how-it-works');
  });

  constructor() {
    this.logoSvg = this.sanitizer.bypassSecurityTrustHtml(BRAND_LOGO_SVG);
    // Both responsive shells stay mounted. Unique gradient ids stop the hidden
    // desktop mark from stealing the visible mobile mark's paint references.
    const mobileLogo = BRAND_LOGO_SVG
      .replaceAll('mf1', 'mf1-mobile')
      .replaceAll('mf2', 'mf2-mobile')
      .replaceAll('mf3', 'mf3-mobile');
    this.mobileLogoSvg = this.sanitizer.bypassSecurityTrustHtml(mobileLogo);

    // Disabled in dev and where the SW is unsupported — guard so nothing fires.
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => this.updateReady.set(true));
    }
  }

  ngOnInit() {
    this.currentUrl.set(this.router.url);
    void this.loadShellSiteName();
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.currentUrl.set(e.urlAfterRedirects);
        void this.loadShellSiteName();
      });
  }

  private async loadShellSiteName(): Promise<void> {
    const siteId = this.siteId();
    const gen = ++this.shellSiteGeneration;
    this.shellSiteName.set('');
    if (!siteId) return;
    try {
      const { site } = await this.backend.siteLoad(siteId);
      if (gen === this.shellSiteGeneration) this.shellSiteName.set(site.friendlyName || siteId);
    } catch {
      if (gen === this.shellSiteGeneration) this.shellSiteName.set(siteId);
    }
  }

  protected reloadApp(): void {
    document.location.reload();
  }

  protected logout(): void {
    this.auth.logout();
    void this.router.navigate(['/login']);
  }

  protected toggleRail(): void {
    this.railExpanded.update((expanded) => !expanded);
  }

  /** Shared pointer feedback for high-intent controls. Event delegation keeps
   * the effect coherent across lazy pages without a directive on every button. */
  protected showPressRipple(event: PointerEvent): void {
    if (event.button !== 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const origin = event.target instanceof Element ? event.target : null;
    const target = origin?.closest<HTMLElement>(
      'button:not(:disabled):not([data-no-ripple]), a.btn, a.mkt-btn, .rail-link, .mobile-bottom-nav a, [role="button"]:not([data-no-ripple])',
    );
    if (!target || !event.currentTarget || !(event.currentTarget as Element).contains(target)) return;

    const rect = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ui-ripple';
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    ripple.style.setProperty('--ripple-scale', String(Math.ceil(Math.hypot(rect.width, rect.height) * 2)));
    target.classList.add('ui-ripple-host');
    target.append(ripple);
    ripple.addEventListener('animationend', () => {
      ripple.remove();
      if (!target.querySelector('.ui-ripple')) target.classList.remove('ui-ripple-host');
    }, { once: true });
  }
}
