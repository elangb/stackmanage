import { expect, it } from 'vitest';
import { locales, messages } from '../src';
import { NAV_GROUPS, PAGE_TITLE_KEYS, type PageKey } from '../../../apps/desktop/src/renderer/pages';

it('ships five complete locales with no empty UI labels', () => {
  expect(locales).toHaveLength(5);
  for (const locale of locales) {
    expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(messages.en).sort());
    for (const value of Object.values(messages[locale])) {
      if (typeof value === 'string') expect(value.trim().length).toBeGreaterThan(0);
      else expect(Object.keys(value).sort()).toEqual([...locales].sort());
    }
  }
});

it('provides non-empty Indonesian and English labels across every page', () => {
  const pageKeys: Record<PageKey, string[]> = {
    home: ['phase', 'title', 'intro', 'healthTitle', 'check', 'policyTitle', 'licensing', 'telemetry', 'footer', 'homeEyebrow', 'homeTitle', 'homeSubtitle', 'quickStart', 'quickStartBody', 'openWeb', 'viewLogs'],
    runtimes: ['runtimeTitle', 'runtimeSubtitle', 'runtimePinned', 'runtimeVendor', 'runtimeNoService', 'runtimeInstalled', 'runtimeNotInstalled', 'runtimeInstall', 'runtimeInstalling', 'runtimeUninstall', 'runtimeUninstalling', 'runtimeRefresh', 'runtimeInstalledVersion', 'runtimeBinary', 'runtimePathPlan', 'runtimePathHint', 'runtimeNoInstallations', 'runtimeArtifacts', 'runtimeEvidenceColumn', 'runtimeTested', 'runtimeUnverified', 'runtimeUnsupported', 'runtimeSupport', 'runtimeEvidence'],
    web: ['caddyTitle', 'caddySubtitle', 'caddyVersion', 'caddyVendor', 'caddyStatus', 'caddyNotInstalled', 'caddyInstalled', 'caddyInstall', 'caddyInstalling', 'caddyStart', 'caddyStarting', 'caddyStop', 'caddyStopping', 'caddyRestart', 'caddyRestarting', 'caddyOpen', 'caddyRefresh', 'sitesTitle', 'sitesEmpty', 'sitesHostname', 'sitesRoot', 'sitesPort', 'sitesAdd', 'sitesApplying', 'sitesRemove', 'sitesOpen', 'sitesServer', 'sitesPhp', 'logsTitle', 'logsDesc', 'logsEmpty', 'logsRefresh', 'nginxTitle', 'nginxSubtitle', 'nginxInstall', 'nginxInstalling', 'nginxStart', 'nginxStop', 'nginxReload', 'nginxUninstall', 'nginxVersion', 'nginxPort', 'nginxEvidence'],
    databases: ['databasesTitle', 'databasesSubtitle', 'databasesScope', 'databasesPolicy', 'databasesLicence', 'databasesLoopback', 'databasesNotIncluded', 'databasesEvidence', 'redisTitle', 'redisSubtitle', 'redisInstall', 'redisInstalling', 'redisStart', 'redisStop', 'redisUninstall', 'redisVersion', 'redisEndpoint', 'redisBinary', 'redisEvidence', 'redisLogsHint'],
    cache: ['notImplemented'], infra: ['notImplemented'], workflow: ['notImplemented'], ai: ['notImplemented'], plugins: ['notImplemented'],
    settings: ['settingsTitle', 'settingsAppearance', 'settingsAppearanceBody', 'theme', 'themeDark', 'themeLight', 'settingsLanguage', 'settingsLimits', 'settingsLimitsBody', 'settingsPlatform', 'settingsData', 'settingsDataBody', 'platformLabel', 'archLabel', 'language']
  };
  const navKeys = NAV_GROUPS.flatMap(group => [group.labelKey, ...group.items.map(item => item.labelKey)]);
  for (const locale of ['id', 'en'] as const) {
    const keys = new Set([...navKeys, ...Object.values(PAGE_TITLE_KEYS), ...Object.values(pageKeys).flat()]);
    for (const key of keys) {
      expect(String(messages[locale][key as keyof typeof messages.en]).trim(), `${locale}.${key}`).not.toBe('');
    }
  }
});
