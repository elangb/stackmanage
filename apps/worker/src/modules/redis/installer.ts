/**
 * Redis installer.
 *
 * Linux installations are compiled from the pinned official source into a
 * per-user prefix. The build is staged, validated with `redis-server --version`
 * and `redis-cli --version`, and promoted with a rollback path. Uninstall
 * removes only a recorded installation whose paths still resolve inside the
 * managed root.
 */
import { chmod, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InstallRequest,
  ModuleStorage,
  OperationContext,
  OperationResult,
  RedisInstallationView,
  RedisListView,
  RedisVersionsView
} from '@stackmanage/core';
import { OperationResultSchema, RedisInstallationViewSchema, RedisListViewSchema, RedisVersionsViewSchema } from '@stackmanage/core';
import { failureResult, OperationFailure, OperationProgress, throwIfAborted } from '../../shared/operation';
import { isInside, pathExists } from '../../shared/files';
import { downloadVerified, fileDigest } from './download';
import {
  DEFAULT_REDIS_LIMITS,
  REDIS_ASSETS,
  REDIS_MODULE_ID,
  REDIS_PROVENANCE,
  REDIS_SOURCE_URL,
  REDIS_VERSION,
  installationId,
  redisArchitecture,
  redisPlatform,
  redisTarget,
  type RedisAsset,
  type RedisLimits,
  type RedisTarget
} from './manifest';
import { assertBuildDependencies, checkBuildDependencies, type BuildDependencyReport } from './preflight';
import { buildRedisFromSource, type RedisBuildResult } from './build';
import { validateRedisInstallation } from './run';
import { REDIS_STORAGE_KEYS, RedisInstallationRecordSchema, RedisInstallationsRecordSchema, type RedisInstallationRecord } from './state';
import type { RedisPaths } from './paths';

export type RedisBuildFn = (input: Parameters<typeof buildRedisFromSource>[0]) => Promise<RedisBuildResult>;
export type RedisPreflightFn = (input: Parameters<typeof checkBuildDependencies>[0]) => Promise<BuildDependencyReport>;
export type RedisDownloadFn = (input: Parameters<typeof downloadVerified>[0]) => Promise<{ bytes: number; resumed: boolean }>;

export interface RedisInstallerDeps {
  storage: ModuleStorage;
  paths: RedisPaths;
  limits?: RedisLimits;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  /** Test seams; production always uses the real preflight and source build. */
  preflight?: RedisPreflightFn;
  build?: RedisBuildFn;
  download?: RedisDownloadFn;
}

function normalizedPlatform(value: string): 'win32' | 'linux' | 'darwin' {
  if (value === 'win32' || value === 'windows') return 'win32';
  if (value === 'darwin') return 'darwin';
  return 'linux';
}

function normalizedArchitecture(value: string): 'x64' | 'arm64' {
  return value === 'arm64' ? 'arm64' : 'x64';
}

function completed(operationId: string, itemId: string, warnings: OperationResult['warnings'] = []): OperationResult {
  return OperationResultSchema.parse({ operationId, status: 'completed', items: [{ id: itemId, status: 'completed' }], warnings });
}

function toFailure(error: unknown, signal?: AbortSignal): OperationFailure {
  if (signal?.aborted === true) return new OperationFailure('CANCELLED', 'cancelled', false);
  if (error instanceof OperationFailure) return error;
  if (error instanceof Error && error.name === 'OperationAbortedError') return new OperationFailure('CANCELLED', 'cancelled', false);
  return new OperationFailure('UNKNOWN', 'redis.unknown', false);
}

export class RedisInstaller {
  private readonly limits: RedisLimits;
  private readonly platform: string;
  private readonly architecture: string;
  private activeInstall: Promise<OperationResult> | undefined;

  constructor(private readonly deps: RedisInstallerDeps) {
    this.limits = deps.limits ?? DEFAULT_REDIS_LIMITS;
    this.platform = deps.platform ?? process.platform;
    this.architecture = deps.architecture ?? process.arch;
  }

  versionsView(moduleId: string): RedisVersionsView {
    if (moduleId !== REDIS_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'redis.moduleUnsupported', false);
    const current = redisTarget(this.platform, this.architecture);
    const versions = (Object.keys(REDIS_ASSETS) as RedisTarget[]).map(target => {
      const asset = REDIS_ASSETS[target];
      return {
        moduleId: 'redis' as const,
        version: REDIS_VERSION,
        platform: redisPlatform(),
        architecture: redisArchitecture(target),
        source: asset.source,
        sha256: asset.sha256,
        archive: asset.archive,
        kind: asset.kind,
        tested: asset.tested,
        supported: asset.supported
      };
    });
    return RedisVersionsViewSchema.parse({
      moduleId: REDIS_MODULE_ID,
      pinnedVersion: REDIS_VERSION,
      platform: normalizedPlatform(this.platform),
      architecture: normalizedArchitecture(this.architecture),
      supported: current !== undefined && REDIS_ASSETS[current].supported,
      tested: current !== undefined && REDIS_ASSETS[current].tested,
      versions
    });
  }

  async installed(): Promise<RedisInstallationRecord | undefined> {
    const records = await this.readRecords();
    for (const record of records) {
      if (!(await this.recordIsValid(record))) continue;
      return record;
    }
    return undefined;
  }

  async list(moduleId: string): Promise<RedisListView> {
    if (moduleId !== REDIS_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'redis.moduleUnsupported', false);
    const records = await this.readRecords();
    const installations: RedisInstallationView[] = [];
    for (const record of records) {
      if (await this.recordIsValid(record)) installations.push(this.view(record));
    }
    return RedisListViewSchema.parse({ moduleId: REDIS_MODULE_ID, installations });
  }

  view(record: RedisInstallationRecord): RedisInstallationView {
    return RedisInstallationViewSchema.parse({
      id: record.id,
      moduleId: REDIS_MODULE_ID,
      version: record.version,
      platform: redisPlatform(),
      architecture: redisArchitecture(record.target),
      directory: record.directory,
      serverPath: record.serverPath,
      cliPath: record.cliPath,
      versionOutput: record.versionOutput,
      cliVersionOutput: record.cliVersionOutput,
      installedAt: record.installedAt,
      source: record.source,
      sha256: record.sha256
    });
  }

  install(request: InstallRequest, context: OperationContext): Promise<OperationResult> {
    if (this.activeInstall !== undefined) {
      return Promise.resolve(failureResult(context.operationId, { code: 'CONFLICT', messageKey: 'redis.installBusy', retryable: true }, `install-${REDIS_MODULE_ID}`));
    }
    const progress = new OperationProgress(context);
    const job = this.installInner(request, context, progress)
      .catch(error => {
        const failure = toFailure(error, context.signal);
        this.deps.logger?.info('redis.installFailed', {
          code: failure.code,
          messageKey: failure.messageKey,
          ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
          ...(error instanceof Error && failure.detail === undefined ? { error: error.message } : {})
        });
        return failureResult(context.operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, `install-${REDIS_MODULE_ID}`);
      })
      .then(result => {
        progress.terminal(result);
        return result;
      })
      .finally(() => {
        if (this.activeInstall === job) this.activeInstall = undefined;
      });
    this.activeInstall = job;
    return job;
  }

  private async installInner(request: InstallRequest, context: OperationContext, progress: OperationProgress): Promise<OperationResult> {
    const { signal, operationId } = context;
    const { paths } = this.deps;
    if (request.moduleId !== REDIS_MODULE_ID || request.version !== REDIS_VERSION) {
      throw new OperationFailure('NOT_IMPLEMENTED', 'redis.moduleUnsupported', false);
    }
    const target = redisTarget(request.platform, request.architecture);
    if (target === undefined) {
      if (request.platform === 'win32') throw new OperationFailure('NOT_IMPLEMENTED', 'redis.windowsUnsupported', false);
      throw new OperationFailure('NOT_IMPLEMENTED', 'redis.platformUnsupported', false);
    }
    if (request.platform !== this.platform || request.architecture !== this.architecture) {
      throw new OperationFailure('INVALID_REQUEST', 'redis.platformMismatch', false);
    }
    const asset = REDIS_ASSETS[target];
    if (!asset.supported) {
      if (normalizedPlatform(this.platform) === 'win32') throw new OperationFailure('NOT_IMPLEMENTED', 'redis.windowsUnsupported', false);
      throw new OperationFailure('NOT_IMPLEMENTED', 'redis.platformUnsupported', false);
    }

    await mkdir(paths.home, { recursive: true });
    progress.emit('redis.preflight', 0.02);
    throwIfAborted(signal);

    const id = installationId(target, REDIS_VERSION);
    const existing = await this.validRecord(id);
    if (existing !== undefined) {
      try {
        await validateRedisInstallation(existing.serverPath, existing.cliPath, paths.home, this.limits.versionTimeoutMs);
        return completed(operationId, id);
      } catch {
        this.deps.logger?.info('redis.reinstall', { reason: 'existing binary failed version validation' });
      }
    }

    await mkdir(paths.conf, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await mkdir(paths.data, { recursive: true });
    await mkdir(paths.staging, { recursive: true });

    const preflight = this.deps.preflight ?? checkBuildDependencies;
    const report = await preflight({ scratchBase: paths.staging, env: this.buildProbeEnvironment(), signal, ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}) });
    throwIfAborted(signal);
    assertBuildDependencies(report);

    const warnings: OperationResult['warnings'] = [];
    const archivePath = join(paths.downloads, asset.asset);
    await mkdir(paths.downloads, { recursive: true });
    // A cached archive is still a managed path: never build from a symlink.
    if ((await lstat(archivePath).catch(() => undefined))?.isSymbolicLink() === true) {
      throw new OperationFailure('IO_ERROR', 'redis.unsafeEntry', false, 'link');
    }
    const cached = await fileDigest(archivePath);
    if (cached === asset.sha256) {
      progress.emit('redis.download.cached', 0.45);
    } else {
      progress.emit('redis.download', 0.05);
      const download = this.deps.download ?? downloadVerified;
      await download({
        url: asset.source,
        destination: archivePath,
        expectedDigest: asset.sha256,
        limits: this.limits,
        signal,
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}),
        onProgress: (received, total) => {
          progress.emit('redis.download', total !== undefined && total > 0 ? 0.05 + 0.4 * Math.min(1, received / total) : 0.25);
        }
      });
    }
    throwIfAborted(signal);

    progress.emit('redis.extract', 0.55);
    const stagingRoot = join(paths.staging, `${safe(operationId)}-${Date.now().toString(36)}`);
    await rm(stagingRoot, { recursive: true, force: true });
    const finalDir = join(paths.installations, id);
    try {
      const build = this.deps.build ?? buildRedisFromSource;
      const built = await build({
        archivePath,
        topLevelDir: asset.topLevelDir,
        stagingRoot,
        finalDir,
        paths,
        limits: this.limits,
        signal,
        onProgress: (stage, fraction) => progress.emit(stage, fraction),
        ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {})
      });
      throwIfAborted(signal);

      progress.emit('redis.commit', 0.95);
      const record = await this.promote({ id, target, asset, built, finalDir, archivePath, signal });
      return completed(operationId, record.id, warnings);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async uninstall(installationIdValue: string, operationId: string, context: OperationContext): Promise<OperationResult> {
    const progress = new OperationProgress(context);
    try {
      const records = await this.readRecords();
      const record = records.find(candidate => candidate.id === installationIdValue);
      if (record === undefined) throw new OperationFailure('UNAVAILABLE', 'redis.notInstalled', false);
      if (
        !isInside(this.deps.paths.installations, record.directory) ||
        !isInside(record.directory, record.serverPath) ||
        !isInside(record.directory, record.cliPath)
      ) {
        throw new OperationFailure('FORBIDDEN', 'redis.uninstallOutsideManagedRoot', false);
      }
      progress.emit('redis.uninstall', 0.2);
      await rm(record.directory, { recursive: true, force: true });
      if (await pathExists(record.directory)) throw new OperationFailure('IO_ERROR', 'redis.uninstallFailed', true);
      const warnings: OperationResult['warnings'] = [];
      try {
        await this.writeRecords(records.filter(candidate => candidate.id !== installationIdValue));
      } catch {
        // Files are already gone; a stale record is recoverable by install/uninstall idempotency.
        warnings.push({ code: 'UNAVAILABLE', messageKey: 'redis.recordCleanupFailed', retryable: true });
      }
      const result = completed(operationId, installationIdValue, warnings);
      progress.terminal(result);
      return result;
    } catch (error) {
      const failure = toFailure(error, context.signal);
      const result = failureResult(operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, installationIdValue);
      progress.terminal(result);
      return result;
    }
  }

  private buildProbeEnvironment(): NodeJS.ProcessEnv {
    return {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: this.deps.paths.home,
      TMPDIR: this.deps.paths.staging,
      LANG: 'C',
      LC_ALL: 'C',
      ...(process.env['CC'] !== undefined ? { CC: process.env['CC'] } : {})
    };
  }

  /** Rename the validated staging prefix into place, then persist the record. */
  private async promote(input: {
    id: string;
    target: RedisTarget;
    asset: RedisAsset;
    built: RedisBuildResult;
    finalDir: string;
    archivePath: string;
    signal: AbortSignal;
  }): Promise<RedisInstallationRecord> {
    await mkdir(this.deps.paths.installations, { recursive: true });
    const backup = `${input.finalDir}.previous-${Date.now().toString(36)}`;
    const hadPrevious = await pathExists(input.finalDir);
    if (hadPrevious) await rename(input.finalDir, backup);
    try {
      await rename(input.built.stagedPrefix, input.finalDir);
      const serverPath = join(input.finalDir, 'bin', 'redis-server');
      const cliPath = join(input.finalDir, 'bin', 'redis-cli');
      if (!(await pathExists(serverPath)) || !(await pathExists(cliPath))) {
        throw new OperationFailure('IO_ERROR', 'redis.binaryMissing', false, 'bin/redis-server');
      }
      await chmod(serverPath, 0o755);
      await chmod(cliPath, 0o755);
      throwIfAborted(input.signal);

      const versions = await validateRedisInstallation(serverPath, cliPath, this.deps.paths.home, this.limits.versionTimeoutMs);
      const record: RedisInstallationRecord = RedisInstallationRecordSchema.parse({
        id: input.id,
        moduleId: REDIS_MODULE_ID,
        version: REDIS_VERSION,
        target: input.target,
        directory: input.finalDir,
        serverPath,
        cliPath,
        archivePath: input.archivePath,
        source: input.asset.source,
        sha256: input.asset.sha256,
        installedAt: new Date().toISOString(),
        versionOutput: versions.versionOutput,
        cliVersionOutput: versions.cliVersionOutput
      });
      const records = await this.readRecords();
      await this.writeRecords([...records.filter(candidate => candidate.id !== input.id), record]);
      if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      return record;
    } catch (error) {
      await rm(input.finalDir, { recursive: true, force: true }).catch(() => undefined);
      if (hadPrevious) await rename(backup, input.finalDir).catch(() => undefined);
      if (error instanceof OperationFailure) throw error;
      throw new OperationFailure('IO_ERROR', 'redis.commitFailed', true, error instanceof Error ? error.message : undefined);
    }
  }

  private async readRecords(): Promise<RedisInstallationRecord[]> {
    const record = await this.deps.storage.StorageGetAsync(REDIS_MODULE_ID, REDIS_STORAGE_KEYS.installations, RedisInstallationsRecordSchema);
    return record?.installations ?? [];
  }

  private async writeRecords(installations: RedisInstallationRecord[]): Promise<void> {
    await this.deps.storage.StorageSetAsync(REDIS_MODULE_ID, REDIS_STORAGE_KEYS.installations, { installations }, RedisInstallationsRecordSchema);
  }

  private async validRecord(id: string): Promise<RedisInstallationRecord | undefined> {
    const records = await this.readRecords();
    const record = records.find(candidate => candidate.id === id);
    if (record === undefined) return undefined;
    return (await this.recordIsValid(record)) ? record : undefined;
  }

  private async recordIsValid(record: RedisInstallationRecord): Promise<boolean> {
    if (!isInside(this.deps.paths.installations, record.directory)) return false;
    if (!isInside(record.directory, record.serverPath)) return false;
    if (!isInside(record.directory, record.cliPath)) return false;
    return (await pathExists(record.serverPath)) && (await pathExists(record.cliPath));
  }
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

export const REDIS_SOURCE_PROVENANCE = Object.freeze({
  source: REDIS_SOURCE_URL,
  ...REDIS_PROVENANCE
});

/** Kept for tests that assert the archive pin without performing a network request. */
export async function digestOfFile(path: string): Promise<string | undefined> {
  return fileDigest(path);
}
