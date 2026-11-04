import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import * as tar from 'tar';
import extractZip from 'extract-zip';
import type { OperationalLimits } from './manifest';
import { OperationFailure } from './manifest';

export interface ExtractOptions {
  archivePath: string;
  kind: 'tar.gz' | 'zip';
  stagingDir: string;
  limits: OperationalLimits;
  /** Only these top-level file names may remain in staging. Everything else is skipped. */
  requiredFiles: string[];
}

export interface ExtractResult {
  stagingDir: string;
  extracted: string[];
  skipped: number;
}

const SYMLINK_MODE = 0o120000;

function normalizeEntry(entryPath: string): string {
  return entryPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeJoin(base: string, entryPath: string): string {
  const normalized = normalizeEntry(entryPath);
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'absolute path');
  }
  if (normalized.split('/').includes('..')) throw new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'traversal');
  const baseResolved = resolve(base);
  const target = resolve(baseResolved, normalized);
  if (target !== baseResolved && !target.startsWith(`${baseResolved}${sep}`)) {
    throw new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'escape');
  }
  return target;
}

/** Walk the extracted tree and reject links/specials; returns regular files. */
async function assertRegularFilesOnly(root: string, limits: OperationalLimits): Promise<string[]> {
  const files: string[] = [];
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      count += 1;
      if (count > limits.maxExtractedEntries) throw new OperationFailure('IO_ERROR', 'install.archiveTooLarge', false);
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        await rm(path, { force: true });
        throw new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'link');
      }
      if (stats.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!stats.isFile()) throw new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'special file');
      if (stats.size > limits.maxExtractedFileBytes) throw new OperationFailure('IO_ERROR', 'install.archiveTooLarge', false);
      files.push(path);
    }
  };
  await walk(root);
  return files;
}

/**
 * Extract only the required top-level regular files into a fresh staging
 * directory. Archive links, devices, absolute paths and traversal entries are
 * rejected before they can write outside staging.
 *
 * tar (7.5.22) filter receives the parsed entry; extract-zip (2.0.1) has no
 * filter hook, so its output is pruned and re-checked afterwards.
 */
export async function extractBinary(options: ExtractOptions): Promise<ExtractResult> {
  const { archivePath, stagingDir, limits, requiredFiles } = options;
  await mkdir(stagingDir, { recursive: true });
  const wanted = (entryPath: string): boolean => {
    const name = normalizeEntry(entryPath).split('/').pop() ?? '';
    return requiredFiles.includes(name);
  };
  let skipped = 0;

  if (options.kind === 'tar.gz') {
    // `tar`'s filter cannot reject by throwing: the throw escapes into its stream
    // internals. Record the first rejection, then let the stream unwind and throw
    // it afterwards so one archive yields exactly one OperationFailure.
    let rejected: OperationFailure | undefined;
    const parser = tar.x({
      file: archivePath,
      cwd: stagingDir,
      strict: true,
      preservePaths: false,
      noChmod: true,
      noMtime: true,
      filter: (entryPath: string, entry: unknown) => {
        if (rejected !== undefined) return false;
        try {
          safeJoin(stagingDir, entryPath);
        } catch {
          rejected = new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'escape');
          return false;
        }
        const typed = entry as { type?: string; size?: number };
        if (typed.type === 'SymbolicLink' || typed.type === 'Link') {
          rejected = new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'link');
          return false;
        }
        if (typed.type === 'Directory') {
          skipped += 1;
          return false;
        }
        if (typed.type !== undefined && typed.type !== 'File' && typed.type !== 'OldFile' && typed.type !== 'ContiguousFile') {
          rejected = new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'special entry');
          return false;
        }
        if (typeof typed.size === 'number' && typed.size > limits.maxExtractedFileBytes) {
          rejected = new OperationFailure('IO_ERROR', 'install.archiveTooLarge', false);
          return false;
        }
        if (!wanted(entryPath)) {
          skipped += 1;
          return false;
        }
        return true;
      }
    });
    await parser.catch(() => undefined);
    if (rejected !== undefined) throw rejected;
    await assertRegularFilesOnly(stagingDir, limits);
  } else {
    await extractZip(archivePath, {
      dir: stagingDir,
      onEntry: entry => {
        safeJoin(stagingDir, entry.fileName);
        if (((entry.externalFileAttributes >>> 16) & SYMLINK_MODE) === SYMLINK_MODE) {
          throw new OperationFailure('IO_ERROR', 'install.unsafeEntry', false, 'link');
        }
      }
    });
    for (const file of await assertRegularFilesOnly(stagingDir, limits)) {
      if (!wanted(file)) {
        await rm(file, { force: true });
        skipped += 1;
      }
    }
  }

  for (const required of requiredFiles) {
    const path = join(stagingDir, required);
    const stats = await lstat(path).catch(() => undefined);
    if (stats === undefined || !stats.isFile() || stats.size === 0) {
      throw new OperationFailure('IO_ERROR', 'install.binaryMissing', false, required);
    }
  }
  return { stagingDir, extracted: await readdir(stagingDir), skipped };
}

export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
