import { Component, input } from '@angular/core';

/** The actuator symbols used by the topology itself, scaled for control rows. */
@Component({
  selector: 'app-operator-entity-icon',
  standalone: true,
  host: { class: 'contents' },
  styles: [`
    :host { display: contents; }
    svg { width: 25px; height: 25px; overflow: visible; }
  `],
  template: `
    @if (kind() === 'valve') {
      <svg viewBox="0 0 50 36" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 6 25 18 8 30Z"/><path d="m42 6-17 12 17 12Z"/>
        <path d="M25 18V7"/><circle cx="25" cy="4" r="2.5"/>
      </svg>
    } @else {
      <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
        <circle cx="30" cy="30" r="24"/>
        <g transform="translate(30 30)">
          <path d="M0 0Q8 4 17 0M0 0Q1 9 9 15M0 0Q-7 6-9 15M0 0Q-9-1-17 0M0 0Q-1-9-9-15M0 0Q7-6 9-15"/>
          <circle r="3" fill="currentColor" stroke="none"/>
        </g>
      </svg>
    }
  `,
})
export class OperatorEntityIconComponent {
  readonly kind = input.required<'valve' | 'pump'>();
}
