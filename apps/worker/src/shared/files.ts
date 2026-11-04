/**
 * Transport-free filesystem helpers shared by worker modules.
 *
 * Path confinement is a security boundary: a recorded path must resolve strictly
 * inside the managed root before it can be removed or executed.
 */
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

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

/** True when `child` resolves inside `parent` or equals it. */
export function isWithin(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(`${base}${sep}`);
}

/** Write via temp file + rename so a crash never leaves a half-written record. */
export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

/** Keep an operation id usable as a directory segment. */
export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}
