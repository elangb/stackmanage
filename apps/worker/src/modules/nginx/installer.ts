/**
 * Nginx installer.
 *
 * Linux installations are compiled from the pinned official source into a
 * per-user prefix. The build is staged, validated with `nginx -v` and
 * `nginx -t`, and promoted with a rollback path. Uninstall removes only a
 * recorded installation whose paths still resolve inside the managed root.
 */
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InstallRequest,
  ModuleStorage,
  NginxInstallationView,
  NginxListView,
  NginxVersionsView,
  OperationContext,
  OperationResult
} from '@stackmanage/core';
import { NginxInstallationViewSchema, NginxListViewSchema, NginxVersionsViewSchema, OperationResultSchema } from '@stackmanage/core';
import { failureResult, OperationFailure, OperationProgress, throwIfAborted } from '../../shared/operation';
import { atomicWriteFile, isInside, pathExists } from '../../shared/files';
import { defaultIndexHtml, renderNginxConfig } from './config';
import { downloadVerified, fileDigest } from './download';
import {
  DEFAULT_HOSTNAME,
  DEFAULT_NGINX_LIMITS,
  DEFAULT_SITE_PORT,
  NGINX_ASSETS,
  NGINX_MODULE_ID,
  NGINX_PROVENANCE,
  NGINX_SOURCE_URL,
  NGINX_VERSION,
  installationId,
  nginxArchitecture,
  nginxBinaryRelativePath,
  nginxPlatform,
  nginxTarget,
  type NginxAsset,
  type NginxLimits,
  type NginxTarget
} from './manifest';
import { assertBuildDependencies, checkBuildDependencies, type BuildDependencyReport } from './preflight';
import { buildNginxFromSource, type NginxBuildResult } from './build';
import { validateNginxConfig, validateNginxVersion } from './run';
import { verifyNginxSignature } from './signature';
import { NGINX_STORAGE_KEYS, NginxInstallationRecordSchema, NginxInstallationsRecordSchema, type NginxInstallationRecord } from './state';
import type { NginxPaths } from './paths';

export type NginxBuildFn = (input: Parameters<typeof buildNginxFromSource>[0]) => Promise<NginxBuildResult>;
export type NginxPreflightFn = (input: Parameters<typeof checkBuildDependencies>[0]) => Promise<BuildDependencyReport>;

export interface NginxInstallerDeps {
  storage: ModuleStorage;
  paths: NginxPaths;
  limits?: NginxLimits;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  /** Test seams; production always uses the real preflight and source build. */
  preflight?: NginxPreflightFn;
  build?: NginxBuildFn;
  verifySignatures?: boolean;
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

function warning(messageKey: string, retryable = true): OperationResult['warnings'][number] {
  return { code: 'UNAVAILABLE', messageKey, retryable };
}

function toFailure(error: unknown, signal?: AbortSignal): OperationFailure {
  if (signal?.aborted === true) return new OperationFailure('CANCELLED', 'cancelled', false);
  if (error instanceof OperationFailure) return error;
  if (error instanceof Error && error.name === 'OperationAbortedError') return new OperationFailure('CANCELLED', 'cancelled', false);
  return new OperationFailure('UNKNOWN', 'nginx.unknown', false);
}

export class NginxInstaller {
  private readonly limits: NginxLimits;
  private readonly platform: string;
  private readonly architecture: string;
  private activeInstall: Promise<OperationResult> | undefined;

  constructor(private readonly deps: NginxInstallerDeps) {
    this.limits = deps.limits ?? DEFAULT_NGINX_LIMITS;
    this.platform = deps.platform ?? process.platform;
    this.architecture = deps.architecture ?? process.arch;
  }

  versionsView(moduleId: string): NginxVersionsView {
    if (moduleId !== NGINX_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'nginx.moduleUnsupported', false);
    const current = nginxTarget(this.platform, this.architecture);
    const versions = (Object.keys(NGINX_ASSETS) as NginxTarget[]).map(target => {
      const asset = NGINX_ASSETS[target];
      return {
        moduleId: 'nginx' as const,
        version: NGINX_VERSION,
        platform: nginxPlatform(target),
        architecture: nginxArchitecture(target),
        source: asset.source,
        sha256: asset.sha256,
        archive: asset.archive,
        kind: asset.kind,
        tested: asset.tested,
        supported: asset.supported
      };
    });
    return NginxVersionsViewSchema.parse({
      moduleId: NGINX_MODULE_ID,
      pinnedVersion: NGINX_VERSION,
      platform: normalizedPlatform(this.platform),
      architecture: normalizedArchitecture(this.architecture),
      supported: current !== undefined && NGINX_ASSETS[current].supported,
      tested: current !== undefined && NGINX_ASSETS[current].tested,
      versions
    });
  }

  async installed(): Promise<NginxInstallationRecord | undefined> {
    const records = await this.readRecords();
    for (const record of records) {
      if (!(await this.recordIsValid(record))) continue;
      return record;
    }
    return undefined;
  }

  async list(moduleId: string): Promise<NginxListView> {
    if (moduleId !== NGINX_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'nginx.moduleUnsupported', false);
    const records = await this.readRecords();
    const installations: NginxInstallationView[] = [];
    for (const record of records) {
      if (await this.recordIsValid(record)) installations.push(this.view(record));
    }
    return NginxListViewSchema.parse({ moduleId: NGINX_MODULE_ID, installations });
  }

  view(record: NginxInstallationRecord): NginxInstallationView {
    return NginxInstallationViewSchema.parse({
      id: record.id,
      moduleId: NGINX_MODULE_ID,
      version: record.version,
      platform: nginxPlatform(record.target),
      architecture: nginxArchitecture(record.target),
      directory: record.directory,
      binaryPath: record.binaryPath,
      versionOutput: record.versionOutput,
      installedAt: record.installedAt,
      source: record.source,
      sha256: record.sha256
    });
  }

  install(request: InstallRequest, context: OperationContext): Promise<OperationResult> {
    if (this.activeInstall !== undefined) {
      return Promise.resolve(failureResult(context.operationId, { code: 'CONFLICT', messageKey: 'nginx.installBusy', retryable: true }, `install-${NGINX_MODULE_ID}`));
    }
    const progress = new OperationProgress(context);
    const job = this.installInner(request, context, progress)
      .catch(error => {
        const failure = toFailure(error, context.signal);
        this.deps.logger?.info('nginx.installFailed', {
          code: failure.code,
          messageKey: failure.messageKey,
          ...(failure.detail !== undefined ? { detail: failure.detail } : {}),
          ...(error instanceof Error && failure.detail === undefined ? { error: error.message } : {})
        });
        return failureResult(context.operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, `install-${NGINX_MODULE_ID}`);
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
    if (request.moduleId !== NGINX_MODULE_ID || request.version !== NGINX_VERSION) {
      throw new OperationFailure('NOT_IMPLEMENTED', 'nginx.moduleUnsupported', false);
    }
    const target = nginxTarget(request.platform, request.architecture);
    if (target === undefined) throw new OperationFailure('NOT_IMPLEMENTED', 'nginx.platformUnsupported', false);
    if (request.platform !== this.platform || request.architecture !== this.architecture) {
      throw new OperationFailure('INVALID_REQUEST', 'nginx.platformMismatch', false);
    }
    const asset = NGINX_ASSETS[target];
    if (!asset.supported) throw new OperationFailure('NOT_IMPLEMENTED', 'nginx.windowsUnsupported', false);
    if (nginxPlatform(target) !== 'linux') throw new OperationFailure('NOT_IMPLEMENTED', 'nginx.platformUnsupported', false);

    await mkdir(paths.home, { recursive: true });
    progress.emit('nginx.preflight', 0.02);
    throwIfAborted(signal);
    const id = installationId(target, NGINX_VERSION);
    const existing = await this.validRecord(id);
    if (existing !== undefined) {
      try {
        await validateNginxVersion(existing.binaryPath, paths.home, NGINX_VERSION, this.limits.versionTimeoutMs);
        return completed(operationId, id);
      } catch {
        this.deps.logger?.info('nginx.reinstall', { reason: 'existing binary failed version validation' });
      }
    }

    await mkdir(paths.conf, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await mkdir(paths.tmp, { recursive: true });

    const preflight = this.deps.preflight ?? checkBuildDependencies;
    const report = await preflight({ scratchBase: paths.staging, env: this.buildProbeEnvironment(), signal, ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}) });
    throwIfAborted(signal);
    assertBuildDependencies(report);

    const warnings: OperationResult['warnings'] = [];
    const archivePath = join(paths.downloads, asset.asset);
    await mkdir(paths.downloads, { recursive: true });
    const cached = await fileDigest(archivePath);
    if (cached === asset.sha256) {
      progress.emit('nginx.download.cached', 0.45);
    } else {
      progress.emit('nginx.download', 0.05);
      await downloadVerified({
        url: asset.source,
        destination: archivePath,
        expectedDigest: asset.sha256,
        limits: this.limits,
        signal,
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}),
        onProgress: (received, total) => {
          progress.emit('nginx.download', total !== undefined && total > 0 ? 0.05 + 0.4 * Math.min(1, received / total) : 0.25);
        }
      });
    }
    throwIfAborted(signal);

    if (this.deps.verifySignatures !== false) {
      const signature = await verifyNginxSignature({
        archivePath,
        signatureUrl: `${asset.source}.asc`,
        stagingBase: paths.staging,
        limits: this.limits,
        signal,
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {})
      });
      if (signature.status === 'verified') {
        this.deps.logger?.info('nginx.signatureVerified', { fingerprint: signature.fingerprint });
      } else {
        this.deps.logger?.info('nginx.signatureUnavailable', { reason: signature.reason });
        warnings.push(warning('nginx.signatureUnavailable'));
      }
    }

    progress.emit('nginx.extract', 0.55);
    const stagingRoot = join(paths.staging, `${safe(operationId)}-${Date.now().toString(36)}`);
    await rm(stagingRoot, { recursive: true, force: true });
    const finalDir = join(paths.installations, id);
    try {
      const build = this.deps.build ?? buildNginxFromSource;
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

      progress.emit('nginx.commit', 0.95);
      const record = await this.promote({
        id,
        target,
        asset,
        stagedPrefix: built.stagedPrefix,
        finalDir,
        archivePath,
        signal
      });
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
      if (record === undefined) throw new OperationFailure('UNAVAILABLE', 'nginx.notInstalled', false);
      if (!isInside(this.deps.paths.installations, record.directory) || !isInside(record.directory, record.binaryPath)) {
        throw new OperationFailure('FORBIDDEN', 'nginx.uninstallOutsideManagedRoot', false);
      }
      progress.emit('nginx.uninstall', 0.2);
      await rm(record.directory, { recursive: true, force: true });
      if (await pathExists(record.directory)) throw new OperationFailure('IO_ERROR', 'nginx.uninstallFailed', true);
      const warnings: OperationResult['warnings'] = [];
      try {
        await this.writeRecords(records.filter(candidate => candidate.id !== installationIdValue));
      } catch {
        // Files are already gone; a stale record is recoverable by reinstall/uninstall idempotency.
        warnings.push(warning('nginx.recordCleanupFailed'));
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

  /** Write the final private config and default site, validate, then persist the record. */
  private async promote(input: {
    id: string;
    target: NginxTarget;
    asset: NginxAsset;
    stagedPrefix: string;
    finalDir: string;
    archivePath: string;
    signal: AbortSignal;
  }): Promise<NginxInstallationRecord> {
    const { paths } = this.deps;
    const finalBinary = join(input.finalDir, ...nginxBinaryRelativePath(input.target).split('/'));
    await mkdir(paths.conf, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await mkdir(paths.tmp, { recursive: true });
    await mkdir(join(paths.tmp, 'client_body'), { recursive: true });
    await mkdir(join(paths.tmp, 'proxy'), { recursive: true });
    await mkdir(join(paths.tmp, 'fastcgi'), { recursive: true });
    await mkdir(join(paths.tmp, 'uwsgi'), { recursive: true });
    await mkdir(join(paths.tmp, 'scgi'), { recursive: true });
    await mkdir(paths.defaultSite, { recursive: true });
    const indexPath = join(paths.defaultSite, 'index.html');
    if (!(await pathExists(indexPath))) await atomicWriteFile(indexPath, defaultIndexHtml());

    const configPath = join(paths.conf, 'nginx.conf');
    let rendered: string;
    try {
      rendered = renderNginxConfig({
        installDir: input.finalDir,
        pidPath: join(paths.logs, 'nginx.pid'),
        errorLogPath: join(paths.logs, 'error.log'),
        accessLogPath: join(paths.logs, 'access.log'),
        tempDir: paths.tmp,
        root: paths.defaultSite,
        port: DEFAULT_SITE_PORT,
        hostname: DEFAULT_HOSTNAME
      });
    } catch {
      throw new OperationFailure('INVALID_REQUEST', 'nginx.unsafePath', false);
    }
    await atomicWriteFile(configPath, rendered);

    await mkdir(paths.installations, { recursive: true });
    const backup = `${input.finalDir}.previous-${Date.now().toString(36)}`;
    const hadPrevious = await pathExists(input.finalDir);
    if (hadPrevious) await rename(input.finalDir, backup);
    try {
      await rename(input.stagedPrefix, input.finalDir);
      if (!(await pathExists(finalBinary))) throw new OperationFailure('IO_ERROR', 'nginx.binaryMissing', false, 'sbin/nginx');
      await chmod(finalBinary, 0o755);
      throwIfAborted(input.signal);

      const versionOutput = await validateNginxVersion(finalBinary, paths.home, NGINX_VERSION, this.limits.versionTimeoutMs);
      await validateNginxConfig(finalBinary, configPath, input.finalDir, paths.home, this.limits.configTimeoutMs);

      const record: NginxInstallationRecord = NginxInstallationRecordSchema.parse({
        id: input.id,
        moduleId: NGINX_MODULE_ID,
        version: NGINX_VERSION,
        target: input.target,
        directory: input.finalDir,
        binaryPath: finalBinary,
        archivePath: input.archivePath,
        source: input.asset.source,
        sha256: input.asset.sha256,
        installedAt: new Date().toISOString(),
        versionOutput
      });
      const records = await this.readRecords();
      await this.writeRecords([...records.filter(candidate => candidate.id !== input.id), record]);
      if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      return record;
    } catch (error) {
      await rm(input.finalDir, { recursive: true, force: true }).catch(() => undefined);
      if (hadPrevious) await rename(backup, input.finalDir).catch(() => undefined);
      if (error instanceof OperationFailure) throw error;
      throw new OperationFailure('IO_ERROR', 'nginx.commitFailed', true, error instanceof Error ? error.message : undefined);
    }
  }

  private async readRecords(): Promise<NginxInstallationRecord[]> {
    const record = await this.deps.storage.StorageGetAsync(NGINX_MODULE_ID, NGINX_STORAGE_KEYS.installations, NginxInstallationsRecordSchema);
    return record?.installations ?? [];
  }

  private async writeRecords(installations: NginxInstallationRecord[]): Promise<void> {
    await this.deps.storage.StorageSetAsync(NGINX_MODULE_ID, NGINX_STORAGE_KEYS.installations, { installations }, NginxInstallationsRecordSchema);
  }

  private async validRecord(id: string): Promise<NginxInstallationRecord | undefined> {
    const records = await this.readRecords();
    const record = records.find(candidate => candidate.id === id);
    if (record === undefined) return undefined;
    return (await this.recordIsValid(record)) ? record : undefined;
  }

  private async recordIsValid(record: NginxInstallationRecord): Promise<boolean> {
    if (!isInside(this.deps.paths.installations, record.directory)) return false;
    if (!isInside(record.directory, record.binaryPath)) return false;
    return pathExists(record.binaryPath);
  }
}

function safe(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

export const NGINX_SOURCE_PROVENANCE = Object.freeze({
  source: NGINX_SOURCE_URL,
  ...NGINX_PROVENANCE
});

/** Kept for tests that assert the archive pin without performing a network request. */
export async function digestOfFile(path: string): Promise<string | undefined> {
  return fileDigest(path);
}
