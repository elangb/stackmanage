/**
 * Filesystem layout for Node-owned files. Everything stays under one module
 * directory; the installer refuses to remove anything that resolves outside it.
 */
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export interface NodePaths {
  home: string;
  installations: string;
  downloads: string;
  staging: string;
}

function dataBase(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return env['XDG_DATA_HOME'] !== undefined && env['XDG_DATA_HOME'] !== '' ? env['XDG_DATA_HOME'] : join(homedir(), '.local', 'share');
}

/** Per-user runtime data root; `home` overrides only for tests/portable installs. */
export function nodePaths(home?: string, env: NodeJS.ProcessEnv = process.env): NodePaths {
  const override = env['STACKMANAGE_DATA_HOME'];
  const root =
    home !== undefined && home !== ''
      ? resolve(home)
      : override !== undefined && override.trim() !== ''
        ? resolve(override)
        : join(dataBase(env), 'StackManage', 'runtimes', 'node');
  return {
    home: root,
    installations: join(root, 'installations'),
    downloads: join(root, 'downloads'),
    staging: join(root, 'staging')
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
