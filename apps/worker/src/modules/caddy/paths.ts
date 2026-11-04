/**
 * Filesystem layout for all Caddy-owned files. Nothing outside this tree is
 * written by the module; `STACKMANAGE_DATA_HOME` is the test/portable override.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Paths {
  home: string;
  installations: string;
  downloads: string;
  staging: string;
  instances: string;
  caddyfiles: string;
  logs: string;
  siteRoots: string;
}

function dataBase(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return env['XDG_DATA_HOME'] !== undefined && env['XDG_DATA_HOME'] !== '' ? env['XDG_DATA_HOME'] : join(homedir(), '.local', 'share');
}

/** Per-user data root; `home` overrides the default only for tests/portable installs. */
export function caddyPaths(home?: string, env: NodeJS.ProcessEnv = process.env): Paths {
  const override = env['STACKMANAGE_DATA_HOME'];
  const home_ =
    home !== undefined && home !== ''
      ? resolve(home)
      : override !== undefined && override.trim() !== ''
        ? resolve(override)
        : join(dataBase(env), 'StackManage', 'caddy');
  return {
    home: home_,
    installations: join(home_, 'installations'),
    downloads: join(home_, 'downloads'),
    staging: join(home_, 'staging'),
    instances: join(home_, 'instances'),
    caddyfiles: join(home_, 'caddyfiles'),
    logs: join(home_, 'logs'),
    siteRoots: join(home_, 'sites')
  };
}

export { pathExists, isInside, atomicWriteFile } from '../../shared/files';
export { FsModuleStorage } from '../../shared/storage';
