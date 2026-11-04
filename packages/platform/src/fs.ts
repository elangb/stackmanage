import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileSystemPort, PathKind, TextFileSystem } from './ports.js';

export const PATH_MAX = 4096;

/** Absolute POSIX or Windows path without NUL: safe to pass as a single argv element. */
export function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PATH_MAX && !value.includes('\0') && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value);
}

/**
 * Writes `content` to a uniquely named sibling temp file, flushes it to disk and
 * renames it over `path`. A reader observes either the old or the new content,
 * never a truncated file. The temp file is removed when the rename fails.
 */
export async function writeFileAtomicWith(fs: TextFileSystem, path: string, content: string): Promise<void> {
  const directory = dirname(path);
  if (directory === path || directory.length === 0) throw new Error('atomic write requires an absolute path with a directory');
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${path}.stackmanage-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.tmp`;
  await fs.writeFile(tempPath, content, 'utf8');
  try {
    await fs.rename(tempPath, path);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function pathKindWith(fs: TextFileSystem, path: string): Promise<PathKind> {
  try {
    const info = await fs.stat(path);
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** Real filesystem port. Production only; tests inject temp-directory backed fakes. */
export function createNodeFileSystem(): FileSystemPort {
  return {
    readFile: (path: string) => readFile(path, 'utf8'),
    writeFile: (path: string, content: string) => writeFile(path, content, 'utf8'),
    writeFileAtomic: (path: string, content: string) => writeFileAtomicWith({ readFile, writeFile, rename, rm, mkdir, readdir, stat }, path, content),
    mkdirp: async (path: string) => {
      await mkdir(path, { recursive: true });
    },
    remove: async (path: string) => {
      await rm(path, { force: true });
    },
    rename,
    modifiedAt: async (path: string) => {
      try {
        return (await stat(path)).mtimeMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    kind: (path: string) => pathKindWith({ readFile, writeFile, rename, rm, mkdir, readdir, stat }, path),
    readdir,
    canWrite: async (path: string) => {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
  };
}
