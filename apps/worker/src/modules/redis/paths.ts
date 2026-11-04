/**
 * Per-user filesystem layout for Redis.
 *
 * Everything, including the private data directory, config, PID and log, stays
 * under one module tree. Uninstall refuses anything that resolves outside the
 * managed installations root.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface RedisPaths {
  home: string;
  installations: string;
  downloads: string;
  staging: string;
  service: string;
  conf: string;
  logs: string;
  data: string;
  config: string;
  log: string;
  pid: string;
}

function dataBase(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return env['XDG_DATA_HOME'] !== undefined && env['XDG_DATA_HOME'] !== '' ? env['XDG_DATA_HOME'] : join(homedir(), '.local', 'share');
}

/** Per-user Redis data root; `home` overrides only for tests/portable installs. */
export function redisPaths(home?: string, env: NodeJS.ProcessEnv = process.env): RedisPaths {
  const explicit = home !== undefined && home !== '' ? resolve(home) : env['STACKMANAGE_REDIS_HOME'];
  const override = env['STACKMANAGE_DATA_HOME'];
  const root =
    explicit !== undefined && explicit !== ''
      ? resolve(explicit)
      : override !== undefined && override.trim() !== ''
        ? join(resolve(override), 'redis')
        : join(dataBase(env), 'StackManage', 'redis');
  const service = join(root, 'service');
  return {
    home: root,
    installations: join(root, 'installations'),
    downloads: join(root, 'downloads'),
    staging: join(root, 'staging'),
    service,
    conf: join(service, 'conf'),
    logs: join(service, 'logs'),
    data: join(service, 'data'),
    config: join(service, 'conf', 'redis.conf'),
    log: join(service, 'logs', 'redis.log'),
    pid: join(service, 'redis.pid')
  };
}

export { pathExists, isInside, isWithin, atomicWriteFile, safeSegment } from '../../shared/files';
