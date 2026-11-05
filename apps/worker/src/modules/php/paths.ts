/**
 * Per-user filesystem layout for the PHP runtime and its FastCGI service.
 * Everything stays under one module tree.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface PhpPaths {
  home: string;
  installations: string;
  downloads: string;
  staging: string;
  service: string;
  conf: string;
  logs: string;
  run: string;
  sessions: string;
  tmp: string;
  config: string;
  poolDir: string;
  log: string;
  pid: string;
}

function dataBase(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return env['XDG_DATA_HOME'] !== undefined && env['XDG_DATA_HOME'] !== '' ? env['XDG_DATA_HOME'] : join(homedir(), '.local', 'share');
}

export function phpPaths(home?: string, env: NodeJS.ProcessEnv = process.env): PhpPaths {
  const explicit = home !== undefined && home !== '' ? resolve(home) : env['STACKMANAGE_PHP_HOME'];
  const override = env['STACKMANAGE_DATA_HOME'];
  const root =
    explicit !== undefined && explicit !== ''
      ? resolve(explicit)
      : override !== undefined && override.trim() !== ''
        ? join(resolve(override), 'php')
        : join(dataBase(env), 'StackManage', 'runtimes', 'php');
  const service = join(root, 'service');
  const conf = join(service, 'conf');
  return {
    home: root,
    installations: join(root, 'installations'),
    downloads: join(root, 'downloads'),
    staging: join(root, 'staging'),
    service,
    conf,
    logs: join(service, 'logs'),
    run: join(service, 'run'),
    sessions: join(service, 'sessions'),
    tmp: join(service, 'tmp'),
    config: join(conf, 'php-fpm.conf'),
    poolDir: join(conf, 'pool.d'),
    log: join(service, 'logs', 'php-fpm.log'),
    pid: join(service, 'run', 'php-fpm.pid')
  };
}

export { pathExists, isInside, isWithin, atomicWriteFile } from '../../shared/files';
