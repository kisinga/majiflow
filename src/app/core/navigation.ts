import type { UserRole } from './services/auth.store';

export type NavigationIcon = 'operate' | 'insights' | 'automations' | 'system' | 'billing' | 'settings' | 'sites' | 'customers' | 'devices' | 'boards' | 'docs' | 'leads' | 'partner';
export interface NavigationContext {
  workspace: 'platform' | 'site';
  siteId?: string;
  role: UserRole | null;
  deviceMode: boolean;
  features: ReadonlySet<string>;
  capabilities: ReadonlySet<string>;
}
export interface NavigationItem {
  id: string;
  label: string;
  icon: NavigationIcon;
  link: readonly string[];
  position: 'primary' | 'footer';
  badge?: number;
}

/** The one visibility/link resolver used by the desktop rail and mobile sheet. */
export function resolveNavigation(ctx: NavigationContext): NavigationItem[] {
  const manager = ctx.role === 'admin' || ctx.role === 'partner';
  const admin = ctx.role === 'admin';
  if (ctx.workspace === 'site') {
    const site = ctx.siteId || 'local';
    const items: NavigationItem[] = [
      { id:'operate', label:'Operate', icon:'operate', link:['/site',site,'dashboard'], position:'primary' },
      { id:'insights', label:ctx.deviceMode ? 'Activity' : 'Insights', icon:'insights', link:['/site',site,'insights'], position:'primary' },
      { id:'automations', label:'Automations', icon:'automations', link:['/site',site,'automations'], position:'primary' },
    ];
    if (manager && !ctx.deviceMode) items.push({ id:'system', label:'System', icon:'system', link:['/site',site], position:'primary' });
    if (!ctx.deviceMode && ctx.features.has('billing_module') && ctx.capabilities.has('tenant_billing')) items.push({ id:'billing', label:'Billing', icon:'billing', link:['/site',site,'billing'], position:'primary' });
    items.push({ id:'settings', label:'Settings', icon:'settings', link:['/site',site,'settings'], position:'footer' });
    return items;
  }
  if (!ctx.role) return [];
  if (!manager) return [{ id:'sites', label:'My sites', icon:'sites', link:['/home'], position:'primary' }];
  const items: NavigationItem[] = [];
  if (ctx.role === 'partner' && ctx.features.has('partner_portal')) items.push({ id:'partner', label:'Partner', icon:'partner', link:['/partner'], position:'primary' });
  items.push(
    { id:'sites', label:'Sites', icon:'sites', link:['/overview'], position:'primary' },
    { id:'customers', label:'Customers', icon:'customers', link:['/customers'], position:'primary' },
    { id:'devices', label:'Devices', icon:'devices', link:['/devices'], position:'primary' },
  );
  if (admin) items.push(
    { id:'boards', label:'Boards', icon:'boards', link:['/boards'], position:'primary' },
    { id:'docs', label:'Documentation', icon:'docs', link:['/docs'], position:'primary' },
    { id:'leads', label:'Leads', icon:'leads', link:['/leads'], position:'primary' },
    { id:'platform-settings', label:'Settings', icon:'settings', link:['/settings'], position:'footer' },
  );
  return items;
}
