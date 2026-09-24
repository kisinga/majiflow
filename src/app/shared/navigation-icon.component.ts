import { Component, input } from '@angular/core';
import type { NavigationIcon } from '../core/navigation';

/** One icon vocabulary for the desktop rail, mobile sheet and bottom bar. */
@Component({
  selector: 'app-navigation-icon',
  standalone: true,
  host: { class: 'navigation-icon' },
  styles: [`:host{display:inline-grid;place-items:center;flex:none}svg{width:100%;height:100%;stroke-linecap:round;stroke-linejoin:round}`],
  template: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      @switch (icon()) {
        @case ('operate') { <path d="M3 19h18M5 19V9l7-5 7 5v10M9 19v-6h6v6"/> }
        @case ('insights') { <path d="M5 19V10m7 9V5m7 14v-7"/> }
        @case ('automations') { <circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/> }
        @case ('system') { <rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM2 9h3m-3 6h3m14-6h3m-3 6h3M9 2v3m6-3v3m-6 14v3m6-3v3"/> }
        @case ('billing') { <rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10m-10 4h6"/> }
        @case ('settings') { <circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.4 1A7 7 0 0 0 14.4 6L14 3h-4l-.4 3a7 7 0 0 0-2.1.9l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2.1-.9l.4 3h4l.4-3a7 7 0 0 0 2.1-.9l2.4 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z"/> }
        @case ('customers') { <path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 2.13a4 4 0 0 1 0 7.75"/> }
        @case ('devices') { <rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6m-6 4h6m-3 6h.01"/> }
        @case ('boards') { <rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8v8H8zM1 9h3m-3 6h3m16-6h3m-3 6h3"/> }
        @case ('docs') { <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H20v17H7.5A3.5 3.5 0 0 0 4 22zM4 5.5v13A3.5 3.5 0 0 1 7.5 15H20"/> }
        @case ('leads') { <path d="M4 19V5m0 0h10l-2 3 2 3H4"/> }
        @default { <path d="M3 19h18M5 19V9l7-5 7 5v10M9 19v-6h6v6"/> }
      }
    </svg>
  `,
})
export class NavigationIconComponent {
  readonly icon = input.required<NavigationIcon>();
}
