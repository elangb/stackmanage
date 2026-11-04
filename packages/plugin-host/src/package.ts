import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import * as tar from 'tar';
import { PluginHostError } from './errors';

export interface PluginPackageLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxManifestBytes: number;
  readonly maxSignatureBytes: number;
}

export const DEFAULT_PLUGIN_PACKAGE_LIMITS: PluginPackageLimits = Object.freeze({
  maxArchiveBytes: 10 * 1024 * 1024,
  maxEntries: 512,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxManifestBytes: 262_144,
  maxSignatureBytes: 4_096
});

/** Normalize a tar entry and reject absolute/drive/traversal/backslash paths. */
export function normalizeArchivePath(value: string): string {
  if (value.includes('\0') || value.includes('\\')) throw new PluginHostError('UNSAFE_PACKAGE_PATH');
  let normalized = value;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.length === 0 || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new PluginHostError('UNSAFE_PACKAGE_PATH');
  }
  const segments = normalized.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new PluginHostError('UNSAFE_PACKAGE_PATH');
  }
  if (posix.normalize(normalized) !== normalized) throw new PluginHostError('UNSAFE_PACKAGE_PATH');
  return normalized;
}

function safeJoin(base: string, entryPath: string): string {
  const normalized = normalizeArchivePath(entryPath);
  const baseResolved = resolve(base);
  const target = resolve(baseResolved, normalized);
  if (target !== baseResolved && !target.startsWith(`${baseResolved}${sep}`)) {
    throw new PluginHostError('UNSAFE_PACKAGE_PATH');
  }
  return target;
}

interface WalkState {
  entries: number;
  bytes: number;
}

async function walkRegularFiles(root: string, limits: PluginPackageLimits, state: WalkState): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    state.entries += 1;
    if (state.entries > limits.maxEntries) throw new PluginHostError('PACKAGE_TOO_LARGE', 'entries');
    const path = join(root, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new PluginHostError('UNSAFE_PACKAGE_PATH', 'link');
    if (stats.isDirectory()) {
      await walkRegularFiles(path, limits, state);
      continue;
    }
    if (!stats.isFile()) throw new PluginHostError('UNSAFE_PACKAGE_PATH', 'special');
    if (stats.size > limits.maxFileBytes) throw new PluginHostError('PACKAGE_TOO_LARGE', 'file');
    state.bytes += stats.size;
    if (state.bytes > limits.maxTotalBytes) throw new PluginHostError('PACKAGE_TOO_LARGE', 'total');
  }
}

export interface ExtractPluginPackageOptions {
  readonly archivePath: string;
  readonly stagingDir: string;
  readonly limits?: PluginPackageLimits;
}

export interface ExtractedPluginPackage {
  readonly stagingDir: string;
  readonly manifestPath: string;
  readonly manifestBytes: Buffer;
  readonly signaturePath?: string;
  readonly signatureText?: string;
}

/**
 * Extract a plugin tarball into a fresh staging directory and return the exact
 * `plugin.json` bytes. Links, special files, absolute paths and traversal are rejected
 * before they can write outside staging; the caller removes staging on any failure.
 */
export async function extractPluginPackage(options: ExtractPluginPackageOptions): Promise<ExtractedPluginPackage> {
  const limits = options.limits ?? DEFAULT_PLUGIN_PACKAGE_LIMITS;
  const archiveStats = await lstat(options.archivePath).catch(() => undefined);
  if (archiveStats === undefined || !archiveStats.isFile()) throw new PluginHostError('IO_ERROR', 'archive');
  if (archiveStats.isSymbolicLink()) throw new PluginHostError('UNSAFE_PACKAGE_PATH', 'archive-link');
  if (archiveStats.size > limits.maxArchiveBytes) throw new PluginHostError('PACKAGE_TOO_LARGE', 'archive');

  await mkdir(options.stagingDir, { recursive: true });
  let rejected: PluginHostError | undefined;
  let entries = 0;
  let bytes = 0;

  const parser = tar.x({
    file: options.archivePath,
    cwd: options.stagingDir,
    strict: true,
    preservePaths: false,
    filter: (entryPath: string, entry: unknown) => {
      if (rejected !== undefined) return false;
      const candidate = entryPath.replace(/\\/g, '/');
      if (candidate === '' || candidate === '.' || candidate === './') return false;
      try {
        const normalized = normalizeArchivePath(entryPath);
        safeJoin(options.stagingDir, normalized);
      } catch {
        rejected = new PluginHostError('UNSAFE_PACKAGE_PATH', 'entry');
        return false;
      }
      entries += 1;
      if (entries > limits.maxEntries) {
        rejected = new PluginHostError('PACKAGE_TOO_LARGE', 'entries');
        return false;
      }
      const typed = entry as { type?: string; size?: number };
      if (typed.type === 'SymbolicLink' || typed.type === 'Link') {
        rejected = new PluginHostError('UNSAFE_PACKAGE_PATH', 'link');
        return false;
      }
      if (typed.type === 'Directory') return true;
      if (typed.type !== undefined && typed.type !== 'File' && typed.type !== 'OldFile' && typed.type !== 'ContiguousFile') {
        rejected = new PluginHostError('UNSAFE_PACKAGE_PATH', 'special');
        return false;
      }
      const size = typeof typed.size === 'number' ? typed.size : 0;
      if (size > limits.maxFileBytes) {
        rejected = new PluginHostError('PACKAGE_TOO_LARGE', 'file');
        return false;
      }
      bytes += size;
      if (bytes > limits.maxTotalBytes) {
        rejected = new PluginHostError('PACKAGE_TOO_LARGE', 'total');
        return false;
      }
      return true;
    }
  });
  await parser.catch(() => undefined);
  if (rejected !== undefined) throw rejected;

  await walkRegularFiles(options.stagingDir, limits, { entries: 0, bytes: 0 });

  const manifestPath = join(options.stagingDir, 'plugin.json');
  const manifestStats = await lstat(manifestPath).catch(() => undefined);
  if (manifestStats === undefined || !manifestStats.isFile()) throw new PluginHostError('INVALID_MANIFEST', 'missing');
  if (manifestStats.size > limits.maxManifestBytes) throw new PluginHostError('INVALID_MANIFEST', 'size');
  const manifestBytes = await readFile(manifestPath);

  const signaturePath = join(options.stagingDir, 'plugin.sig');
  const signatureStats = await lstat(signaturePath).catch(() => undefined);
  if (signatureStats !== undefined) {
    if (!signatureStats.isFile()) throw new PluginHostError('UNSAFE_PACKAGE_PATH', 'signature');
    if (signatureStats.size > limits.maxSignatureBytes) throw new PluginHostError('SIGNATURE_INVALID', 'size');
    const signatureText = (await readFile(signaturePath, 'utf8')).trim();
    return { stagingDir: options.stagingDir, manifestPath, manifestBytes, signaturePath, signatureText };
  }

  return { stagingDir: options.stagingDir, manifestPath, manifestBytes };
}
