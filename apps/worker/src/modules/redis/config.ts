/**
 * Managed Redis configuration.
 *
 * The instance is loopback-only, foreground, and writes every mutable file into
 * the managed service directory. The rendered file is generated on every start
 * and is never writable from the renderer.
 */
import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_MAXMEMORY_BYTES, DEFAULT_REDIS_PORT, LOOPBACK_ADDRESS } from './manifest';

export interface RedisConfigInput {
  installDir: string;
  configPath: string;
  dataDir: string;
  logPath: string;
  pidFile: string;
  port?: number;
  maxmemoryBytes?: number;
}

/** Reject anything that could escape a quoted config token or inject a directive. */
export function assertSafePath(path: string): string {
  if (!isAbsolute(path)) throw new Error('redis.unsafePath');
  if (/["\\;]/.test(path)) throw new Error('redis.unsafePath');
  for (const char of path) {
    if (char.charCodeAt(0) < 0x20) throw new Error('redis.unsafePath');
  }
  return resolve(path);
}

function quote(path: string): string {
  return `"${assertSafePath(path)}"`;
}

export function renderRedisConfig(input: RedisConfigInput): string {
  const port = input.port ?? DEFAULT_REDIS_PORT;
  const maxmemory = input.maxmemoryBytes ?? DEFAULT_MAXMEMORY_BYTES;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('redis.unsafeConfig');
  if (!Number.isInteger(maxmemory) || maxmemory < 1024 * 1024) throw new Error('redis.unsafeConfig');
  assertSafePath(input.installDir);
  return [
    '# Managed by StackManage. Regenerated on every start; local edits are not preserved.',
    `bind ${LOOPBACK_ADDRESS}`,
    'protected-mode yes',
    `port ${port}`,
    'daemonize no',
    'supervised no',
    `pidfile ${quote(input.pidFile)}`,
    `logfile ${quote(input.logPath)}`,
    `dir ${quote(input.dataDir)}`,
    'dbfilename dump.rdb',
    'save ""',
    'appendonly no',
    `maxmemory ${maxmemory}`,
    'maxmemory-policy noeviction',
    'loglevel notice',
    'databases 16',
    ''
  ].join('\n');
}

/** The config path is derived from the managed service directory, never from a caller. */
export function managedConfigPath(confDir: string): string {
  return resolve(confDir, 'redis.conf');
}
