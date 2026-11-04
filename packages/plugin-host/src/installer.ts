import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  PluginManifestValidationError,
  validatePluginManifest,
  type PluginManifest,
  type PluginManifestValidationOptions
} from '@stackmanage/plugin-sdk';
import { PluginHostError } from './errors';
import type { TrustedKeyring } from './keys';
import { DEFAULT_PLUGIN_PACKAGE_LIMITS, extractPluginPackage, type PluginPackageLimits } from './package';
import { isInside, resolveWithin, safeSegment, type PluginPaths } from './paths';
import { findRegistryEntry, type LoadedRegistry } from './registry';
import { sha256Hex, verifyDetachedSignature } from './signature';
import type { InstalledPluginRecord } from './state';

export interface PluginInstallerOptions {
  readonly paths: PluginPaths;
  readonly keyring: TrustedKeyring;
  readonly hostVersion: string;
  readonly requireSignature: boolean;
  readonly limits?: PluginPackageLimits;
}

export interface PreparedPlugin {
  readonly manifest: PluginManifest;
  readonly targetDir: string;
  readonly stagingDir: string;
  promote(): Promise<void>;
  /** Remove staging (before promotion) or the promoted directory (rollback). */
  cleanup(): Promise<void>;
}

export interface StagedRemoval {
  readonly trashPath: string;
  restore(): Promise<void>;
  finalize(): Promise<void>;
}

function validationToHostError(error: unknown): PluginHostError {
  if (error instanceof PluginManifestValidationError) {
    switch (error.code) {
      case 'UNSUPPORTED_API':
        return new PluginHostError('UNSUPPORTED_API');
      case 'INCOMPATIBLE_HOST':
        return new PluginHostError('INCOMPATIBLE_HOST');
      case 'SIGNATURE_REQUIRED':
        return new PluginHostError('SIGNATURE_REQUIRED');
      case 'UNSUPPORTED_PERMISSION':
        return new PluginHostError('UNSUPPORTED_PERMISSION');
      case 'INVALID_HOST_VERSION':
        return new PluginHostError('INVALID_HOST_VERSION');
      case 'INVALID_MANIFEST':
      default:
        return new PluginHostError('INVALID_MANIFEST');
    }
  }
  return new PluginHostError('UNKNOWN');
}

/**
 * Package-boundary installer. It verifies the registry entry, package digest, manifest
 * digest and detached Ed25519 signature, extracts into staging and only then promotes
 * with an atomic rename. It never receives a caller-supplied package path or digest.
 */
export class PluginInstaller {
  private readonly limits: PluginPackageLimits;

  constructor(private readonly options: PluginInstallerOptions) {
    this.limits = options.limits ?? DEFAULT_PLUGIN_PACKAGE_LIMITS;
  }

  async prepare(registry: LoadedRegistry, id: string, version: string, installed: readonly InstalledPluginRecord[]): Promise<PreparedPlugin> {
    if (installed.some(record => record.id === id)) throw new PluginHostError('DUPLICATE_PLUGIN');
    const entry = findRegistryEntry(registry, id, version);

    const packagePath = resolveWithin(registry.directory, entry.package.file);
    const packageStats = await lstat(packagePath).catch(() => undefined);
    if (packageStats === undefined || !packageStats.isFile() || packageStats.isSymbolicLink()) {
      throw new PluginHostError('UNSAFE_PACKAGE_PATH', 'package');
    }
    if (packageStats.size > this.limits.maxArchiveBytes) throw new PluginHostError('PACKAGE_TOO_LARGE', 'archive');

    const packageBytes = await readFile(packagePath).catch(() => undefined);
    if (packageBytes === undefined) throw new PluginHostError('IO_ERROR', 'package-read');
    if (sha256Hex(packageBytes) !== entry.package.sha256) throw new PluginHostError('PACKAGE_DIGEST_MISMATCH');

    const stagingDir = join(this.options.paths.stagingRoot, `${safeSegment(id)}-${safeSegment(version)}-${randomBytes(6).toString('hex')}`);
    let promoted = false;
    try {
      const extracted = await extractPluginPackage({ archivePath: packagePath, stagingDir, limits: this.limits });
      if (sha256Hex(extracted.manifestBytes) !== entry.manifestSha256) throw new PluginHostError('MANIFEST_DIGEST_MISMATCH');

      let parsed: unknown;
      try {
        parsed = JSON.parse(extracted.manifestBytes.toString('utf8'));
      } catch {
        throw new PluginHostError('INVALID_MANIFEST', 'json');
      }

      const validationOptions: PluginManifestValidationOptions = {
        hostVersion: this.options.hostVersion,
        requireSignature: this.options.requireSignature
      };
      let manifest: PluginManifest;
      try {
        manifest = validatePluginManifest(parsed, validationOptions);
      } catch (error) {
        throw validationToHostError(error);
      }
      if (manifest.id !== entry.id || manifest.version !== entry.version) throw new PluginHostError('INVALID_MANIFEST', 'identity');

      this.verifyManifestSignature(manifest, extracted.manifestBytes, extracted.signatureText);

      const entryPath = resolve(stagingDir, manifest.entry);
      if (!isInside(stagingDir, entryPath)) throw new PluginHostError('UNSAFE_PACKAGE_PATH', 'entry');
      const entryStats = await lstat(entryPath).catch(() => undefined);
      if (entryStats === undefined || !entryStats.isFile() || entryStats.isSymbolicLink()) {
        throw new PluginHostError('INVALID_MANIFEST', 'entry');
      }

      const targetDir = resolve(this.options.paths.installedRoot, safeSegment(id), safeSegment(version));
      if (!isInside(this.options.paths.installedRoot, targetDir)) throw new PluginHostError('FORBIDDEN');
      if (await lstat(targetDir).then(() => true).catch(() => false)) throw new PluginHostError('DUPLICATE_PLUGIN');

      const prepared: PreparedPlugin = {
        manifest,
        targetDir,
        stagingDir,
        async promote() {
          await mkdir(dirname(targetDir), { recursive: true });
          await rename(stagingDir, targetDir);
          promoted = true;
        },
        async cleanup() {
          await rm(promoted ? targetDir : stagingDir, { recursive: true, force: true }).catch(() => undefined);
        }
      };
      return prepared;
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private verifyManifestSignature(manifest: PluginManifest, manifestBytes: Buffer, signatureText: string | undefined): void {
    if (manifest.signature === undefined) {
      if (signatureText !== undefined) throw new PluginHostError('INVALID_MANIFEST', 'unexpected-signature');
      if (this.options.requireSignature) throw new PluginHostError('SIGNATURE_REQUIRED');
      return;
    }
    if (signatureText === undefined) throw new PluginHostError('SIGNATURE_INVALID', 'missing');
    verifyDetachedSignature({
      data: manifestBytes,
      signature: signatureText,
      keyId: manifest.signature.keyId,
      keyring: this.options.keyring
    });
  }

  /** Move an installed directory aside before state removal; restore on a required state failure. */
  async stageRemoval(record: InstalledPluginRecord): Promise<StagedRemoval> {
    const directory = resolveWithin(this.options.paths.root, record.installPath);
    if (!isInside(this.options.paths.installedRoot, directory)) throw new PluginHostError('FORBIDDEN', 'install-path');
    const stats = await lstat(directory).catch(() => undefined);
    if (stats === undefined || !stats.isDirectory() || stats.isSymbolicLink()) throw new PluginHostError('PLUGIN_NOT_FOUND', 'directory');

    const trashPath = join(this.options.paths.trashRoot, `${safeSegment(record.id)}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);
    await mkdir(this.options.paths.trashRoot, { recursive: true });
    await rename(directory, trashPath);
    return {
      trashPath,
      async restore() {
        await mkdir(dirname(directory), { recursive: true });
        await rename(trashPath, directory);
      },
      async finalize() {
        await rm(trashPath, { recursive: true, force: true });
      }
    };
  }
}
