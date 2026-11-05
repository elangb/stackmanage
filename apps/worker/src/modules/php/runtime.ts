/**
 * PHP runtime validation and registration.
 *
 * No unofficial binary is downloaded. The pinned runtime is produced by the
 * repository's build runner and placed under the managed installations tree
 * (or an explicit `STACKMANAGE_PHP_RUNTIME` development override). Only a
 * directory that reports exactly PHP 8.5.12 is recorded.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstallRequest, ModuleStorage, OperationContext, OperationResult, PhpInstallationView, PhpListView, PhpVersionsView } from '@stackmanage/core';
import { OperationResultSchema, PhpInstallationViewSchema, PhpListViewSchema, PhpVersionsViewSchema } from '@stackmanage/core';
import { failureResult, OperationFailure, OperationProgress, throwIfAborted } from '../../shared/operation';
import { isInside, pathExists } from '../../shared/files';
import { PHP_INSTALLATION_ID, PHP_MODULE_ID, PHP_VERSION } from './manifest';
import { PHP_STORAGE_KEYS, PhpInstallationRecordSchema, PhpInstallationsRecordSchema, type PhpInstallationRecord } from './state';
import type { PhpPaths } from './paths';

export interface PhpRuntimeDeps {
  storage: ModuleStorage;
  paths: PhpPaths;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  /** Development/portable override; never taken from an IPC caller. */
  runtimeOverride?: string;
}

function normalizedPlatform(value: string): 'win32' | 'linux' | 'darwin' {
  if (value === 'win32' || value === 'windows') return 'win32';
  if (value === 'darwin') return 'darwin';
  return 'linux';
}

function normalizedArchitecture(value: string): 'x64' | 'arm64' {
  return value === 'arm64' ? 'arm64' : 'x64';
}

function runBinary(binary: string, args: readonly string[], timeoutMs = 10_000): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(binary, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    const append = (chunk: Buffer): void => {
      if (output.length < 4096) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ code: null, output });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function findFirst(root: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    const path = join(root, ...candidate.split('/'));
    if (await pathExists(path)) return path;
  }
  return undefined;
}

const VERSION_PATTERN = /PHP\s+8\.5\.12(?:\s|$)/;

export class PhpRuntimeManager {
  private readonly platform: string;
  private readonly architecture: string;

  constructor(private readonly deps: PhpRuntimeDeps) {
    this.platform = deps.platform ?? process.platform;
    this.architecture = deps.architecture ?? process.arch;
  }

  private supported(): boolean {
    return normalizedPlatform(this.platform) === 'linux' && normalizedArchitecture(this.architecture) === 'x64';
  }

  versionsView(moduleId: string): PhpVersionsView {
    if (moduleId !== PHP_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'php.moduleUnsupported', false);
    const supported = this.supported();
    return PhpVersionsViewSchema.parse({
      moduleId: PHP_MODULE_ID,
      pinnedVersion: PHP_VERSION,
      platform: normalizedPlatform(this.platform),
      architecture: normalizedArchitecture(this.architecture),
      supported,
      tested: supported,
      versions: [
        {
          moduleId: PHP_MODULE_ID,
          version: PHP_VERSION,
          platform: 'linux',
          architecture: 'x64',
          kind: 'build-runner',
          tested: supported,
          supported
        }
      ]
    });
  }

  async installed(): Promise<PhpInstallationRecord | undefined> {
    const records = await this.readRecords();
    for (const record of records) {
      if (await this.recordIsValid(record)) return record;
    }
    return undefined;
  }

  async list(moduleId: string): Promise<PhpListView> {
    if (moduleId !== PHP_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'php.moduleUnsupported', false);
    const installations: PhpInstallationView[] = [];
    for (const record of await this.readRecords()) {
      if (await this.recordIsValid(record)) installations.push(this.view(record));
    }
    return PhpListViewSchema.parse({ moduleId: PHP_MODULE_ID, installations });
  }

  view(record: PhpInstallationRecord): PhpInstallationView {
    return PhpInstallationViewSchema.parse({
      id: record.id,
      moduleId: PHP_MODULE_ID,
      version: record.version,
      platform: 'linux',
      architecture: 'x64',
      directory: record.directory,
      fpmPath: record.fpmPath,
      cliPath: record.cliPath,
      versionOutput: record.versionOutput,
      installedAt: record.installedAt
    });
  }

  async install(request: InstallRequest, context: OperationContext): Promise<OperationResult> {
    const progress = new OperationProgress(context);
    try {
      if (request.moduleId !== PHP_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'php.moduleUnsupported', false);
      if (normalizedPlatform(request.platform) !== 'linux' || normalizedArchitecture(request.architecture) !== 'x64') {
        throw new OperationFailure('UNAVAILABLE', 'php.platformUnsupported', false);
      }
      if (request.version !== PHP_VERSION) throw new OperationFailure('INVALID_REQUEST', 'php.versionUnsupported', false);
      if (!this.supported()) throw new OperationFailure('UNAVAILABLE', 'php.platformUnsupported', false);

      const existing = await this.installed();
      if (existing !== undefined) {
        const done = OperationResultSchema.parse({ operationId: context.operationId, status: 'completed', items: [{ id: PHP_INSTALLATION_ID, status: 'completed' }], warnings: [] });
        progress.terminal(done);
        return done;
      }

      progress.emit('php.validate', 0.3);
      throwIfAborted(context.signal);
      const directory = this.runtimeDirectory();
      const record = await this.validateRuntime(directory);
      throwIfAborted(context.signal);
      progress.emit('php.persist', 0.8);
      const records = { installations: [...(await this.readRecords()), record] };
      await this.deps.storage.StorageSetAsync(PHP_MODULE_ID, PHP_STORAGE_KEYS.installations, records, PhpInstallationsRecordSchema);
      const done = OperationResultSchema.parse({ operationId: context.operationId, status: 'completed', items: [{ id: record.id, status: 'completed' }], warnings: [] });
      progress.terminal(done);
      return done;
    } catch (error) {
      const failure = error instanceof OperationFailure ? error : new OperationFailure('UNKNOWN', 'php.unknown', false);
      const failed = failureResult(context.operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, PHP_INSTALLATION_ID);
      progress.terminal(failed);
      return failed;
    }
  }

  async uninstall(installationId: string, operationId: string, context: OperationContext): Promise<OperationResult> {
    const progress = new OperationProgress(context);
    try {
      if (installationId !== PHP_INSTALLATION_ID) throw new OperationFailure('INVALID_REQUEST', 'php.installationNotFound', false);
      const records = await this.readRecords();
      const record = records.find(item => item.id === installationId);
      if (record === undefined) throw new OperationFailure('INVALID_REQUEST', 'php.installationNotFound', false);
      if (!isInside(this.deps.paths.installations, record.directory)) throw new OperationFailure('CONFLICT', 'php.uninstallOutsideManagedRoot', false);
      progress.emit('php.remove', 0.5);
      await rm(record.directory, { recursive: true, force: true });
      await this.deps.storage.StorageSetAsync(
        PHP_MODULE_ID,
        PHP_STORAGE_KEYS.installations,
        { installations: records.filter(item => item.id !== installationId) },
        PhpInstallationsRecordSchema
      );
      const done = OperationResultSchema.parse({ operationId, status: 'completed', items: [{ id: installationId, status: 'completed' }], warnings: [] });
      progress.terminal(done);
      return done;
    } catch (error) {
      const failure = error instanceof OperationFailure ? error : new OperationFailure('UNKNOWN', 'php.unknown', false);
      const failed = failureResult(operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, installationId);
      progress.terminal(failed);
      return failed;
    }
  }

  async readRecords(): Promise<PhpInstallationRecord[]> {
    const record = await this.deps.storage.StorageGetAsync(PHP_MODULE_ID, PHP_STORAGE_KEYS.installations, PhpInstallationsRecordSchema).catch(() => undefined);
    return record?.installations ?? [];
  }

  private runtimeDirectory(): string {
    if (this.deps.runtimeOverride !== undefined && this.deps.runtimeOverride.trim() !== '') return this.deps.runtimeOverride;
    return join(this.deps.paths.installations, PHP_INSTALLATION_ID);
  }

  private async validateRuntime(directory: string): Promise<PhpInstallationRecord> {
    if (!(await stat(directory).then(stats => stats.isDirectory()).catch(() => false))) {
      throw new OperationFailure('UNAVAILABLE', 'php.runtimeMissing', false);
    }
    const fpmPath = await findFirst(directory, ['bin/php-fpm8.5', 'bin/php-fpm', 'sbin/php-fpm']);
    const cliPath = await findFirst(directory, ['bin/php', 'bin/php8.5']);
    if (fpmPath === undefined || cliPath === undefined) throw new OperationFailure('UNAVAILABLE', 'php.runtimeMissing', false);

    const [fpm, cli] = await Promise.all([runBinary(fpmPath, ['-v']), runBinary(cliPath, ['-v'])]);
    const output = `${fpm.output}\n${cli.output}`;
    if (fpm.code !== 0 || cli.code !== 0 || !VERSION_PATTERN.test(output)) {
      throw new OperationFailure('UNAVAILABLE', 'php.versionMismatch', false);
    }
    const firstLine = output.split('\n').map(line => line.trim()).find(line => VERSION_PATTERN.test(line)) ?? `PHP ${PHP_VERSION}`;
    return PhpInstallationRecordSchema.parse({
      id: PHP_INSTALLATION_ID,
      moduleId: PHP_MODULE_ID,
      version: PHP_VERSION,
      target: 'linux-x64',
      directory,
      fpmPath,
      cliPath,
      versionOutput: firstLine.slice(0, 200),
      installedAt: new Date().toISOString()
    });
  }

  private async recordIsValid(record: PhpInstallationRecord): Promise<boolean> {
    if (!(await pathExists(record.fpmPath))) return false;
    if (!(await pathExists(record.cliPath))) return false;
    return true;
  }
}

export async function ensurePhpDirectories(paths: PhpPaths): Promise<void> {
  await mkdir(paths.conf, { recursive: true });
  await mkdir(paths.poolDir, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
  await mkdir(paths.run, { recursive: true });
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.tmp, { recursive: true });
}
