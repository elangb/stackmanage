export type PageKey =
  | 'home'
  | 'runtimes'
  | 'web'
  | 'databases'
  | 'cache'
  | 'infra'
  | 'workflow'
  | 'ai'
  | 'plugins'
  | 'settings';

export interface NavItem {
  key: PageKey;
  labelKey: string;
  icon: string;
  implemented: boolean;
}

export const NAV_GROUPS: ReadonlyArray<{ labelKey: string; items: ReadonlyArray<NavItem> }> = Object.freeze([
  {
    labelKey: 'navGroupWorkspace',
    items: [{ key: 'home', labelKey: 'navHome', icon: '◫', implemented: true }]
  },
  {
    labelKey: 'navGroupPlatform',
    items: [
      { key: 'runtimes', labelKey: 'navRuntimes', icon: '⌘', implemented: true },
      { key: 'web', labelKey: 'navWeb', icon: '◍', implemented: true },
      { key: 'databases', labelKey: 'navDatabases', icon: '▤', implemented: true },
      { key: 'cache', labelKey: 'navCache', icon: '⇄', implemented: false },
      { key: 'infra', labelKey: 'navInfra', icon: '⌁', implemented: false },
      { key: 'workflow', labelKey: 'navWorkflow', icon: '⟳', implemented: false },
      { key: 'ai', labelKey: 'navAi', icon: '✦', implemented: false },
      { key: 'plugins', labelKey: 'navPlugins', icon: '⊞', implemented: false },
      { key: 'settings', labelKey: 'navSettings', icon: '⚙', implemented: true }
    ]
  }
]);

export const PAGE_TITLE_KEYS: Readonly<Record<PageKey, string>> = Object.freeze({
  home: 'navHome',
  runtimes: 'navRuntimes',
  web: 'navWeb',
  databases: 'navDatabases',
  cache: 'navCache',
  infra: 'navInfra',
  workflow: 'navWorkflow',
  ai: 'navAi',
  plugins: 'navPlugins',
  settings: 'navSettings'
});
