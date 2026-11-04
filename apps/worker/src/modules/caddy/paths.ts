/**
 * Filesystem layout for all Caddy-owned files. Nothing outside this tree is
 * written by the module; `STACKMANAGE_DATA_HOME` is the test/portable override.
 */
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { z } from 'zod';
import type { ModuleStorage } from '@stackmanage/core';

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

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `child` resolves strictly inside `parent` (equal is not inside). */
export function isInside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target !== base && target.startsWith(`${base}${sep}`);
}

/** Write via temp file + rename so a crash never leaves a half-written record. */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** JSON-file storage scoped per module id; module-scoped state, never `config.setup`. */
export class FsModuleStorage implements ModuleStorage {
  private writing = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private file(moduleId: string, key: string): string {
    if (!SAFE_SEGMENT.test(moduleId) || !SAFE_SEGMENT.test(key)) throw new Error('invalid storage key');
    return join(this.root, moduleId, `${key}.json`);
  }

  async StorageGetAsync<T>(moduleId: string, key: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(moduleId, key), 'utf8'));
      // A corrupt record is treated as absent; owners reconcile against the filesystem.
      const result = schema.safeParse(parsed);
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  async StorageSetAsync<T>(moduleId: string, key: string, value: T, _schema: z.ZodType<T>): Promise<void> {
    const path = this.file(moduleId, key);
    const previous = this.writing.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`))
      .finally(() => {
        if (this.writing.get(path) === next) this.writing.delete(path);
      });
    this.writing.set(path, next);
    await next;
  }
}
