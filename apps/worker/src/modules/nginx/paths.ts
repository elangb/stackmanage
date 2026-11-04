/**
 * Per-user filesystem layout for Nginx.
 *
 * The installation prefix is compiled with these absolute paths so a promoted
 * install never points back at staging. Everything stays under one module tree;
 * uninstall refuses anything that resolves outside the managed prefix root.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface NginxPaths {
  home: string;
  installations: string;
  downloads: string;
  staging: string;
  service: string;
  conf: string;
  logs: string;
  tmp: string;
  sites: string;
  defaultSite: string;
}

function dataBase(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return env['XDG_DATA_HOME'] !== undefined && env['XDG_DATA_HOME'] !== '' ? env['XDG_DATA_HOME'] : join(homedir(), '.local', 'share');
}

/** Per-user Nginx data root; `home` overrides only for tests/portable installs. */
export function nginxPaths(home?: string, env: NodeJS.ProcessEnv = process.env): NginxPaths {
  const explicit = home !== undefined && home !== '' ? resolve(home) : env['STACKMANAGE_NGINX_HOME'];
  const override = env['STACKMANAGE_DATA_HOME'];
  const root =
    explicit !== undefined && explicit !== ''
      ? resolve(explicit)
      : override !== undefined && override.trim() !== ''
        ? join(resolve(override), 'nginx')
        : join(dataBase(env), 'StackManage', 'nginx');
  const service = join(root, 'service');
  const sites = join(root, 'sites');
  return {
    home: root,
    installations: join(root, 'installations'),
    downloads: join(root, 'downloads'),
    staging: join(root, 'staging'),
    service,
    conf: join(service, 'conf'),
    logs: join(service, 'logs'),
    tmp: join(service, 'tmp'),
    sites,
    defaultSite: join(sites, 'default')
  };
}

export { pathExists, isInside, isWithin, atomicWriteFile, safeSegment } from '../../shared/files';
