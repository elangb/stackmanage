/**
 * Node.js runtime installer.
 *
 * No service process is started. The module only receipts the pinned official
 * archive, extracts the preserved top-level directory, runs the staged
 * `bin/node --version`, and commits it atomically. Uninstall removes only a
 * recorded installation whose paths still resolve inside the managed root.
 */
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstallRequest, ModuleStorage, OperationContext, OperationResult, RuntimeInstallationView, RuntimeListView, RuntimeStatusView, RuntimeVersionsView, VersionRecord } from '@stackmanage/core';
import { OperationResultSchema, RuntimeInstallationViewSchema, RuntimeListViewSchema, RuntimeStatusViewSchema, RuntimeVersionsViewSchema, VersionRecordSchema } from '@stackmanage/core';
import { OperationFailure, OperationProgress, failureResult, throwIfAborted } from '../../shared/operation';
import { downloadText, downloadVerified, fileDigest } from './download';
import { extractNodeArchive } from './extract';
import {
  DEFAULT_NODE_LIMITS,
  NODE_ASSETS,
  NODE_MODULE_ID,
  NODE_RELEASE_BASE_URL,
  NODE_SHASUMS_URL,
  NODE_VERSION,
  nodeArchitecture,
  nodePathPrepend,
  nodePlatform,
  nodeTarget,
  nodeTargetTested,
  type NodeAsset,
  type NodeLimits,
  type NodeTarget
} from './manifest';
import { isInside, pathExists, type NodePaths } from './paths';
import { NodeInstallationsRecordSchema, NODE_STORAGE_KEYS, type NodeInstallationRecord } from './state';
import { validateNodeVersion } from './run';

export interface NodeRelease {
  readonly version: typeof NODE_VERSION;
  readonly baseUrl: string;
  readonly shasumsUrl: string;
  readonly assets: Readonly<Record<NodeTarget, NodeAsset>>;
}

export const NODE_RELEASE: NodeRelease = Object.freeze({
  version: NODE_VERSION,
  baseUrl: NODE_RELEASE_BASE_URL,
  shasumsUrl: NODE_SHASUMS_URL,
  assets: NODE_ASSETS
});

export interface NodeInstallerDeps {
  storage: ModuleStorage;
  paths: NodePaths;
  limits?: NodeLimits;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  release?: NodeRelease;
  /** Unit tests can avoid the supplementary checksum-list request. */
  verifyChecksumList?: boolean;
  /** Unit tests can probe a fake binary without changing the pinned version. */
  probeVersion?: (binary: string, home: string, timeoutMs: number, expectedVersion: string) => Promise<string>;
}

function normalizedPlatform(value: string): 'win32' | 'linux' | 'darwin' {
  if (value === 'win32' || value === 'windows') return 'win32';
  if (value === 'darwin') return 'darwin';
  return 'linux';
}

function normalizedArchitecture(value: string): 'x64' | 'arm64' {
  return value === 'arm64' ? 'arm64' : 'x64';
}

function installationId(target: NodeTarget, version: string): string {
  return `node-${version}-${target}`;
}

function archivePathFor(paths: NodePaths, asset: NodeAsset): string {
  return join(paths.downloads, asset.asset);
}

function completed(operationId: string, itemId: string, warnings: OperationResult['warnings'] = []): OperationResult {
  return OperationResultSchema.parse({
    operationId,
    status: 'completed',
    items: [{ id: itemId, status: 'completed' }],
    warnings
  });
}

function warning(messageKey: string, retryable = true): OperationResult['warnings'][number] {
  return { code: 'IO_ERROR', messageKey, retryable };
}

export class NodeInstaller {
  private readonly limits: NodeLimits;
  private readonly platform: string;
  private readonly architecture: string;
  private readonly release: NodeRelease;
  private activeInstall: Promise<OperationResult> | undefined;

  constructor(private readonly deps: NodeInstallerDeps) {
    this.limits = deps.limits ?? DEFAULT_NODE_LIMITS;
    this.platform = deps.platform ?? process.platform;
    this.architecture = deps.architecture ?? process.arch;
    this.release = deps.release ?? NODE_RELEASE;
  }

  availableVersion(): VersionRecord | undefined {
    const target = nodeTarget(this.platform, this.architecture);
    if (target === undefined) return undefined;
    const asset = this.release.assets[target];
    return VersionRecordSchema.parse({
      moduleId: NODE_MODULE_ID,
      version: this.release.version,
      platform: nodePlatform(target),
      architecture: nodeArchitecture(target),
      source: `${this.release.baseUrl}${asset.asset}`,
      sha256: asset.sha256
    });
  }

  versionsView(moduleId: string): RuntimeVersionsView {
    if (moduleId !== NODE_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'runtime.moduleUnsupported', false);
    const current = nodeTarget(this.platform, this.architecture);
    const versions = (Object.keys(this.release.assets) as NodeTarget[]).map(target => {
      const asset = this.release.assets[target];
      return {
        moduleId: NODE_MODULE_ID,
        version: this.release.version,
        platform: nodePlatform(target),
        architecture: nodeArchitecture(target),
        source: `${this.release.baseUrl}${asset.asset}`,
        sha256: asset.sha256,
        archive: asset.archive,
        tested: nodeTargetTested(target)
      };
    });
    return RuntimeVersionsViewSchema.parse({
      moduleId: NODE_MODULE_ID,
      pinnedVersion: this.release.version,
      platform: normalizedPlatform(this.platform),
      architecture: normalizedArchitecture(this.architecture),
      supported: current !== undefined,
      tested: current !== undefined && nodeTargetTested(current),
      versions
    });
  }

  async status(moduleId: string): Promise<RuntimeStatusView> {
    if (moduleId !== NODE_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'runtime.moduleUnsupported', false);
    const target = nodeTarget(this.platform, this.architecture);
    const record = target !== undefined ? await this.validRecord(installationId(target, this.release.version)) : undefined;
    const installation = record !== undefined ? this.view(record) : undefined;
    return RuntimeStatusViewSchema.parse({
      moduleId: NODE_MODULE_ID,
      pinnedVersion: this.release.version,
      platform: normalizedPlatform(this.platform),
      architecture: normalizedArchitecture(this.architecture),
      supported: target !== undefined,
      tested: target !== undefined && nodeTargetTested(target),
      installed: installation !== undefined,
      ...(installation !== undefined ? { installation } : {}),
      pathPrepend: installation?.pathPrepend ?? []
    });
  }

  async list(moduleId: string): Promise<RuntimeListView> {
    if (moduleId !== NODE_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'runtime.moduleUnsupported', false);
    const records = await this.readRecords();
    const installations: RuntimeInstallationView[] = [];
    for (const record of records) {
      if (await this.recordIsValid(record)) installations.push(this.view(record));
    }
    return RuntimeListViewSchema.parse({ moduleId: NODE_MODULE_ID, installations });
  }

  async install(request: InstallRequest, context: OperationContext): Promise<OperationResult> {
    const progress = new OperationProgress(context);
    if (this.activeInstall !== undefined) {
      return failureResult(context.operationId, { code: 'CONFLICT', messageKey: 'runtime.installBusy', retryable: true }, `install-${NODE_MODULE_ID}`);
    }
    const job = this.installWithProgress(request, context, progress);
    this.activeInstall = job;
    try {
      const result = await job;
      progress.terminal(result);
      return result;
    } finally {
      if (this.activeInstall === job) this.activeInstall = undefined;
    }
  }

  private async installWithProgress(request: InstallRequest, context: OperationContext, progress: OperationProgress): Promise<OperationResult> {
    try {
      return await this.installInner(request, context, progress);
    } catch (error) {
      const failure = toFailure(error, context.signal);
      this.deps.logger?.info('runtime.installFailed', {
        code: failure.code,
        messageKey: failure.messageKey,
        ...(failure.detail !== undefined ? { detail: failure.detail } : {})
      });
      return failureResult(
        context.operationId,
        { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable },
        `install-${NODE_MODULE_ID}`
      );
    }
  }

  private async installInner(request: InstallRequest, context: OperationContext, progress: OperationProgress): Promise<OperationResult> {
    const { signal, operationId } = context;
    const { paths } = this.deps;
    if (request.moduleId !== NODE_MODULE_ID || request.version !== this.release.version) {
      throw new OperationFailure('NOT_IMPLEMENTED', 'runtime.moduleUnsupported', false);
    }
    const target = nodeTarget(request.platform, request.architecture);
    if (target === undefined) throw new OperationFailure('NOT_IMPLEMENTED', 'runtime.platformUnsupported', false);
    if (request.platform !== this.platform || request.architecture !== this.architecture) {
      throw new OperationFailure('INVALID_REQUEST', 'runtime.platformMismatch', false);
    }
    const asset = this.release.assets[target];
    const id = installationId(target, this.release.version);
    await mkdir(paths.home, { recursive: true });

    progress.emit('runtime.preflight', 0.02);
    throwIfAborted(signal);
    const existing = await this.validRecord(id);
    if (existing !== undefined) {
      try {
        await this.probe(existing.binaryPath, paths.home);
        return completed(operationId, id);
      } catch {
        this.deps.logger?.info('runtime.reinstall', { reason: 'existing binary failed version validation' });
      }
    }

    const warnings: OperationResult['warnings'] = [];
    if (this.deps.verifyChecksumList !== false) {
      await this.verifyChecksumList(asset, signal, warnings);
    }

    const downloadPath = archivePathFor(paths, asset);
    await mkdir(paths.downloads, { recursive: true });
    const cachedDigest = await fileDigest(downloadPath);
    if (cachedDigest === asset.sha256) {
      progress.emit('runtime.download.cached', 0.55);
    } else {
      progress.emit('runtime.download', 0.05);
      await downloadVerified({
        url: `${this.release.baseUrl}${asset.asset}`,
        destination: downloadPath,
        expectedDigest: asset.sha256,
        limits: this.limits,
        signal,
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}),
        onProgress: (received, total) => {
          progress.emit('runtime.download', total !== undefined && total > 0 ? 0.05 + 0.55 * Math.min(1, received / total) : 0.3);
        }
      });
    }
    throwIfAborted(signal);

    progress.emit('runtime.extract', 0.65);
    const staging = join(paths.staging, `${safeSegment(operationId)}-${Date.now().toString(36)}`);
    await rm(staging, { recursive: true, force: true });
    try {
      const extracted = await extractNodeArchive({
        archivePath: downloadPath,
        kind: asset.archive,
        stagingDir: staging,
        topLevelDir: asset.topLevelDir,
        binaryRelativePath: asset.binaryRelativePath,
        limits: this.limits
      });
      if (extracted.skippedLinks > 0) this.deps.logger?.info('runtime.linksSkipped', { count: extracted.skippedLinks });
      await chmod(extracted.binaryPath, 0o755);
      progress.emit('runtime.validate', 0.8);
      const versionOutput = await this.probe(extracted.binaryPath, staging);
      throwIfAborted(signal);

      progress.emit('runtime.commit', 0.92);
      const finalDir = join(paths.installations, asset.topLevelDir);
      const record: NodeInstallationRecord = {
        id,
        moduleId: NODE_MODULE_ID,
        version: this.release.version,
        target,
        directory: finalDir,
        binaryPath: join(finalDir, ...asset.binaryRelativePath.split('/')),
        archivePath: downloadPath,
        installedAt: new Date().toISOString(),
        versionOutput,
        sha256: asset.sha256
      };
      await this.commit(record, extracted.topLevelPath, finalDir);
      return completed(operationId, id, warnings);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async uninstall(installationId: string, operationId: string, context: OperationContext): Promise<OperationResult> {
    const progress = new OperationProgress(context);
    try {
      const records = await this.readRecords();
      const record = records.find(candidate => candidate.id === installationId);
      if (record === undefined) throw new OperationFailure('UNAVAILABLE', 'runtime.notInstalled', false);
      if (!isInside(this.deps.paths.installations, record.directory) || !isInside(record.directory, record.binaryPath)) {
        throw new OperationFailure('FORBIDDEN', 'runtime.uninstallOutsideManagedRoot', false);
      }
      progress.emit('runtime.uninstall', 0.2);
      await rm(record.directory, { recursive: true, force: true });
      if (await pathExists(record.directory)) throw new OperationFailure('IO_ERROR', 'runtime.uninstallFailed', true);
      const warnings: OperationResult['warnings'] = [];
      try {
        await this.writeRecords(records.filter(candidate => candidate.id !== installationId));
      } catch {
        // Files are already gone; a stale record is recoverable by reinstall/uninstall idempotency.
        warnings.push(warning('runtime.recordCleanupFailed'));
      }
      const result = completed(operationId, installationId, warnings);
      progress.terminal(result);
      return result;
    } catch (error) {
      const failure = toFailure(error, context.signal);
      const result = failureResult(context.operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, installationId);
      progress.terminal(result);
      return result;
    }
  }

  private async probe(binary: string, home: string): Promise<string> {
    const probe = this.deps.probeVersion ?? validateNodeVersion;
    return probe(binary, home, this.limits.versionTimeoutMs, this.release.version);
  }

  private async verifyChecksumList(asset: NodeAsset, signal: AbortSignal, warnings: OperationResult['warnings']): Promise<void> {
    try {
      const text = await downloadText({
        url: this.release.shasumsUrl,
        limits: this.limits,
        signal,
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {})
      });
      const entry = parseShasums(text).get(asset.asset);
      if (entry === undefined) {
        warnings.push(warning('runtime.checksumEntryMissing', false));
        return;
      }
      if (entry !== asset.sha256) {
        this.deps.logger?.info('runtime.checksumListMismatch', { asset: asset.asset });
        throw new OperationFailure('IO_ERROR', 'runtime.checksumMismatch', false);
      }
    } catch (error) {
      if (error instanceof OperationFailure && error.messageKey === 'runtime.checksumMismatch') throw error;
      // The archive's pinned digest is still authoritative; the list is supplementary evidence.
      warnings.push(warning('runtime.checksumListUnavailable'));
    }
  }

  private async readRecords(): Promise<NodeInstallationRecord[]> {
    const record = await this.deps.storage.StorageGetAsync(NODE_MODULE_ID, NODE_STORAGE_KEYS.installations, NodeInstallationsRecordSchema);
    return record?.installations ?? [];
  }

  private async writeRecords(installations: NodeInstallationRecord[]): Promise<void> {
    await this.deps.storage.StorageSetAsync(NODE_MODULE_ID, NODE_STORAGE_KEYS.installations, { installations }, NodeInstallationsRecordSchema);
  }

  private async validRecord(id: string): Promise<NodeInstallationRecord | undefined> {
    const records = await this.readRecords();
    const record = records.find(candidate => candidate.id === id);
    if (record === undefined) return undefined;
    return (await this.recordIsValid(record)) ? record : undefined;
  }

  private async recordIsValid(record: NodeInstallationRecord): Promise<boolean> {
    if (!isInside(this.deps.paths.installations, record.directory)) return false;
    if (!isInside(record.directory, record.binaryPath)) return false;
    return pathExists(record.binaryPath);
  }

  private view(record: NodeInstallationRecord): RuntimeInstallationView {
    return RuntimeInstallationViewSchema.parse({
      id: record.id,
      moduleId: record.moduleId,
      version: record.version,
      platform: nodePlatform(record.target),
      architecture: nodeArchitecture(record.target),
      directory: record.directory,
      binaryPath: record.binaryPath,
      versionOutput: record.versionOutput,
      installedAt: record.installedAt,
      pathPrepend: nodePathPrepend(record.directory, record.target)
    });
  }

  private async commit(record: NodeInstallationRecord, stagedTopLevel: string, finalDir: string): Promise<void> {
    const records = await this.readRecords();
    const next = [...records.filter(candidate => candidate.id !== record.id), record];
    await mkdir(this.deps.paths.installations, { recursive: true });
    const backup = `${finalDir}.previous-${Date.now().toString(36)}`;
    const hadPrevious = await pathExists(finalDir);
    if (hadPrevious) await rename(finalDir, backup);
    try {
      await rename(stagedTopLevel, finalDir);
      if (!(await pathExists(record.binaryPath))) throw new OperationFailure('IO_ERROR', 'runtime.commitFailed', true);
      await this.writeRecords(next);
    } catch (error) {
      await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
      if (hadPrevious) await rename(backup, finalDir).catch(() => undefined);
      if (error instanceof OperationFailure) throw error;
      throw new OperationFailure('IO_ERROR', 'runtime.commitFailed', true, error instanceof Error ? error.message : undefined);
    }
    if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

function toFailure(error: unknown, signal?: AbortSignal): OperationFailure {
  if (signal?.aborted === true) return new OperationFailure('CANCELLED', 'cancelled', false);
  if (error instanceof OperationFailure) return error;
  if (error instanceof Error && error.name === 'OperationAbortedError') return new OperationFailure('CANCELLED', 'cancelled', false);
  return new OperationFailure('UNKNOWN', 'runtime.unknown', false);
}

/** Parse the official `SHA256 (line) whitespace filename` format into a map. */
export function parseShasums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) entries.set(match[2], match[1]);
  }
  return entries;
}

