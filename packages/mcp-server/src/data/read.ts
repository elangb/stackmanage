import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export type ReadFailureCode = 'PATH_REJECTED' | 'NOT_A_FILE' | 'UNREADABLE' | 'IO_ERROR';

export class ReadFailure extends Error {
  override readonly name = 'ReadFailure';

  constructor(
    readonly code: ReadFailureCode,
    message: string
  ) {
    super(message);
  }
}

export type ResolvedFile = { readonly state: 'absent' } | { readonly state: 'present'; readonly path: string; readonly size: number };

export interface TextRead {
  readonly state: 'absent' | 'present';
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function rejectControl(value: string): void {
  if (value === '' || value.includes('\u0000')) throw new ReadFailure('PATH_REJECTED', 'path is empty or invalid');
  if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) throw new ReadFailure('PATH_REJECTED', 'absolute paths are not accepted');
  if (value.split(/[\\/]/).includes('..')) throw new ReadFailure('PATH_REJECTED', 'parent traversal is not accepted');
}

/** Resolve a relative path below a real root. Symlinks are never followed. */
export async function resolveFileWithin(root: string, relativePath: string): Promise<ResolvedFile> {
  rejectControl(relativePath);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { state: 'absent' };
  }
  const lexical = resolve(rootReal, relativePath);
  if (!isWithin(rootReal, lexical)) throw new ReadFailure('PATH_REJECTED', 'path escapes the managed data root');

  let target: string;
  try {
    target = await realpath(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { state: 'absent' };
    throw new ReadFailure('UNREADABLE', 'path could not be resolved');
  }
  if (!isWithin(rootReal, target)) throw new ReadFailure('PATH_REJECTED', 'symbolic link escapes the managed data root');

  const info = await lstat(lexical);
  if (info.isSymbolicLink()) throw new ReadFailure('PATH_REJECTED', 'symbolic links are not followed');
  if (!info.isFile()) throw new ReadFailure('NOT_A_FILE', 'path is not a regular file');
  return { state: 'present', path: target, size: info.size };
}

/** Read at most `maxBytes` from the start of a confined file. */
export async function readHeadWithin(root: string, relativePath: string, maxBytes: number): Promise<TextRead> {
  const resolved = await resolveFileWithin(root, relativePath);
  if (resolved.state === 'absent') return { state: 'absent', text: '', bytes: 0, truncated: false };
  const wanted = Math.min(resolved.size, maxBytes + 1);
  const buffer = Buffer.alloc(wanted);
  const handle = await open(resolved.path, constants.O_RDONLY).catch(() => {
    throw new ReadFailure('UNREADABLE', 'file could not be opened');
  });
  try {
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
    const truncated = resolved.size > maxBytes;
    const kept = truncated ? buffer.subarray(0, maxBytes) : buffer.subarray(0, bytesRead);
    return { state: 'present', text: kept.toString('utf8'), bytes: kept.byteLength, truncated };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Read at most `maxBytes` from the end of a confined file without loading it all. */
export async function readTailWithin(root: string, relativePath: string, maxBytes: number): Promise<TextRead> {
  const resolved = await resolveFileWithin(root, relativePath);
  if (resolved.state === 'absent') return { state: 'absent', text: '', bytes: 0, truncated: false };
  const start = Math.max(0, resolved.size - maxBytes);
  const length = resolved.size - start;
  const buffer = Buffer.alloc(length);
  const handle = await open(resolved.path, constants.O_RDONLY).catch(() => {
    throw new ReadFailure('UNREADABLE', 'file could not be opened');
  });
  try {
    const { bytesRead } = length > 0 ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
    return { state: 'present', text: buffer.subarray(0, bytesRead).toString('utf8'), bytes: bytesRead, truncated: start > 0 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface DirectoryListing {
  readonly state: 'absent' | 'present';
  readonly names: readonly string[];
}

/** List a confined directory, bounded and without following symlinked entries. */
export async function listDirectoryWithin(root: string, relativePath: string, maxEntries: number): Promise<DirectoryListing> {
  rejectControl(relativePath);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { state: 'absent', names: [] };
  }
  const lexical = resolve(rootReal, relativePath);
  if (!isWithin(rootReal, lexical)) throw new ReadFailure('PATH_REJECTED', 'directory escapes the managed data root');
  let target: string;
  try {
    target = await realpath(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return { state: 'absent', names: [] };
    throw new ReadFailure('UNREADABLE', 'directory could not be resolved');
  }
  if (!isWithin(rootReal, target)) throw new ReadFailure('PATH_REJECTED', 'symbolic link escapes the managed data root');
  const info = await stat(target);
  if (!info.isDirectory()) throw new ReadFailure('NOT_A_FILE', 'path is not a directory');
  const names: string[] = [];
  try {
    const directory = await opendir(target);
    try {
      for await (const entry of directory) {
        if (entry.isFile() && !entry.isSymbolicLink()) names.push(entry.name);
        if (names.length >= maxEntries) break;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  } catch {
    throw new ReadFailure('UNREADABLE', 'directory could not be read');
  }
  return { state: 'present', names: names.sort() };
}
