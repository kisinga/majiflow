import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DashboardStore } from '../dashboard.store';
import { CommandLifecycleStore } from '../command-lifecycle.store';
import { ConfirmService } from '../../../core/services/confirm.service';
import { TunableNumbersComponent } from './tunable-numbers.component';
import { TankCalibrationComponent } from './tank-calibration.component';

type SettingsSection = 'operations' | 'routes' | 'equipment' | 'advanced';

interface SettingsNavItem {
  id: SettingsSection;
  label: string;
  description: string;
}

/** Site-scoped settings. Configuration is edited in place; this component never
 * opens a second navigation layer or duplicates Automations. */
@Component({
  selector: 'app-site-controls',
  standalone: true,
  imports: [TunableNumbersComponent, TankCalibrationComponent],
  host: { class: 'block' },
  styles: [`
    :host{--line:var(--op-border,#cfdae7);color:var(--op-ink,#12233b)}button{font:inherit}.settings-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px;align-items:start}.settings-nav{position:sticky;top:16px;display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid var(--line);border-radius:15px;background:var(--op-panel,#edf3f8)}.settings-nav button{min-height:54px;padding:9px 11px;display:flex;align-items:center;gap:10px;border-radius:10px;color:var(--op-muted,#60738a);text-align:left;transition:background var(--motion-selection,170ms) var(--ease-standard,ease),color var(--motion-selection,170ms) var(--ease-standard,ease),box-shadow var(--motion-selection,170ms) var(--ease-standard,ease)}.settings-nav button:hover{color:var(--op-ink,#12233b);background:rgb(255 255 255/.58)}.settings-nav button.is-active{color:var(--op-brand-deep,#0369a1);background:#fff;box-shadow:0 1px 3px rgb(18 35 59/.1)}.settings-nav svg{width:19px;height:19px;flex:none;stroke-linecap:round;stroke-linejoin:round}.nav-copy{min-width:0}.nav-copy strong{display:block;font-size:12px}.nav-copy span{display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;font-weight:500;color:var(--op-muted,#60738a)}
    .settings-content{min-width:0;min-height:27rem;border:1px solid var(--line);border-radius:18px;background:#fff;overflow:hidden}.section-head{padding:22px 24px 18px;border-bottom:1px solid var(--line)}.section-head h3{margin:0;font-size:17px;font-weight:800}.section-head p{max-width:44rem;margin:5px 0 0;color:var(--op-muted,#60738a);font-size:12px;line-height:1.5}.section-body{padding:22px 24px;animation:settings-section-in var(--motion-panel,230ms) var(--ease-enter,ease) both}@keyframes settings-section-in{from{opacity:0;transform:translateY(4px)}}.section-note{margin:0 0 16px;padding:11px 13px;border-left:3px solid var(--op-brand,#0284c7);border-radius:0 9px 9px 0;background:var(--op-blue-soft,#e0f2fe);color:var(--op-muted,#60738a);font-size:11px;line-height:1.5}.section-note.warning{border-color:var(--op-amber,#b76108);background:#fff3d9;color:#70410d}.empty{padding:48px 20px;text-align:center;color:var(--op-muted,#60738a);font-size:12px}
    .controller-list{display:flex;flex-direction:column;gap:10px}.controller-card{padding:15px;border:1px solid var(--line);border-radius:13px;background:var(--op-shell,#f6f9fc);transition:border-color var(--motion-selection,170ms) var(--ease-standard,ease),background var(--motion-selection,170ms) var(--ease-standard,ease)}.controller-card.is-live{border-color:color-mix(in srgb,var(--op-red,#c93636) 45%,var(--line));background:#feebea}.controller-row{display:flex;align-items:center;gap:10px}.presence{width:8px;height:8px;flex:none;border-radius:50%;background:var(--op-muted,#60738a)}.presence.online{background:var(--op-green,#0f8063);box-shadow:0 0 0 4px color-mix(in srgb,var(--op-green,#0f8063) 12%,transparent)}.controller-name{min-width:0;flex:1}.controller-name strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.controller-name span{display:block;margin-top:2px;color:var(--op-muted,#60738a);font-size:10px}.override-button{min-width:72px;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--op-muted,#60738a);font-size:11px;font-weight:800}.override-button.is-live{border-color:var(--op-red,#c93636);background:var(--op-red,#c93636);color:#fff}.override-button:disabled{opacity:.55;cursor:not-allowed}.override-warning{margin:12px 0 0;padding-top:11px;border-top:1px solid color-mix(in srgb,var(--op-red,#c93636) 22%,var(--line));color:var(--op-red,#c93636);font-size:11px;line-height:1.45}
    @media(max-width:767.98px){.settings-layout{grid-template-columns:1fr;gap:12px}.settings-nav{position:static;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));overflow-x:auto}.settings-nav button{min-width:78px;justify-content:center;padding:8px 6px}.settings-nav svg{display:none}.nav-copy{text-align:center}.nav-copy span{display:none}.settings-content{border-radius:15px}.section-head{padding:18px 16px 14px}.section-body{padding:16px}}
    @media(prefers-reduced-motion:reduce){.section-body{animation:none}}
  `],
  template: `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Site settings sections">
        @for(item of navItems();track item.id){
          <button type="button" [class.is-active]="section()===item.id" [attr.aria-current]="section()===item.id?'page':null" (click)="section.set(item.id)">
            @switch(item.id){
              @case('operations'){<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 14h4l2-7 4 12 2-5h4"/></svg>}
              @case('routes'){<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h5a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3"/></svg>}
              @case('equipment'){<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 4h14v16H5zM8 8h8M8 12h5"/></svg>}
              @case('advanced'){<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3 3 20h18L12 3Z"/><path d="M12 9v4m0 3h.01"/></svg>}
            }
            <span class="nav-copy"><strong>{{item.label}}</strong><span>{{item.description}}</span></span>
          </button>
        }
      </nav>

      <section class="settings-content">
        @switch(section()){
          @case('operations'){
            <header class="section-head"><h3>Operations</h3><p>Timing and protection values used by the controllers while routes are running.</p></header>
            <div class="section-body">
              @if(hasSafetyTimings()){
                <p class="section-note warning">These limits protect equipment and water sources. Changes are written to each controller and confirmed from its reported state.</p>
                <app-tunable-numbers [controllers]="store.spec().controllers" scope="controller" [canEdit]="canControl()" />
              }@else{<p class="empty">No controller operation settings are available for this site.</p>}
            </div>
          }
          @case('routes'){
            <header class="section-head"><h3>Route defaults</h3><p>Normal runtime, volume and level targets. Automations inherit these values unless a schedule overrides them.</p></header>
            <div class="section-body">
              @if(hasRouteDefaults()){
                <p class="section-note">Keep the normal values here. One-off targets belong on a route run; scheduled exceptions belong in Automations.</p>
                <app-tunable-numbers [controllers]="store.spec().controllers" scope="route" [canEdit]="canControl()" />
              }@else{<p class="empty">No configurable route defaults are available.</p>}
            </div>
          }
          @case('equipment'){
            <header class="section-head"><h3>Equipment</h3><p>Calibration that turns controller readings into useful physical measurements.</p></header>
            <div class="section-body">
              @if(hasCalibration()){
                <div class="controller-list">
                  @for(c of store.spec().controllers;track c.controller){
                    @if(c.calibrations.length){
                      @if(multiController()){<div class="controller-row"><span class="presence" [class.online]="store.presence(c.controller).online"></span><div class="controller-name"><strong>{{c.name}}</strong><span>{{store.presence(c.controller).online?'Online':'Offline'}}</span></div></div>}
                      @for(cal of c.calibrations;track cal.nodeId){<app-tank-calibration [cal]="cal" [controller]="c.controller" [canEdit]="canControl()" />}
                    }
                  }
                </div>
              }@else{<p class="empty">No equipment calibration is required by this topology.</p>}
            </div>
          }
          @case('advanced'){
            <header class="section-head"><h3>Advanced safety</h3><p>Commissioning controls that change the controller's protection behavior.</p></header>
            <div class="section-body">
              <p class="section-note warning">Safety override is not the Manual controls lock. It bypasses runtime protection and should remain off during normal operation.</p>
              <div class="controller-list">
                @for(c of store.spec().controllers;track c.controller){
                  @if(c.actuators.length){
                    <div class="controller-card" [class.is-live]="store.overrideOn(c.controller)">
                      <div class="controller-row"><span class="presence" [class.online]="store.presence(c.controller).online"></span><span class="controller-name"><strong>{{c.name}}</strong><span>{{store.overrideOn(c.controller)?'Protection bypassed':'Protection active'}}</span></span><button type="button" class="override-button" [class.is-live]="store.overrideOn(c.controller)" [disabled]="!canControl()||overrideBusy(c.controller)" (click)="toggleOverride(c.controller)">{{overrideBusy(c.controller)?'Updating…':(store.overrideOn(c.controller)?'Turn off':'Turn on')}}</button></div>
                      @if(store.overrideOn(c.controller)){<p class="override-warning">Tank-level gates, no-flow protection and runtime limits are bypassed on this controller. Turn the override off as soon as commissioning is complete.</p>}
                    </div>
                  }
                }@empty{<p class="empty">No actuator controllers are available.</p>}
              </div>
            </div>
          }
        }
      </section>
    </div>
  `,
})
export class SiteControlsComponent {
  /** Kept as part of the shared cloud/device interface; data comes from DashboardStore. */
  readonly siteId = input.required<string>();
  readonly canControl = input(false);
  readonly mode = input<'header' | 'page'>('page');

  protected store = inject(DashboardStore);
  private lifecycle = inject(CommandLifecycleStore);
  private confirm = inject(ConfirmService);
  protected section = signal<SettingsSection>('operations');

  protected hasSafetyTimings = computed(() => this.store.spec().controllers.some((controller) => controller.tunables.some((tunable) => tunable.scope === 'controller')));
  protected hasRouteDefaults = computed(() => this.store.spec().controllers.some((controller) => controller.tunables.some((tunable) => tunable.scope === 'route')));
  protected hasCalibration = computed(() => this.store.spec().controllers.some((controller) => controller.calibrations.length > 0));
  protected hasActuators = computed(() => this.store.spec().controllers.some((controller) => controller.actuators.length > 0));
  protected multiController = computed(() => this.store.spec().controllers.length > 1);
  protected navItems = computed<SettingsNavItem[]>(() => [
    ...(this.hasSafetyTimings() ? [{ id: 'operations' as const, label: 'Operations', description: 'Timing and protection' }] : []),
    ...(this.hasRouteDefaults() ? [{ id: 'routes' as const, label: 'Routes', description: 'Default targets' }] : []),
    ...(this.hasCalibration() ? [{ id: 'equipment' as const, label: 'Equipment', description: 'Calibration' }] : []),
    ...(this.hasActuators() ? [{ id: 'advanced' as const, label: 'Advanced', description: 'Safety override' }] : []),
  ]);

  constructor() {
    effect(() => {
      const items = this.navItems();
      if (items.length && !items.some((item) => item.id === this.section())) this.section.set(items[0].id);
    });
  }

  private overrideKey(controller: string): string { return `${controller}/override`; }
  protected overrideBusy(controller: string): boolean { return this.lifecycle.isBusy(this.overrideKey(controller)); }

  protected async toggleOverride(controller: string): Promise<void> {
    if (!this.canControl()) return;
    const turningOn = !this.store.overrideOn(controller);
    if (turningOn) {
      const name = this.store.spec().controllers.find((item) => item.controller === controller)?.name ?? controller;
      const ok = await this.confirm.confirm({
        title: 'Disable safety protection?',
        message: `Safety override bypasses tank-level gates, no-flow protection and runtime limits on ${name}. A pump can run without route protection. Use it only while commissioning hardware.`,
        confirmLabel: 'Turn on override',
        variant: 'error',
      });
      if (!ok) return;
    }
    await this.lifecycle.dispatch(this.overrideKey(controller), controller, 'safety_override', { on: turningOn });
  }
}
