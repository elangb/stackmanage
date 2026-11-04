import { posix, win32 } from 'node:path';
import type { Environment } from './ports.js';
import type { SupportedPlatform } from './detect';

export type DataRootSource = 'portable-env' | 'env-override' | 'appdata' | 'localappdata' | 'profile' | 'xdg-data-home' | 'home-fallback';

export interface DataRoots {
  readonly platform: SupportedPlatform;
  /** Per-user durable data (installations, module storage). */
  readonly data: string;
  /** Per-user caches and disposable downloads. */
  readonly cache: string;
  /** Per-user logs; Windows keeps logs beside data because its convention has no separate log dir. */
  readonly logs: string;
  /** Roaming/persistent location for settings and autostart entries, when the platform has one. */
  readonly config: string;
  readonly source: DataRootSource;
  /** True when the location was chosen by environment override or portable mode, not OS defaults. */
  readonly overridden: boolean;
}

export const PORTABLE_ROOT_ENV = 'STACKMANAGE_HOME';
export const DATA_ROOT_OVERRIDE_ENV = 'STACKMANAGE_DATA_HOME';
export const CACHE_ROOT_OVERRIDE_ENV = 'STACKMANAGE_CACHE_HOME';

export type RootResolution =
  | { readonly ok: true; readonly roots: DataRoots }
  | { readonly ok: false; readonly reason: string; readonly missing: readonly string[] };

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return `${home.replace(/[\\/]+$/, '')}/${value.slice(2)}`;
  return value;
}

function stripTrailing(value: string): string {
  return value.length > 1 ? value.replace(/[\\/]+$/, '') : value;
}

/** Joins with the native separator of the platform being described, not of the test host. */
function joinFor(platform: SupportedPlatform, base: string, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(base, ...parts) : posix.join(base, ...parts);
}

/** POSIX paths are case-sensitive; Windows comparisons are not. Used by root containment checks. */
export class RootPaths {
  constructor(readonly platform: SupportedPlatform) {}
  isInside(root: string, candidate: string): boolean {
    const normalize = (value: string): string => {
      const slashed = value.replace(/\\/g, '/').replace(/\/+/g, '/');
      return this.platform === 'win32' ? slashed.toLowerCase() : slashed;
    };
    const base = normalize(stripTrailing(root));
    const target = normalize(candidate);
    return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`);
  }
}

/**
 * Workspace-independent root resolution. Values come only from the injected
 * environment; nothing reads the current working directory or a checkout path.
 */
export function resolveDataRoots(platform: SupportedPlatform, env: Environment): RootResolution {
  const missing: string[] = [];
  const explicit = env[CACHE_ROOT_OVERRIDE_ENV];

  if (platform === 'win32') {
    const profile = env.USERPROFILE;
    const portable = env[PORTABLE_ROOT_ENV];
    const dataOverride = env[DATA_ROOT_OVERRIDE_ENV];
    const roaming = env.APPDATA ?? (profile ? joinFor(platform, profile, 'AppData', 'Roaming') : undefined);
    const local = env.LOCALAPPDATA ?? (profile ? joinFor(platform, profile, 'AppData', 'Local') : undefined);
    if (portable) {
      const root = stripTrailing(portable);
      return { ok: true, roots: { platform, data: root, cache: explicit ? stripTrailing(explicit) : joinFor(platform, root, 'cache'), logs: joinFor(platform, root, 'logs'), config: joinFor(platform, root, 'config'), source: 'portable-env', overridden: true } };
    }
    if (dataOverride) {
      const root = stripTrailing(dataOverride);
      return { ok: true, roots: { platform, data: root, cache: explicit ? stripTrailing(explicit) : joinFor(platform, root, 'cache'), logs: joinFor(platform, root, 'logs'), config: roaming ? joinFor(platform, roaming, 'StackManage') : joinFor(platform, root, 'config'), source: 'env-override', overridden: true } };
    }
    if (!local) missing.push('LOCALAPPDATA');
    if (!roaming) missing.push('APPDATA');
    if (missing.length > 0) return { ok: false, reason: 'Windows per-user directories are unavailable', missing };
    const data = joinFor(platform, local as string, 'StackManage');
    return { ok: true, roots: { platform, data, cache: explicit ? stripTrailing(explicit) : joinFor(platform, local as string, 'StackManage', 'cache'), logs: joinFor(platform, data, 'logs'), config: joinFor(platform, roaming as string, 'StackManage'), source: env.LOCALAPPDATA ? 'localappdata' : 'profile', overridden: false } };
  }

  const home = env.HOME;
  const portable = env[PORTABLE_ROOT_ENV];
  const dataOverride = env[DATA_ROOT_OVERRIDE_ENV];
  if (portable) {
    const root = stripTrailing(expandHome(portable, home ?? ''));
    return { ok: true, roots: { platform, data: root, cache: explicit ? stripTrailing(explicit) : joinFor(platform, root, 'cache'), logs: joinFor(platform, root, 'logs'), config: env.XDG_CONFIG_HOME ?? joinFor(platform, root, 'config'), source: 'portable-env', overridden: true } };
  }
  if (!home) missing.push('HOME');
  const xdgData = env.XDG_DATA_HOME;
  const xdgConfig = env.XDG_CONFIG_HOME;
  const dataBase = xdgData ?? (home ? joinFor(platform, home, '.local', 'share') : undefined);
  const configBase = xdgConfig ?? (home ? joinFor(platform, home, '.config') : undefined);
  if (!dataBase) missing.push('XDG_DATA_HOME');
  if (!configBase) missing.push('XDG_CONFIG_HOME');
  if (missing.length > 0) return { ok: false, reason: 'Linux per-user directories are unavailable', missing };
  // An explicit override replaces the whole data root; OS defaults append "StackManage".
  const data = dataOverride ? stripTrailing(expandHome(dataOverride, home as string)) : joinFor(platform, dataBase as string, 'StackManage');
  const config = joinFor(platform, configBase as string, 'StackManage');
  // An explicit data root also anchors the cache, so a sandboxed/portable run never
  // reads or writes the user's real HOME cache.
  const cache = explicit
    ? stripTrailing(expandHome(explicit, home as string))
    : dataOverride
      ? joinFor(platform, data, 'cache')
      : env.XDG_CACHE_HOME
        ? joinFor(platform, env.XDG_CACHE_HOME, 'StackManage')
        : joinFor(platform, home as string, '.cache', 'StackManage');
  return {
    ok: true,
    roots: {
      platform,
      data,
      cache,
      logs: data,
      config,
      source: dataOverride ? 'env-override' : xdgData ? 'xdg-data-home' : 'home-fallback',
      overridden: dataOverride !== undefined
    }
  };
}
