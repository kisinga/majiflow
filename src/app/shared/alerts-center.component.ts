import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AlertsStore } from '../core/services/alerts.store';
import type { AlertSeverity, DerivedAlert } from '../core/models/alerts';

/**
 * AlertsCenterComponent — the navbar bell + dropdown. It is a thin view over
 * AlertsStore: the store derives the active-alert set from realtime data; this
 * just renders it, badges the unread count, and lets the user acknowledge.
 * Mounted once in the app shell, so it follows the user across pages.
 */
@Component({
  selector: 'app-alerts-center',
  standalone: true,
  imports: [RouterLink],
  styles: [`
    :host { display: contents; }
    :host-context(.global-rail) details { position: relative; }
    :host-context(.global-rail) summary {
      width: 48px;
      min-width: 48px;
      height: 48px;
      min-height: 48px;
      border-radius: 12px;
      color: var(--op-muted);
    }
    :host-context(.global-rail) .dropdown-content {
      inset: auto auto 0 calc(100% + 12px);
      margin: 0;
    }
  `],
  template: `
    <details name="global-menu" class="dropdown dropdown-end" #dd>
      <summary
        class="btn btn-ghost btn-sm btn-square touch-target list-none relative"
        [title]="count() ? count() + ' active alert(s)' : 'No active alerts'"
        aria-label="Alerts"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 00-4-5.7V5a2 2 0 10-4 0v.3A6 6 0 006 11v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        @if (count(); as n) {
          <span class="absolute -top-0.5 -right-0.5 badge badge-xs badge-error text-error-content px-1 min-w-4">{{ n > 99 ? '99+' : n }}</span>
        }
      </summary>

      <div class="dropdown-content z-50 mt-1 w-80 rounded-box bg-base-100 ring-1 ring-base-300/40 shadow-xl p-2">
        <div class="flex items-center justify-between px-1 pb-1.5">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-base-content/40">Alerts</span>
          @if (alerts().length) {
            <button class="btn btn-ghost btn-xs text-[11px]" (click)="store.ackAll()">Mark all read</button>
          }
        </div>

        @if (alerts(); as list) {
          @if (list.length === 0) {
            <div class="px-2 py-6 text-center text-xs text-base-content/40">All clear — no active alerts.</div>
          } @else {
            <ul class="max-h-96 overflow-y-auto">
              @for (a of list; track a.key) {
                <li class="flex items-start gap-2 px-1 py-1.5 border-b border-base-300/20 last:border-0">
                  <span class="w-1.5 h-1.5 mt-1.5 rounded-full shrink-0" [class]="dotClass(a.severity)"></span>
                  <a
                    [routerLink]="['/site', a.site, 'dashboard']"
                    (click)="dd.open = false"
                    class="flex-1 min-w-0 hover:opacity-80"
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-semibold truncate">{{ a.title }}</span>
                      <span class="text-[10px] text-base-content/40 shrink-0 ml-auto">{{ since(a) }}</span>
                    </div>
                    <div class="text-[11px] text-base-content/60 truncate">{{ a.message }}</div>
                    <div class="text-[10px] text-base-content/35 truncate">{{ a.siteName }}</div>
                  </a>
                  <button
                    class="btn btn-ghost btn-xs btn-square shrink-0 text-base-content/40"
                    title="Dismiss"
                    aria-label="Dismiss alert"
                    (click)="store.ack(a.key)"
                  >✕</button>
                </li>
              }
            </ul>
          }
        }
      </div>
    </details>
  `,
})
export class AlertsCenterComponent {
  protected store = inject(AlertsStore);
  protected alerts = this.store.visible;
  protected count = computed(() => this.store.unreadCount());

  /** Tick the relative time roughly with the store's own 30s clock by reading
   *  the alert ts against Date.now() at render. */
  protected since(a: DerivedAlert): string {
    const s = Math.max(0, Math.round((Date.now() - a.ts) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  }

  protected dotClass(sev: AlertSeverity): string {
    switch (sev) {
      case 'critical': return 'bg-error';
      case 'warning': return 'bg-warning';
      case 'info': return 'bg-info';
    }
  }
}
