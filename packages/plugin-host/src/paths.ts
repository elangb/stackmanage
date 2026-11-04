import { mkdir, lstat, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { PluginHostError } from './errors';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** True when `child` resolves strictly inside `parent` (equal is not inside). */
export function isInside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target !== base && target.startsWith(`${base}${sep}`);
}

/** True when `child` resolves inside `parent` or equals it. */
export function isWithin(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(`${base}${sep}`);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Write via temp file + rename so a crash never leaves a half-written record. */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\\)(?!.*\0)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Relative file path pinned by the registry. Absolute paths, traversal and backslashes are rejected. */
export const SafeRelativePathSchema = z.string().min(1).max(512).regex(SAFE_RELATIVE_PATH);

export function resolveWithin(parent: string, relative: string): string {
  if (!SafeRelativePathSchema.safeParse(relative).success) throw new PluginHostError('UNSAFE_PACKAGE_PATH');
  const target = resolve(parent, relative);
  if (!isInside(parent, target)) throw new PluginHostError('UNSAFE_PACKAGE_PATH');
  return target;
}

/** `id` and `version` are already schema-validated; this is belt-and-braces against path segments. */
export function safeSegment(value: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') throw new PluginHostError('FORBIDDEN');
  return value;
}

export function pluginDataHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | string = process.platform,
  home: string = homedir()
): string {
  const explicit = env['STACKMANAGE_PLUGIN_HOME'];
  if (explicit !== undefined && explicit.trim() !== '') return resolve(explicit);
  const dataHome = env['STACKMANAGE_DATA_HOME'];
  if (dataHome !== undefined && dataHome.trim() !== '') return join(resolve(dataHome), 'plugins');
  const base =
    platform === 'win32'
      ? (env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'))
      : platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : env['XDG_DATA_HOME'] !== undefined && env['XDG_DATA_HOME'] !== ''
          ? env['XDG_DATA_HOME']
          : join(home, '.local', 'share');
  return join(base, 'StackManage', 'plugins');
}

/** Managed directory layout under one user-owned plugin root. */
export interface PluginPaths {
  readonly root: string;
  readonly registryIndex: string;
  readonly registryDir: string;
  readonly installedRoot: string;
  readonly stagingRoot: string;
  readonly trashRoot: string;
  readonly stateFile: string;
}

export function pluginPaths(options: { root: string; registryIndex?: string }): PluginPaths {
  const root = resolve(options.root);
  const registryIndex = resolve(options.registryIndex ?? join(root, 'registry', 'index.json'));
  return {
    root,
    registryIndex,
    registryDir: resolve(registryIndex, '..'),
    installedRoot: join(root, 'installed'),
    stagingRoot: join(root, 'staging'),
    trashRoot: join(root, 'trash'),
    stateFile: join(root, 'state', 'plugins.json')
  };
}
