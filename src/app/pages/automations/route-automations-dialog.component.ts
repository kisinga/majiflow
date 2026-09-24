import { AfterViewInit, Component, ElementRef, input, output, viewChild } from '@angular/core';
import { AutomationsManagerComponent } from './automations-manager.component';

/**
 * Route-scoped host for the shared automation manager. The manager remains
 * presentation-neutral: this frame owns modal semantics, focus containment,
 * responsive sizing and route context. Desktop is a bounded work dialog; phone
 * uses the full viewport so the editor never becomes a narrow nested card.
 */
@Component({
  selector: 'app-route-automations-dialog',
  standalone: true,
  imports: [AutomationsManagerComponent],
  styles: [`
    :host{--dialog-line:var(--op-border,#d7ded8);--dialog-ink:var(--op-ink,#152019);--dialog-muted:var(--op-muted,#68756d);--dialog-blue:var(--op-blue,#196ca6);--dialog-blue-soft:var(--op-blue-surface,#e0f0fb)}
    dialog{position:fixed;left:50%;top:50%;right:auto;bottom:auto;box-sizing:border-box;width:min(820px,calc(100vw - 32px));height:min(760px,calc(100dvh - 48px));max-width:none;max-height:none;margin:0;padding:0;overflow:hidden;border:1px solid var(--dialog-line);border-radius:18px;background:#fbfcfa;color:var(--dialog-ink);box-shadow:0 28px 80px rgb(21 32 25/.24);transform:translate(-50%,-50%)}
    dialog::backdrop{background:rgb(21 32 25/.36);backdrop-filter:blur(2px);animation:automation-backdrop-in var(--motion-panel,220ms) var(--ease-enter,ease) both}
    dialog[open]{animation:automation-dialog-in var(--motion-panel,220ms) var(--ease-enter,ease) both}
    .frame{height:100%;display:flex;min-height:0;flex-direction:column}.head{min-height:72px;padding:12px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--dialog-line);background:#fff}.route-icon{width:42px;height:42px;flex:none;display:grid;place-items:center;border-radius:12px;background:var(--dialog-blue-soft);color:var(--dialog-blue)}.route-icon svg{width:21px;height:21px}.title{min-width:0;flex:1}.title span{display:block;color:var(--dialog-blue);font-size:10px;font-weight:850;letter-spacing:.1em;text-transform:uppercase}.title h2{margin:2px 0 0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:17px;line-height:1.25;font-weight:800}.count{min-width:31px;height:28px;padding:0 8px;display:grid;place-items:center;border-radius:999px;background:var(--dialog-blue-soft);color:var(--dialog-blue);font-size:11px;font-weight:850;font-variant-numeric:tabular-nums}.close{width:44px;height:44px;flex:none;display:grid;place-items:center;border-radius:11px;color:var(--dialog-muted);font-size:23px;line-height:1;transition:background var(--motion-press,130ms) var(--ease-standard,ease),color var(--motion-press,130ms) var(--ease-standard,ease)}.close:hover{background:#f3f6f2;color:var(--dialog-ink)}.close:focus-visible{outline:3px solid color-mix(in srgb,var(--dialog-blue) 30%,transparent);outline-offset:1px}.body{flex:1;min-height:0;overflow:auto;padding:18px;scrollbar-gutter:stable}
    @keyframes automation-dialog-in{from{opacity:0}to{opacity:1}}@keyframes automation-backdrop-in{from{opacity:0}to{opacity:1}}
    @media(max-width:767.98px){dialog{left:0;top:0;right:0;bottom:0;width:100%;height:100%;transform:none;border:0;border-radius:0;animation:automation-mobile-in var(--motion-selection,170ms) var(--ease-enter,ease) both}.head{min-height:64px;padding:10px 12px}.route-icon{width:38px;height:38px;border-radius:10px}.title h2{font-size:15px}.body{padding:14px 12px calc(18px + env(safe-area-inset-bottom))}}
    @keyframes automation-mobile-in{from{opacity:0}to{opacity:1}}
    @media(prefers-reduced-motion:reduce){dialog,dialog::backdrop{animation:none}}
  `],
  template: `
    <dialog #modal (click)="backdropClick($event)" (cancel)="cancel($event)" aria-labelledby="route-automations-title">
      <div class="frame">
        <header class="head">
          <span class="route-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/></svg></span>
          <div class="title"><span>Route automations</span><h2 id="route-automations-title">{{routeName()}}</h2></div>
          <span class="count" [attr.aria-label]="count() + (count()===1?' automation':' automations')">{{count()}}</span>
          <button #closeButton type="button" class="close" aria-label="Close route automations" (click)="close()">×</button>
        </header>
        <div class="body">
          <app-automations-manager [siteId]="siteId()" [focusRouteKey]="routeKey()" [showRouteDefaults]="false" [showRouteFocus]="false" (changed)="changed.emit()"/>
        </div>
      </div>
    </dialog>
  `,
})
export class RouteAutomationsDialogComponent implements AfterViewInit {
  readonly siteId = input.required<string>();
  readonly routeKey = input.required<string>();
  readonly routeName = input.required<string>();
  readonly count = input(0);
  readonly closed = output<void>();
  readonly changed = output<void>();

  private modal = viewChild.required<ElementRef<HTMLDialogElement>>('modal');
  private closeButton = viewChild.required<ElementRef<HTMLButtonElement>>('closeButton');
  private dismissed = false;

  ngAfterViewInit(): void {
    const dialog = this.modal().nativeElement;
    if (!dialog.open) dialog.showModal();
    queueMicrotask(() => this.closeButton().nativeElement.focus());
  }

  protected close(): void {
    if (this.dismissed) return;
    this.dismissed = true;
    const dialog = this.modal().nativeElement;
    if (dialog.open) dialog.close();
    this.closed.emit();
  }
  protected cancel(event: Event): void { event.preventDefault(); this.close(); }
  protected backdropClick(event: MouseEvent): void {
    const rect = this.modal().nativeElement.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom;
    if (outside) this.close();
  }
}
