import { Component, input } from '@angular/core';

/**
 * The one header treatment shared by every workspace/admin page (Sites, Devices,
 * Config, Sharing, Firmware…). Carries the marketing site's visual language into
 * the app: a glowing cyan→sky gradient accent bar, a bold display title, and a
 * faint cyan ambient bloom behind it — so admin pages feel alive, not flat, while
 * still reading as one coherent set. Presentational only; sits atop a `.content-pane`.
 */
@Component({
  selector: 'app-section-header',
  standalone: true,
  styles: [`
    :host{display:block}.section-heading{display:flex;align-items:center;gap:11px}.section-mark{width:5px;height:28px;flex:none;border-radius:999px;background:linear-gradient(180deg,#22d3ee,#0284c7)}h1{margin:0;color:var(--op-ink,#12233b);font-size:24px;font-weight:800;letter-spacing:-.025em}p{max-width:700px;margin:7px 0 0 16px;color:var(--op-muted,#60738a);font-size:13px;line-height:1.5}@media(max-width:639.98px){h1{font-size:21px}p{margin-left:0}}
  `],
  template: `
    <header>
      <div class="section-heading">
        <span class="section-mark" aria-hidden="true"></span>
        <h1 class="app-title">{{ title() }}</h1>
      </div>
      @if (subtitle()) {
        <p>{{ subtitle() }}</p>
      }
    </header>
  `,
})
export class SectionHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
}
