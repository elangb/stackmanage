/**
 * PHP-FPM service lifecycle.
 *
 * The worker owns the FastCGI master process, its verified identity, the
 * generated configuration and the bounded log. A PID is never signalled without
 * executable and start-token agreement.
 */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleStorage, OperationContext, OperationResult, PhpLifecycleRequest, PhpLogsRequest, PhpLogsView, PhpStatusView } from '@stackmanage/core';
import { OperationResultSchema, PhpLogsViewSchema, PhpStatusViewSchema } from '@stackmanage/core';
import { atomicWriteFile, isWithin } from '../../shared/files';
import { failureResult, OperationAbortedError, OperationFailure, OperationProgress, throwIfAborted } from '../../shared/operation';
import {
  captureIdentity,
  checkIdentity,
  isPortInUse,
  readLogTail,
  spawnDetached,
  terminateTree,
  type ProcessIdentity
} from '../../shared/process';
import { renderPhpFpmConfig, renderPhpIni, renderPhpPoolConfig, assertSafePath } from './config';
import { ensurePhpDirectories, type PhpRuntimeManager } from './runtime';
import { DEFAULT_INSTANCE_ID, LOOPBACK_ADDRESS, PHP_LIMITS, PHP_MODULE_ID, PHP_PORT, PHP_VERSION, type PhpLimits } from './manifest';
import type { PhpPaths } from './paths';
import { PHP_STORAGE_KEYS, PhpProcessRecordSchema, PhpServiceRecordSchema, type PhpInstallationRecord, type PhpProcessRecord, type PhpServiceRecord } from './state';

export interface PhpServiceDeps {
  storage: ModuleStorage;
  paths: PhpPaths;
  runtime: Pick<PhpRuntimeManager, 'installed' | 'view'>;
  limits?: PhpLimits;
  port?: number;
  probe?: (port: number) => Promise<boolean>;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

interface LiveProcess {
  pid: number;
  identity: ProcessIdentity;
  exited: boolean;
}

type StopOutcome =
  | { status: 'stopped' | 'already-stopped' }
  | { status: 'identity-mismatch'; reason: 'executable' | 'start-token' | 'proc-token' | 'unverifiable' }
  | { status: 'unconfirmed' };

function nowIso(): string {
  return new Date().toISOString();
}

function buildResult(operationId: string, items: OperationResult['items'], status: OperationResult['status']): OperationResult {
  return OperationResultSchema.parse({ operationId, status, items, warnings: [] });
}

function errorOf(failure: OperationFailure): NonNullable<OperationResult['items'][number]['error']> {
  return { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable };
}

function asFailure(error: unknown, signal: AbortSignal): OperationFailure {
  if (signal.aborted || error instanceof OperationAbortedError) return new OperationFailure('CANCELLED', 'cancelled', false);
  return error instanceof OperationFailure ? error : new OperationFailure('UNKNOWN', 'php.unknown', false);
}

export function identityOf(process: PhpProcessRecord): ProcessIdentity {
  return { pid: process.pid, executable: process.executable, startToken: process.startToken, procToken: process.procToken };
}

export class PhpServiceManager {
  private readonly limits: PhpLimits;
  private readonly port: number;
  private readonly live = new Map<string, LiveProcess>();
  private active: Promise<unknown> | undefined;

  constructor(private readonly deps: PhpServiceDeps) {
    this.limits = deps.limits ?? PHP_LIMITS;
    this.port = deps.port ?? PHP_PORT;
  }

  private probe(): Promise<boolean> {
    return this.deps.probe !== undefined ? this.deps.probe(this.port) : isPortInUse(LOOPBACK_ADDRESS, this.port);
  }

  private async readService(instanceId: string): Promise<PhpServiceRecord | undefined> {
    return this.deps.storage.StorageGetAsync(PHP_MODULE_ID, PHP_STORAGE_KEYS.service(instanceId), PhpServiceRecordSchema);
  }

  private async writeService(record: PhpServiceRecord): Promise<void> {
    const parsed = PhpServiceRecordSchema.parse(record);
    await this.deps.storage.StorageSetAsync(PHP_MODULE_ID, PHP_STORAGE_KEYS.service(parsed.instanceId), parsed, PhpServiceRecordSchema);
  }

  async reset(): Promise<void> {
    await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
  }

  async status(moduleId: string): Promise<PhpStatusView> {
    if (moduleId !== PHP_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'php.moduleUnsupported', false);
    const installation = await this.deps.runtime.installed();
    const service = await this.serviceView(installation);
    return PhpStatusViewSchema.parse({
      moduleId: PHP_MODULE_ID,
      pinnedVersion: PHP_VERSION,
      platform: 'linux',
      architecture: 'x64',
      supported: true,
      tested: true,
      installed: installation !== undefined,
      ...(installation !== undefined ? { installation: this.deps.runtime.view(installation) } : {}),
      service
    });
  }

  private async serviceView(installation: PhpInstallationRecord | undefined): Promise<PhpStatusView['service']> {
    const base = {
      port: this.port,
      bind: LOOPBACK_ADDRESS,
      configPath: this.deps.paths.config,
      logPath: this.deps.paths.log,
      observedAt: nowIso()
    };
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    if (record?.process === undefined) {
      return {
        state: record?.status === 'unknown' ? 'unknown' : 'stopped',
        ...(record?.unverified?.pid !== undefined ? { pid: record.unverified.pid } : {}),
        ...base
      };
    }
    const process = record.process;
    const check = await checkIdentity(identityOf(process), { requireProcToken: false });
    if (check.status === 'gone') {
      this.live.delete(DEFAULT_INSTANCE_ID);
      await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
      return { state: 'stopped', ...base };
    }
    if (check.status === 'mismatch') {
      await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'unknown', unverified: { pid: process.pid, observedAt: nowIso(), reason: check.reason } });
      return { state: 'unknown', pid: process.pid, ...base };
    }
    const healthy = installation !== undefined ? await this.probe() : false;
    return {
      state: healthy ? 'running' : 'unknown',
      pid: process.pid,
      ...base,
      port: process.port,
      configPath: process.configPath,
      logPath: process.logPath
    };
  }

  start(request: PhpLifecycleRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(async () => {
      const progress = new OperationProgress(context);
      try {
        const result = await this.startInner(request, context, progress);
        progress.terminal(result);
        return result;
      } catch (error) {
        const failure = asFailure(error, context.signal);
        this.deps.logger?.info('php.startFailed', { code: failure.code, ...(failure.detail !== undefined ? { detail: failure.detail } : {}) });
        const result = failureResult(context.operationId, errorOf(failure), DEFAULT_INSTANCE_ID);
        progress.terminal(result);
        return result;
      }
    });
  }

  stop(request: PhpLifecycleRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(async () => {
      const progress = new OperationProgress(context);
      try {
        const record = await this.readService(DEFAULT_INSTANCE_ID);
        if (record?.process === undefined) {
          const result = buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], 'completed');
          progress.terminal(result);
          return result;
        }
        progress.emit('php.stop', 0.4);
        const outcome = await this.stopProcess(record.process, identityOf(record.process));
        if (outcome.status === 'identity-mismatch') throw new OperationFailure('CONFLICT', 'php.identityMismatch', false, outcome.reason);
        if (outcome.status === 'unconfirmed') {
          const result = buildResult(
            context.operationId,
            [{ id: DEFAULT_INSTANCE_ID, status: 'unknown', error: { code: 'UNKNOWN', messageKey: 'php.stopUnconfirmed', retryable: false } }],
            'unknown'
          );
          progress.terminal(result);
          return result;
        }
        const result = buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], 'completed');
        progress.terminal(result);
        return result;
      } catch (error) {
        const failure = asFailure(error, context.signal);
        const result = failureResult(context.operationId, errorOf(failure), DEFAULT_INSTANCE_ID);
        progress.terminal(result);
        return result;
      }
    });
  }

  async logs(request: PhpLogsRequest): Promise<PhpLogsView> {
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    const fallback = this.deps.paths.log;
    const path = record?.process?.logPath !== undefined && isWithin(this.deps.paths.home, record.process.logPath) ? record.process.logPath : fallback;
    const tail = await readLogTail(path, Math.min(request.maxBytes, this.limits.maxLogBytes));
    return PhpLogsViewSchema.parse({ path, bytes: tail.bytes, truncated: tail.truncated, text: tail.text });
  }

  async reconcileOnStartup(): Promise<{ action: 'none' | 'stopped' | 'unknown'; instanceId: string }> {
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    if (record?.process === undefined) return { action: 'none', instanceId: DEFAULT_INSTANCE_ID };
    const process = record.process;
    const identity = identityOf(process);
    const check = await checkIdentity(identity, { requireProcToken: false });
    if (check.status === 'gone') {
      await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
      return { action: 'none', instanceId: DEFAULT_INSTANCE_ID };
    }
    if (check.status === 'mismatch') {
      await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'unknown', unverified: { pid: process.pid, observedAt: nowIso(), reason: check.reason } });
      this.deps.logger?.info('php.reconcileUnverified', { reason: check.reason });
      return { action: 'unknown', instanceId: DEFAULT_INSTANCE_ID };
    }
    const outcome = await this.stopProcess(process, identity);
    return { action: outcome.status === 'stopped' || outcome.status === 'already-stopped' ? 'stopped' : 'unknown', instanceId: DEFAULT_INSTANCE_ID };
  }

  async shutdown(): Promise<void> {
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    if (record?.process !== undefined) {
      const identity = identityOf(record.process);
      if ((await checkIdentity(identity, { requireProcToken: false })).status === 'match') await this.stopProcess(record.process, identity);
    }
    for (const handle of this.live.values()) {
      await terminateTree(handle.pid, {
        graceMs: this.limits.stopGraceMs,
        killMs: this.limits.stopKillMs,
        expected: handle.identity,
        exitObserved: () => handle.exited
      }).catch(() => undefined);
    }
    this.live.clear();
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    if (this.active !== undefined) return Promise.reject(new OperationFailure('CONFLICT', 'php.operationBusy', true));
    const job = run().finally(() => {
      this.active = undefined;
    });
    this.active = job;
    return job;
  }

  private async startInner(request: PhpLifecycleRequest, context: OperationContext, progress: OperationProgress): Promise<OperationResult> {
    const installation = await this.deps.runtime.installed();
    if (installation === undefined) throw new OperationFailure('UNAVAILABLE', 'php.notInstalled', false);

    const existing = await this.readService(DEFAULT_INSTANCE_ID);
    if (existing?.process !== undefined && (await checkIdentity(identityOf(existing.process), { requireProcToken: false })).status === 'match') {
      return buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], 'completed');
    }

    await ensurePhpDirectories(this.deps.paths);
    progress.emit('php.configure', 0.2);
    throwIfAborted(context.signal);
    const configPath = await this.writeConfigs();
    const iniPath = await this.resolvePhpIni(installation);

    const preflight = await this.preflight(installation, configPath, iniPath);
    if (!preflight.ok) throw new OperationFailure('INVALID_REQUEST', 'php.configInvalid', false, preflight.detail);

    if (await this.probe()) throw new OperationFailure('CONFLICT', 'php.portInUse', false);

    progress.emit('php.start', 0.5);
    throwIfAborted(context.signal);
    const procToken = randomBytes(16).toString('hex');
    const scanDir = join(installation.directory, 'etc', 'conf.d');
    const scanExists = await readdir(scanDir).then(() => true).catch(() => false);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: this.deps.paths.home,
      TMPDIR: this.deps.paths.tmp,
      LANG: 'C',
      LC_ALL: 'C',
      STACKMANAGE_PROC_TOKEN: procToken
    };
    if (scanExists) env['PHP_INI_SCAN_DIR'] = scanDir;

    const startedAt = nowIso();
    const spawned = await spawnDetached({
      command: installation.fpmPath,
      args: ['-F', '-y', configPath, '-c', iniPath],
      cwd: this.deps.paths.service,
      env,
      onStdout: () => undefined,
      onStderr: () => undefined,
      onExit: () => {
        const handle = this.live.get(DEFAULT_INSTANCE_ID);
        if (handle !== undefined) handle.exited = true;
      }
    });

    const identity = await captureIdentity(spawned.pid, procToken);
    if (identity === undefined) {
      spawned.stop('SIGKILL');
      throw new OperationFailure('UNAVAILABLE', 'php.identityUnavailable', true);
    }
    const handle: LiveProcess = { pid: spawned.pid, identity, exited: false };
    this.live.set(DEFAULT_INSTANCE_ID, handle);

    const ready = await this.waitForReady(Math.min(request.timeoutMs ?? this.limits.startTimeoutMs, this.limits.startTimeoutMs));
    if (!ready) {
      await this.stopProcess(
        {
          instanceId: DEFAULT_INSTANCE_ID,
          pid: spawned.pid,
          executable: identity.executable,
          startToken: identity.startToken,
          procToken,
          port: this.port,
          configPath,
          logPath: this.deps.paths.log,
          startedAt
        },
        identity
      );
      throw new OperationFailure('UNAVAILABLE', 'php.startFailed', true);
    }

    const processRecord: PhpProcessRecord = PhpProcessRecordSchema.parse({
      instanceId: DEFAULT_INSTANCE_ID,
      pid: spawned.pid,
      executable: identity.executable,
      startToken: identity.startToken,
      procToken,
      port: this.port,
      configPath,
      logPath: this.deps.paths.log,
      startedAt
    });
    await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'running', process: processRecord });
    progress.emit('php.ready', 0.9);
    return buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], 'completed');
  }

  private async waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.probe()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async writeConfigs(): Promise<string> {
    const { paths } = this.deps;
    assertSafePath(paths.config);
    assertSafePath(paths.poolDir);
    const options = {
      configPath: paths.config,
      poolPath: join(paths.poolDir, 'www.conf'),
      pidPath: paths.pid,
      logPath: paths.log,
      accessLogPath: join(paths.logs, 'access.log'),
      errorLogPath: join(paths.logs, 'php-error.log'),
      sessionsDir: paths.sessions,
      tmpDir: paths.tmp,
      port: this.port
    };
    if (!isWithin(paths.home, options.poolPath)) throw new OperationFailure('INVALID_REQUEST', 'php.unsafePath', false);
    const global = renderPhpFpmConfig(options);
    const pool = renderPhpPoolConfig(options);
    await mkdir(paths.poolDir, { recursive: true });
    const globalCandidate = `${paths.config}.${Date.now().toString(36)}.candidate.conf`;
    await atomicWriteFile(globalCandidate, global);
    await rename(globalCandidate, paths.config);
    await atomicWriteFile(options.poolPath, pool);
    return paths.config;
  }

  private async resolvePhpIni(installation: PhpInstallationRecord): Promise<string> {
    const runtimeIni = join(installation.directory, 'etc', 'php.ini');
    if (await readdir(join(installation.directory, 'etc')).then(files => files.includes('php.ini')).catch(() => false)) return runtimeIni;
    const generated = join(this.deps.paths.conf, 'php.ini');
    await atomicWriteFile(
      generated,
      renderPhpIni({ errorLogPath: join(this.deps.paths.logs, 'php-error.log'), sessionsDir: this.deps.paths.sessions, tmpDir: this.deps.paths.tmp })
    );
    return generated;
  }

  private async preflight(installation: PhpInstallationRecord, configPath: string, iniPath: string): Promise<{ ok: boolean; detail?: string }> {
    const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
    const scanDir = join(installation.directory, 'etc', 'conf.d');
    if (await readdir(scanDir).then(() => true).catch(() => false)) env['PHP_INI_SCAN_DIR'] = scanDir;
    return new Promise(resolve => {
      const child = spawn(installation.fpmPath, ['-t', '-y', configPath, '-c', iniPath], { env, shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let detail = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      timer.unref?.();
      child.stderr?.on('data', (chunk: Buffer) => {
        if (detail.length < 512) detail += chunk.toString('utf8');
      });
      child.once('error', () => {
        clearTimeout(timer);
        resolve({ ok: false, detail: 'spawn' });
      });
      child.once('close', code => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true } : { ok: false, detail: detail.slice(0, 200) });
      });
    });
  }

  private async stopProcess(process: PhpProcessRecord, identity: ProcessIdentity): Promise<StopOutcome> {
    const check = await checkIdentity(identity, { requireProcToken: false });
    if (check.status === 'gone') {
      this.live.delete(DEFAULT_INSTANCE_ID);
      await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
      return { status: 'already-stopped' };
    }
    if (check.status === 'mismatch') {
      await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'unknown', unverified: { pid: process.pid, observedAt: nowIso(), reason: check.reason } });
      return { status: 'identity-mismatch', reason: check.reason };
    }
    const live = this.live.get(DEFAULT_INSTANCE_ID);
    const termination = await terminateTree(process.pid, {
      graceMs: this.limits.stopGraceMs,
      killMs: this.limits.stopKillMs,
      expected: identity,
      exitObserved: () => live?.exited === true
    });
    if (!termination.exited) {
      await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'unknown', process });
      return { status: 'unconfirmed' };
    }
    this.live.delete(DEFAULT_INSTANCE_ID);
    await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
    return { status: 'stopped' };
  }
}

export async function removeCandidate(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}
