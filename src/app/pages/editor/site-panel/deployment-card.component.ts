import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WorkspaceService } from '../../../core/services/workspace.service';
import { BuildService } from '../../../core/services/build.service';

/**
 * Per-site "how your controllers connect" chooser. Two options:
 *   - MajiFlow Cloud (managed): broker autofilled from the cloud defaults, locked.
 *   - My own server (local): the installer enters the on-site broker address.
 *
 * The choice is a per-site field: it reads reactively from the workspace's saved
 * deployment (`workspace.deployment()`) and writes back through `setDeployment`,
 * exactly like the other editor fields bind to the topology signals — so it
 * always reflects what was saved for this site, no matter when the site finishes
 * loading. (Earlier it copied into local signals in ngOnInit and went stale when
 * load() resolved after the card mounted.)
 *
 * Shows a live verdict driven by the design's cross-controller "cross-talk".
 * Coordination is LAN-UDP and never touches the cloud, so sharing works in both
 * modes — the verdict only reminds that shared controllers must sit on the same
 * local network; it is never a mode error.
 */
@Component({
  selector: 'app-deployment-card',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    :host{display:block}.surface{border:1px solid var(--op-border,#cfdae7);border-radius:15px;background:#fff;background-image:none;box-shadow:0 1px 2px rgb(18 35 59/.05);--tw-ring-shadow:0 0 #0000}
  `],
  template: `
    <div class="surface p-4">
      <div class="flex items-center gap-2 mb-3">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7"/></svg>
        <h3 class="text-sm font-semibold">How your controllers connect</h3>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <!-- Cloud -->
        <button type="button" (click)="selectManaged()"
          class="text-left rounded-lg border p-3 transition-colors"
          [class]="mode() === 'managed' ? 'border-primary ring-1 ring-primary bg-primary/10' : 'border-base-300 hover:border-base-content/20'">
          <div class="flex items-center gap-2">
            <span class="w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0"
              [class]="mode() === 'managed' ? 'border-primary' : 'border-base-content/30'">
              @if (mode() === 'managed') { <span class="w-1.5 h-1.5 rounded-full bg-primary"></span> }
            </span>
            <span class="font-semibold text-sm">MajiFlow Cloud</span>
            <span class="badge badge-ghost badge-xs ml-auto">Recommended</span>
          </div>
          <p class="text-xs text-base-content/50 mt-1.5 pl-5.5">Online, hosted by us. Lowest cost, nothing to run. Each controller works on its own.</p>
        </button>

        <!-- Local -->
        <button type="button" (click)="selectLocal()"
          class="text-left rounded-lg border p-3 transition-colors"
          [class]="mode() === 'local' ? 'border-primary ring-1 ring-primary bg-primary/10' : 'border-base-300 hover:border-base-content/20'">
          <div class="flex items-center gap-2">
            <span class="w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0"
              [class]="mode() === 'local' ? 'border-primary' : 'border-base-content/30'">
              @if (mode() === 'local') { <span class="w-1.5 h-1.5 rounded-full bg-primary"></span> }
            </span>
            <span class="font-semibold text-sm">My own server</span>
          </div>
          <p class="text-xs text-base-content/50 mt-1.5 pl-5.5">An on-site box on your network. Costs more, but controllers can work together and it runs without internet.</p>
        </button>
      </div>

      <!-- Server address -->
      <div class="mt-3">
        @if (mode() === 'managed') {
          <div class="flex items-center gap-2 text-xs">
            <span class="text-base-content/50">Server</span>
            <span class="font-mono px-2 py-1 rounded bg-base-200 text-base-content/70">{{ cloudLabel() }}</span>
            <span class="badge badge-ghost badge-xs">managed by MajiFlow</span>
          </div>
        } @else {
          <div class="flex flex-wrap items-end gap-2">
            <label class="flex flex-col">
              <span class="text-[11px] text-base-content/50 mb-0.5">On-site server address</span>
              <input type="text" class="input input-bordered input-sm w-56 font-mono"
                placeholder="majiflow.local or 192.168.1.50"
                [ngModel]="host()" (ngModelChange)="setHost($event)" />
            </label>
            <label class="flex flex-col">
              <span class="text-[11px] text-base-content/50 mb-0.5">Port</span>
              <input type="number" class="input input-bordered input-sm w-20 font-mono"
                placeholder="1883" [ngModel]="port()" (ngModelChange)="setPort(+$event)" />
            </label>
            <label class="label cursor-pointer gap-1.5 pb-1.5">
              <input type="checkbox" class="checkbox checkbox-sm"
                [class.checkbox-error]="tls()"
                [ngModel]="tls()" (ngModelChange)="setTls($event)" />
              <span class="text-xs" [class.text-error]="tls()">TLS</span>
            </label>
          </div>

          <!-- TLS is not implemented end-to-end yet: the firmware emits no TLS and
               the on-site broker serves none. Toggling it on breaks the connection,
               so warn hard rather than silently shipping an unreachable device. -->
          @if (tls()) {
            <div class="mt-2 flex items-start gap-2 text-xs rounded-lg px-3 py-2 bg-error/10 text-error">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              </svg>
              <span><strong>Turn this off.</strong> TLS for on-site servers is not supported yet — the
              on-site broker speaks plaintext and the firmware sends no TLS, so the controller will
              fail to connect. Your traffic stays on your own network (LAN) regardless, so plaintext
              is safe here. Use port <strong>1883</strong>.</span>
            </div>
          }
        }
      </div>

      <!-- Live verdict -->
      <div class="mt-3">
        @if (verdict(); as v) {
          <div class="flex items-start gap-2 text-xs rounded-lg px-3 py-2"
            [class]="v.kind === 'error' ? 'bg-error/10 text-error' : v.kind === 'warn' ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 mt-px" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              @if (v.kind === 'ok') {
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
              } @else {
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              }
            </svg>
            <span>{{ v.text }}</span>
          </div>
        }
      </div>
    </div>
  `,
})
export class DeploymentCardComponent implements OnInit {
  private workspace = inject(WorkspaceService);
  private build = inject(BuildService);

  // Reactive reads off the site's saved deployment — populate whenever the site
  // loads, like the other editor fields. No local copies, no ngOnInit seeding.
  protected mode = this.workspace.deploymentMode;
  protected crossTalk = this.workspace.crossTalk;
  private deployment = this.workspace.deployment;

  protected host = computed(() => this.deployment()?.brokerHost ?? '');
  // On-site brokers run plaintext MQTT on 1883 (the embedded broker has no TLS
  // listener; the firmware emits no TLS). 1883 is the working default for local.
  protected port = computed(() => this.deployment()?.brokerPort || 1883);
  protected tls = computed(() => this.deployment()?.brokerTls ?? false);

  // Cloud broker defaults are a server-level value (not site state), so a
  // one-shot fetch is correct here.
  private cloud = signal<{ host: string; port: number; tls: boolean } | null>(null);

  protected cloudLabel = computed(() => {
    const c = this.cloud();
    if (!c) return 'mqtt.majiflow.io:8883 (TLS)';
    return `${c.host}:${c.port}${c.tls ? ' (TLS)' : ''}`;
  });

  async ngOnInit(): Promise<void> {
    this.cloud.set(await this.build.cloudBrokerDefaults());
  }

  protected selectManaged(): void {
    this.workspace.setDeployment({ mode: 'managed', brokerHost: '', brokerPort: 0, brokerTls: true });
  }

  protected selectLocal(): void {
    this.workspace.setDeployment({
      mode: 'local',
      brokerHost: this.host(),
      brokerPort: this.port(),
      brokerTls: this.tls(),
    });
  }

  protected setHost(v: string): void {
    this.workspace.setDeployment({ mode: 'local', brokerHost: v.trim(), brokerPort: this.port(), brokerTls: this.tls() });
  }

  protected setPort(v: number): void {
    this.workspace.setDeployment({ mode: 'local', brokerHost: this.host(), brokerPort: v || 8883, brokerTls: this.tls() });
  }

  protected setTls(v: boolean): void {
    this.workspace.setDeployment({ mode: 'local', brokerHost: this.host(), brokerPort: this.port(), brokerTls: v });
  }

  protected verdict = computed<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(() => {
    const ct = this.crossTalk();
    // Cross-controller coordination runs over the local network (UDP) in both modes,
    // so it is never a mode error — the only requirement is a shared LAN.
    const lanNote = ct?.hasCrossTalk
      ? ' Controllers that share must be on the same local network — they coordinate directly over the LAN.'
      : '';
    if (this.mode() === 'managed') {
      return { kind: 'ok', text: `Ready for the cloud.${lanNote || ' Each controller runs independently.'}` };
    }
    // local
    if (!this.host().trim()) {
      return { kind: 'warn', text: 'Enter your on-site server address so the controllers know where to connect.' };
    }
    return { kind: 'ok', text: `Running on your own on-site server.${lanNote}` };
  });
}
