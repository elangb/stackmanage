import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { InstallRequest, Installation, ModuleStorage, OperationContext, OperationResult, VersionRecord } from '@stackmanage/core';
import { OperationResultSchema, VersionRecordSchema } from '@stackmanage/core';
import { downloadVerified, fileDigest } from './download';
import { extractBinary } from './extract';
import {
  CADDY_ASSETS,
  CADDY_MODULE_ID,
  CADDY_RELEASE_BASE_URL,
  CADDY_VERSION,
  DEFAULT_HOSTNAME,
  DEFAULT_INSTANCE_ID,
  DEFAULT_OPERATIONAL_LIMITS,
  DEFAULT_SITE_PORT,
  OperationAbortedError,
  OperationFailure,
  OperationProgress,
  caddyAssetUrl,
  caddyBinaryName,
  caddyTarget,
  failureResult,
  throwIfAborted,
  type OperationalLimits
} from './manifest';
import { CaddyInstallationRecordSchema, CaddySiteRecordSchema, STORAGE_KEYS, type CaddyInstallationRecord } from './state';
import { atomicWriteFile, isInside, pathExists, type Paths } from './paths';
import { binaryPath, executableExists, readLogTail } from './process';

export const INSTALLATION_ID = `caddy-${CADDY_VERSION}`;

/** Minimal child environment: never inherit unrelated secrets from the worker process. */
export function childEnvironment(procToken: string, home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: process.env['TMPDIR'] ?? home,
    STACKMANAGE_PROC_TOKEN: procToken
  };
  if (process.platform === 'win32') {
    base['USERPROFILE'] = home;
    base['TEMP'] = home;
    base['TMP'] = home;
    base['SystemRoot'] = process.env['SystemRoot'] ?? 'C:\\Windows';
  }
  return base;
}

/** Run a Caddy subcommand with an argument array, capture bounded output, honour a deadline. */
export function runCaddy(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    // Without this, a missing binary or cwd would only surface as a timeout.
    child.once('error', () => finish(null));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 8192) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', code => finish(code));
  });
}

const VERSION_PATTERN = /^v2\.11\.8(?:\s|$)/;

export async function validateBinaryVersion(binary: string, home: string): Promise<string> {
  const result = await runCaddy(binary, ['version'], home, 10_000, childEnvironment('validate', home));
  const firstLine = result.stdout.split('\n')[0]?.trim() ?? '';
  if (result.timedOut || result.code !== 0 || !VERSION_PATTERN.test(firstLine)) {
    throw new OperationFailure('IO_ERROR', 'install.versionMismatch', false, `exit=${String(result.code)} timedOut=${result.timedOut}`);
  }
  return firstLine.slice(0, 200);
}

export interface InstallerDeps {
  storage: ModuleStorage;
  paths: Paths;
  limits?: OperationalLimits;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

export class CaddyInstaller {
  private readonly limits: OperationalLimits;
  private readonly platform: string;
  private readonly architecture: string;

  constructor(private readonly deps: InstallerDeps) {
    this.limits = deps.limits ?? DEFAULT_OPERATIONAL_LIMITS;
    this.platform = deps.platform ?? process.platform;
    this.architecture = deps.architecture ?? process.arch;
  }

  availableVersion(): VersionRecord | undefined {
    const target = caddyTarget(this.platform, this.architecture);
    if (target === undefined) return undefined;
    return VersionRecordSchema.parse({
      moduleId: CADDY_MODULE_ID,
      version: CADDY_VERSION,
      platform: this.platform,
      architecture: this.architecture,
      source: `${CADDY_RELEASE_BASE_URL}${CADDY_ASSETS[target].asset}`,
      sha256: CADDY_ASSETS[target].sha256
    });
  }

  async installed(): Promise<CaddyInstallationRecord | undefined> {
    const record = await this.deps.storage.StorageGetAsync(CADDY_MODULE_ID, STORAGE_KEYS.installation, CaddyInstallationRecordSchema);
    if (record === undefined) return undefined;
    if (!isInside(record.installation.directory, record.binaryPath)) return undefined;
    return (await executableExists(record.binaryPath)) ? record : undefined;
  }

  async versionCheck(record: CaddyInstallationRecord): Promise<{ version: string; valid: boolean; output: string }> {
    try {
      const output = await validateBinaryVersion(record.binaryPath, this.deps.paths.home);
      return { version: CADDY_VERSION, valid: true, output };
    } catch (error) {
      const detail = error instanceof OperationFailure ? error.detail : undefined;
      return { version: CADDY_VERSION, valid: false, output: (detail ?? 'invalid').slice(0, 200) };
    }
  }

  async list(): Promise<{ installations: Installation[]; versionCheck?: { version: string; valid: boolean; output: string } }> {
    const record = await this.installed();
    if (record === undefined) return { installations: [] };
    return { installations: [record.installation], versionCheck: await this.versionCheck(record) };
  }

  /** Idempotent: a valid existing install completes immediately without downloading again. */
  async install(request: InstallRequest, context: OperationContext): Promise<OperationResult> {
    const progress = new OperationProgress(context);
    try {
      const result = await this.installInner(request, context, progress);
      progress.terminal(result);
      return result;
    } catch (error) {
      const failure = toFailure(error, context.signal);
      this.deps.logger?.info('install.failed', {
        code: failure.code,
        messageKey: failure.messageKey,
        ...(failure.detail !== undefined ? { detail: failure.detail } : {})
      });
      const result = failureResult(context.operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, `install-${CADDY_VERSION}`);
      progress.terminal(result);
      return result;
    }
  }

  private async installInner(request: InstallRequest, context: OperationContext, progress: OperationProgress): Promise<OperationResult> {
    const { signal, operationId } = context;
    if (request.moduleId !== CADDY_MODULE_ID || request.version !== CADDY_VERSION) {
      throw new OperationFailure('NOT_IMPLEMENTED', 'install.moduleUnsupported', false);
    }
    const target = caddyTarget(request.platform, request.architecture);
    if (target === undefined) throw new OperationFailure('NOT_IMPLEMENTED', 'install.platformUnsupported', false);
    if (request.platform !== this.platform || request.architecture !== this.architecture) {
      // Cross-platform installation cannot be validated by running `caddy version`.
      throw new OperationFailure('INVALID_REQUEST', 'install.platformMismatch', false);
    }
    const asset = CADDY_ASSETS[target];
    const { paths } = this.deps;
    await mkdir(paths.home, { recursive: true });

    progress.emit('install.preflight', 0.02);
    throwIfAborted(signal);
    const existing = await this.installed();
    if (existing !== undefined) {
      try {
        await validateBinaryVersion(existing.binaryPath, paths.home);
        return completed(operationId, `install-${existing.installation.id}`);
      } catch {
        this.deps.logger?.info('install.reinstall', { reason: 'existing binary failed version validation' });
      }
    }

    const downloadPath = join(paths.downloads, asset.asset);
    await mkdir(paths.downloads, { recursive: true });
    const cachedDigest = await fileDigest(downloadPath, 'sha512');
    if (cachedDigest === asset.sha512) {
      progress.emit('install.download.cached', 0.6);
    } else {
      progress.emit('install.download', 0.05);
      await downloadVerified({
        url: caddyAssetUrl(target),
        destination: downloadPath,
        expectedDigest: asset.sha512,
        algorithm: 'sha512',
        limits: this.limits,
        signal,
        ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.logger !== undefined ? { logger: this.deps.logger } : {}),
        onProgress: (received, total) => {
          progress.emit('install.download', total !== undefined && total > 0 ? 0.05 + 0.6 * Math.min(1, received / total) : 0.3);
        }
      });
    }
    throwIfAborted(signal);

    progress.emit('install.extract', 0.68);
    const staging = join(paths.staging, `${safeSegment(operationId)}-${Date.now().toString(36)}`);
    await rm(staging, { recursive: true, force: true });
    try {
      await extractBinary({
        archivePath: downloadPath,
        kind: asset.archive,
        stagingDir: staging,
        limits: this.limits,
        requiredFiles: [caddyBinaryName(this.platform)]
      });
      const stagedBinary = join(staging, caddyBinaryName(this.platform));
      const stats = await lstat(stagedBinary);
      if (!stats.isFile()) throw new OperationFailure('IO_ERROR', 'install.binaryMissing', false);
      await chmod(stagedBinary, 0o755);
      progress.emit('install.validate', 0.78);
      const versionOutput = await validateBinaryVersion(stagedBinary, paths.home);
      throwIfAborted(signal);

      progress.emit('install.commit', 0.9);
      const finalDir = join(paths.installations, CADDY_VERSION);
      await commitDirectory(staging, finalDir);
      const finalBinary = binaryPath(finalDir, this.platform);
      if (!(await pathExists(finalBinary))) throw new OperationFailure('IO_ERROR', 'install.commitFailed', true);

      const record = CaddyInstallationRecordSchema.parse({
        installation: { id: INSTALLATION_ID, version: this.availableVersion(), directory: finalDir },
        target,
        binaryPath: finalBinary,
        archivePath: downloadPath,
        installedAt: new Date().toISOString(),
        versionOutput
      });
      await this.deps.storage.StorageSetAsync(CADDY_MODULE_ID, STORAGE_KEYS.installation, record, CaddyInstallationRecordSchema);
      await this.seedDefaultSite();
      return completed(operationId, `install-${INSTALLATION_ID}`);
    } catch (error) {
      // The previous install directory is restored by commitDirectory; staging is disposable.
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Create the default loopback site once so `service.start` works right after install. */
  private async seedDefaultSite(): Promise<void> {
    const { paths } = this.deps;
    const existing = await this.deps.storage.StorageGetAsync(CADDY_MODULE_ID, STORAGE_KEYS.sites, CaddySiteRecordSchema);
    if (existing !== undefined) return;
    const root = join(paths.siteRoots, 'default');
    await mkdir(root, { recursive: true });
    await atomicWriteFile(
      join(root, 'index.html'),
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>StackManage</title></head><body><h1>StackManage default site</h1></body></html>\n'
    );
    const site = {
      id: 'default',
      hostname: DEFAULT_HOSTNAME,
      aliases: [],
      server: { moduleId: CADDY_MODULE_ID, installationId: INSTALLATION_ID, instanceId: DEFAULT_INSTANCE_ID },
      root,
      port: DEFAULT_SITE_PORT,
      tls: false
    };
    await this.deps.storage.StorageSetAsync(CADDY_MODULE_ID, STORAGE_KEYS.sites, { sites: [site] }, CaddySiteRecordSchema);
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
}

function completed(operationId: string, itemId: string): OperationResult {
  return OperationResultSchema.parse({ operationId, status: 'completed', items: [{ id: itemId, status: 'completed' }], warnings: [] });
}

export function toFailure(error: unknown, signal?: AbortSignal): OperationFailure {
  if (signal?.aborted === true || error instanceof OperationAbortedError) return new OperationFailure('CANCELLED', 'cancelled', false);
  if (error instanceof OperationFailure) return error;
  return new OperationFailure('UNKNOWN', 'unknown', false);
}

export async function sha256OfFile(path: string): Promise<string | undefined> {
  return fileDigest(path);
}

export async function sha256OfBuffer(data: Buffer | string): Promise<string> {
  return createHash('sha256').update(data).digest('hex');
}

/** Read the persisted installation record without re-validating the binary on disk. */
export async function readInstallationRecord(storage: ModuleStorage): Promise<CaddyInstallationRecord | undefined> {
  return storage.StorageGetAsync(CADDY_MODULE_ID, STORAGE_KEYS.installation, CaddyInstallationRecordSchema);
}

/**
 * Swap a fully staged directory into place with atomic renames; a previous
 * install is restored if the final rename fails.
 */
export async function commitDirectory(staging: string, finalDir: string): Promise<void> {
  await mkdir(dirname(finalDir), { recursive: true });
  const backup = `${finalDir}.previous-${Date.now().toString(36)}`;
  const hadPrevious = await pathExists(finalDir);
  if (hadPrevious) await rename(finalDir, backup);
  try {
    await rename(staging, finalDir);
  } catch (error) {
    if (hadPrevious) await rename(backup, finalDir).catch(() => undefined);
    throw new OperationFailure('IO_ERROR', 'install.commitFailed', true, error instanceof Error ? error.message : undefined);
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

/** Test helper: the log tail reader is also used by the service owner. */
export { readLogTail, readFile };
