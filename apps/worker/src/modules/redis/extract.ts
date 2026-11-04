/**
 * Safe extraction for the official Redis source tarball.
 *
 * The archive's single top-level directory is preserved. Absolute paths,
 * traversal, entries outside that directory, links and special files are
 * rejected before they can write outside staging.
 */
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import * as tar from 'tar';
import { OperationFailure } from '../../shared/operation';
import type { RedisLimits } from './manifest';

export interface RedisExtractOptions {
  archivePath: string;
  stagingDir: string;
  topLevelDir: string;
  limits: RedisLimits;
}

export interface RedisExtractResult {
  topLevelPath: string;
  entries: number;
  bytes: number;
  skipped: number;
}

/** Files that must exist in a real Redis source tree before a build is attempted. */
const REQUIRED_ENTRIES = ['Makefile', 'src/Makefile'] as const;

function normalizeEntry(entryPath: string): string {
  return entryPath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function safeJoin(base: string, entryPath: string): string {
  const normalized = normalizeEntry(entryPath);
  if (normalized.length === 0 || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'absolute path');
  }
  if (normalized.split('/').includes('..')) throw new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'traversal');
  const baseResolved = resolve(base);
  const target = resolve(baseResolved, normalized);
  if (target !== baseResolved && !target.startsWith(`${baseResolved}${sep}`)) {
    throw new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'escape');
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
}

/** Walk only the preserved top-level directory; links and special files are rejected. */
async function walkRegularFiles(root: string, limits: RedisLimits, state: WalkState): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    state.entries += 1;
    if (state.entries > limits.maxExtractedEntries) throw new OperationFailure('IO_ERROR', 'redis.archiveTooLarge', false);
    const path = join(root, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'link');
    if (stats.isDirectory()) {
      await walkRegularFiles(path, limits, state);
      continue;
    }
    if (!stats.isFile()) throw new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'special file');
    if (stats.size > limits.maxExtractedFileBytes) throw new OperationFailure('IO_ERROR', 'redis.archiveTooLarge', false);
    state.bytes += stats.size;
    if (state.bytes > limits.maxExtractedTotalBytes) throw new OperationFailure('IO_ERROR', 'redis.archiveTooLarge', false);
  }
}

export async function extractRedisSource(options: RedisExtractOptions): Promise<RedisExtractResult> {
  const { archivePath, stagingDir, topLevelDir, limits } = options;
  await mkdir(stagingDir, { recursive: true });
  let rejected: OperationFailure | undefined;
  let entries = 0;
  let bytes = 0;

  const parser = tar.x({
    file: archivePath,
    cwd: stagingDir,
    strict: true,
    preservePaths: false,
    filter: (entryPath: string, entry: unknown) => {
      if (rejected !== undefined) return false;
      const normalized = normalizeEntry(entryPath);
      entries += 1;
      if (entries > limits.maxExtractedEntries) {
        rejected = new OperationFailure('IO_ERROR', 'redis.archiveTooLarge', false);
        return false;
      }
      try {
        safeJoin(stagingDir, normalized);
      } catch {
        rejected = new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'escape');
        return false;
      }
      if (!insideTopLevel(normalized, topLevelDir)) {
        rejected = new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'outside top-level');
        return false;
      }
      const typed = entry as { type?: string; size?: number };
      if (typed.type === 'SymbolicLink' || typed.type === 'Link') {
        rejected = new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'link');
        return false;
      }
      if (typed.type === 'Directory') return true;
      if (typed.type !== undefined && typed.type !== 'File' && typed.type !== 'OldFile' && typed.type !== 'ContiguousFile') {
        rejected = new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'special entry');
        return false;
      }
      const size = typeof typed.size === 'number' ? typed.size : 0;
      if (size > limits.maxExtractedFileBytes) {
        rejected = new OperationFailure('IO_ERROR', 'redis.archiveTooLarge', false);
        return false;
      }
      bytes += size;
      if (bytes > limits.maxExtractedTotalBytes) {
        rejected = new OperationFailure('IO_ERROR', 'redis.archiveTooLarge', false);
        return false;
      }
      return true;
    }
  });
  await parser.catch(() => undefined);
  if (rejected !== undefined) throw rejected;

  const topLevelPath = join(stagingDir, topLevelDir);
  const topStats = await lstat(topLevelPath).catch(() => undefined);
  if (topStats === undefined || !topStats.isDirectory()) {
    throw new OperationFailure('IO_ERROR', 'redis.sourceMissing', false, topLevelDir);
  }
  for (const relative of REQUIRED_ENTRIES) {
    const stats = await lstat(join(topLevelPath, ...relative.split('/'))).catch(() => undefined);
    if (stats === undefined || !stats.isFile()) {
      throw new OperationFailure('IO_ERROR', 'redis.sourceMissing', false, relative);
    }
  }
  const state: WalkState = { entries: 0, bytes: 0 };
  await walkRegularFiles(topLevelPath, limits, state);
  return { topLevelPath, entries: state.entries, bytes: state.bytes, skipped: 0 };
}
