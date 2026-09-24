import { Component, inject, signal, type OnDestroy, type OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AutomationsManagerComponent } from './automations-manager.component';
import { BackendService } from '../../core/services/backend.service';

/**
 * AutomationsComponent (`/site/:name/automations`) - the standalone page for the
 * operator automation manager. This is the first-class cross-route destination;
 * the same presentation-neutral manager is also hosted in the route-scoped
 * operator dialog, where its route is prefilled and locked.
 */
@Component({
  selector: 'app-automations',
  standalone: true,
  imports: [AutomationsManagerComponent],
  host: { class: 'flex-1 min-h-0 min-w-0 flex overflow-hidden' },
  styles: [`
    :host{--color-base-100:var(--op-shell);--color-base-200:var(--op-panel);--color-base-300:var(--op-border);--color-base-content:var(--op-ink);--color-primary:var(--op-brand);--color-primary-content:#fff}.page{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;background:transparent;color:var(--op-ink)}.context{height:64px;min-height:64px;padding:0 24px;display:flex;align-items:center;border-bottom:1px solid var(--op-border);background:rgb(255 255 255/.88);box-shadow:0 5px 18px rgb(18 35 59/.045);backdrop-filter:blur(16px) saturate(1.2)}.context h1{margin:0;font-size:18px;font-weight:800}.context p{margin:3px 0 0;color:var(--op-muted);font-size:11px}.scroll{flex:1;min-height:0;overflow:auto}.page-intro{margin-bottom:20px}.page-intro h2{margin:0;font-size:20px;font-weight:800}.page-intro p{max-width:42rem;margin:5px 0 0;color:var(--op-muted);font-size:13px;line-height:1.5}.manager-surface{padding:20px;border:1px solid var(--op-border);border-radius:18px;background:#fff;box-shadow:var(--op-shadow-sm)}@media(max-width:767.98px){.context{display:none}.manager-surface{padding:14px;border-radius:15px}}
  `],
  template: `
    <div class="page">
      <header class="context"><div><h1>{{siteName()||'Site'}}</h1><p>Automations · schedules and route targets</p></div></header>
      <div class="scroll"><div class="content page-container">
        <div class="page-intro"><h2>Automations</h2><p>Run a route on a schedule or tank-level trigger. Every automation inherits the route's safe defaults unless you explicitly override a target.</p></div>
        <section class="manager-surface">@if(siteId()){<app-automations-manager [siteId]="siteId()" [focusRouteKey]="focusRouteKey()" [showRouteDefaults]="false"/>}</section>
      </div></div>
    </div>
  `,
})
export class AutomationsComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private backend = inject(BackendService);
  protected siteId = signal(this.route.snapshot.paramMap.get('name') ?? '');
  protected siteName = signal('');
  protected focusRouteKey = signal(this.route.snapshot.queryParamMap.get('route') ?? '');
  private querySub = this.route.queryParamMap.subscribe((params) => this.focusRouteKey.set(params.get('route') ?? ''));
  ngOnInit(): void {
    const id = this.siteId();
    if (id) void this.backend.siteLoad(id).then(({ site }) => this.siteName.set(site.friendlyName)).catch(() => this.siteName.set(id));
  }
  ngOnDestroy(): void { this.querySub.unsubscribe(); }
}
