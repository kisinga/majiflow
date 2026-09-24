import { Routes } from '@angular/router';

/**
 * Device-mode routes: the dashboard only — no auth, no guards, nothing else.
 * Swapped in for app.routes.ts by the `device` build configuration (angular.json
 * fileReplacements, the same mechanism as mode.providers.ts), so the cloud-only
 * pages and their lazy chunks are never part of the device bundle.
 *
 * The device serves exactly one site (its id is the fixed 'local' — siteLoad
 * ignores the route param and returns the baked topology regardless); every
 * other path lands on its dashboard. The id is a literal (not read from the
 * baked topology module) so this file never pulls the baked JSON into the
 * router setup.
 */
export const routes: Routes = [
  {
    path: 'site/:name/dashboard',
    data: { workspaceView: 'operate' },
    loadComponent: () =>
      import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'site/:name/insights',
    data: { workspaceView: 'insights' },
    loadComponent: () =>
      import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'site/:name/automations',
    loadComponent: () =>
      import('./pages/automations/automations.component').then((m) => m.AutomationsComponent),
  },
  {
    path: 'site/:name/settings',
    data: { workspaceView: 'settings' },
    loadComponent: () =>
      import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  { path: '**', redirectTo: 'site/local/dashboard' },
];
