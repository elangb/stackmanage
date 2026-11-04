/**
 * Safe archive extraction for the official Node.js distribution.
 *
 * The archive's top-level directory is preserved. Entries outside that directory,
 * absolute paths, traversal, devices and escaping links are rejected before they
 * can write outside staging. Symlink entries are never materialised; the official
 * tarball's convenience links (npm/npx/corepack) are skipped, while `bin/node`
 * remains a regular file that is verified after extraction.
 */
import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import * as tar from 'tar';
import extractZip from 'extract-zip';
import { OperationFailure } from '../../shared/operation';
import type { NodeLimits } from './manifest';

export interface NodeExtractOptions {
  archivePath: string;
  kind: 'tar.gz' | 'zip';
  stagingDir: string;
  topLevelDir: string;
  binaryRelativePath: string;
  limits: NodeLimits;
}

export interface NodeExtractResult {
  topLevelPath: string;
  binaryPath: string;
  extracted: string[];
  skipped: number;
  skippedLinks: number;
}

const SYMLINK_MODE = 0o120000;

function normalizeEntry(entryPath: string): string {
  return entryPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeJoin(base: string, entryPath: string): string {
  const normalized = normalizeEntry(entryPath);
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'absolute path');
  }
  if (normalized.split('/').includes('..')) throw new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'traversal');
  const baseResolved = resolve(base);
  const target = resolve(baseResolved, normalized);
  if (target !== baseResolved && !target.startsWith(`${baseResolved}${sep}`)) {
    throw new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'escape');
  }
  return target;
}

function insideTopLevel(entryPath: string, topLevelDir: string): boolean {
  const normalized = normalizeEntry(entryPath);
  return normalized === topLevelDir || normalized.startsWith(`${topLevelDir}/`);
}

interface WalkState {
  entries: number;
  bytes: number;
  files: string[];
}

/** Walk only the preserved top-level directory; links and special files are rejected. */
async function walkRegularFiles(root: string, limits: NodeLimits, state: WalkState): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    state.entries += 1;
    if (state.entries > limits.maxExtractedEntries) throw new OperationFailure('IO_ERROR', 'runtime.archiveTooLarge', false);
    const path = join(root, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'link');
    if (stats.isDirectory()) {
      await walkRegularFiles(path, limits, state);
      continue;
    }
    if (!stats.isFile()) throw new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'special file');
    if (stats.size > limits.maxExtractedFileBytes) throw new OperationFailure('IO_ERROR', 'runtime.archiveTooLarge', false);
    state.bytes += stats.size;
    if (state.bytes > limits.maxExtractedTotalBytes) throw new OperationFailure('IO_ERROR', 'runtime.archiveTooLarge', false);
    state.files.push(path);
  }
}

export async function extractNodeArchive(options: NodeExtractOptions): Promise<NodeExtractResult> {
  const { archivePath, stagingDir, topLevelDir, binaryRelativePath, limits } = options;
  await mkdir(stagingDir, { recursive: true });
  let skipped = 0;
  let skippedLinks = 0;

  if (options.kind === 'tar.gz') {
    let rejected: OperationFailure | undefined;
    let entries = 0;
    let bytes = 0;
    const parser = tar.x({
      file: archivePath,
      cwd: stagingDir,
      strict: true,
      preservePaths: false,
      noChmod: true,
      noMtime: true,
      filter: (entryPath: string, entry: unknown) => {
        if (rejected !== undefined) return false;
        const normalized = normalizeEntry(entryPath);
        entries += 1;
        if (entries > limits.maxExtractedEntries) {
          rejected = new OperationFailure('IO_ERROR', 'runtime.archiveTooLarge', false);
          return false;
        }
        try {
          safeJoin(stagingDir, normalized);
        } catch {
          rejected = new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'escape');
          return false;
        }
        if (!insideTopLevel(normalized, topLevelDir)) {
          rejected = new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'outside top-level');
          return false;
        }
        const typed = entry as { type?: string; size?: number };
        if (typed.type === 'SymbolicLink' || typed.type === 'Link') {
          // Never materialise a link. Official npm/npx/corepack links are skipped;
          // a link named as the required binary leaves no regular file and fails below.
          skipped += 1;
          skippedLinks += 1;
          return false;
        }
        if (typed.type === 'Directory') {
          skipped += 1;
          return false;
        }
        if (typed.type !== undefined && typed.type !== 'File' && typed.type !== 'OldFile' && typed.type !== 'ContiguousFile') {
          rejected = new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'special entry');
          return false;
        }
        const size = typeof typed.size === 'number' ? typed.size : 0;
        if (size > limits.maxExtractedFileBytes) {
          rejected = new OperationFailure('IO_ERROR', 'runtime.archiveTooLarge', false);
          return false;
        }
        bytes += size;
        if (bytes > limits.maxExtractedTotalBytes) {
          rejected = new OperationFailure('IO_ERROR', 'runtime.archiveTooLarge', false);
          return false;
        }
        return true;
      }
    });
    await parser.catch(() => undefined);
    if (rejected !== undefined) throw rejected;
  } else {
    await extractZip(archivePath, {
      dir: stagingDir,
      onEntry: entry => {
        const normalized = normalizeEntry(entry.fileName);
        safeJoin(stagingDir, normalized);
        if (!insideTopLevel(normalized, topLevelDir)) {
          throw new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'outside top-level');
        }
        if (((entry.externalFileAttributes >>> 16) & SYMLINK_MODE) === SYMLINK_MODE) {
          skippedLinks += 1;
          throw new OperationFailure('IO_ERROR', 'runtime.unsafeEntry', false, 'link');
        }
      }
    });
  }

  const topLevelPath = join(stagingDir, topLevelDir);
  const topStats = await lstat(topLevelPath).catch(() => undefined);
  if (topStats === undefined || !topStats.isDirectory()) {
    throw new OperationFailure('IO_ERROR', 'runtime.binaryMissing', false, topLevelDir);
  }
  const state: WalkState = { entries: 0, bytes: 0, files: [] };
  await walkRegularFiles(topLevelPath, limits, state);
  skipped += skippedLinks;
  const binaryPath = join(topLevelPath, ...binaryRelativePath.split('/'));
  const binaryStats = await lstat(binaryPath).catch(() => undefined);
  if (binaryStats === undefined || !binaryStats.isFile() || binaryStats.size === 0) {
    throw new OperationFailure('IO_ERROR', 'runtime.binaryMissing', false, binaryRelativePath);
  }
  const extracted = await readdir(topLevelPath);
  return { topLevelPath, binaryPath, extracted, skipped, skippedLinks };
}

export async function removeNodeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
