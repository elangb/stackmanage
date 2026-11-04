/**
 * Redis service lifecycle.
 *
 * The worker owns the real server process, its verified identity, the generated
 * configuration, the private data directory and the PID/log records. A PID is
 * never signalled without executable and start-token agreement.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ModuleStorage,
  OperationContext,
  OperationResult,
  RedisLifecycleRequest,
  RedisLogsRequest,
  RedisLogsView,
  RedisStatusView
} from '@stackmanage/core';
import { OperationResultSchema, RedisLogsViewSchema, RedisStatusViewSchema } from '@stackmanage/core';
import { atomicWriteFile, isInside, isWithin } from '../../shared/files';
import { failureResult, OperationAbortedError, OperationFailure, OperationProgress, throwIfAborted } from '../../shared/operation';
import {
  CappedLog,
  captureIdentity,
  checkIdentity,
  describePortOwner,
  isPortInUse,
  readLogTail,
  spawnDetached,
  terminateTree,
  type ProcessIdentity
} from '../../shared/process';
import { renderRedisConfig } from './config';
import type { RedisInstaller } from './installer';
import {
  DEFAULT_INSTANCE_ID,
  DEFAULT_REDIS_LIMITS,
  DEFAULT_REDIS_PORT,
  LOOPBACK_ADDRESS,
  REDIS_ASSETS,
  REDIS_MODULE_ID,
  REDIS_VERSION,
  redisPlatform,
  redisTarget,
  type RedisLimits
} from './manifest';
import type { RedisPaths } from './paths';
import { redisChildEnvironment, redisPing } from './run';
import { REDIS_STORAGE_KEYS, RedisProcessRecordSchema, RedisServiceRecordSchema, type RedisInstallationRecord, type RedisProcessRecord, type RedisServiceRecord } from './state';

export interface RedisServiceDeps {
  storage: ModuleStorage;
  paths: RedisPaths;
  installer: Pick<RedisInstaller, 'installed' | 'view'>;
  limits?: RedisLimits;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  /** Test seam; production binds the fixed loopback port. */
  port?: number;
  probe?: (port: number) => Promise<boolean>;
  /** Test seam; production runs the managed `redis-cli ... ping`. */
  ping?: (installation: RedisInstallationRecord, port: number) => Promise<boolean>;
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

function buildResult(operationId: string, items: OperationResult['items'], warnings: OperationResult['warnings'], status: OperationResult['status']): OperationResult {
  return OperationResultSchema.parse({ operationId, status, items, warnings });
}

function errorOf(failure: OperationFailure): NonNullable<OperationResult['items'][number]['error']> {
  return { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable };
}

function asFailure(error: unknown, signal: AbortSignal): OperationFailure {
  if (signal.aborted || error instanceof OperationAbortedError) return new OperationFailure('CANCELLED', 'cancelled', false);
  return error instanceof OperationFailure ? error : new OperationFailure('UNKNOWN', 'redis.unknown', false);
}

export function identityOf(process: RedisProcessRecord): ProcessIdentity {
  return { pid: process.pid, executable: process.executable, startToken: process.startToken, procToken: process.procToken };
}

export class RedisServiceManager {
  private readonly limits: RedisLimits;
  private readonly platform: string;
  private readonly architecture: string;
  private readonly port: number;
  private readonly live = new Map<string, LiveProcess>();
  private readonly inflight = new Map<string, Promise<OperationResult>>();

  constructor(private readonly deps: RedisServiceDeps) {
    this.limits = deps.limits ?? DEFAULT_REDIS_LIMITS;
    this.platform = deps.platform ?? process.platform;
    this.architecture = deps.architecture ?? process.arch;
    this.port = deps.port ?? DEFAULT_REDIS_PORT;
  }

  private probe(port: number): Promise<boolean> {
    return this.deps.probe !== undefined ? this.deps.probe(port) : isPortInUse(LOOPBACK_ADDRESS, port);
  }

  private ping(installation: RedisInstallationRecord, port: number): Promise<boolean> {
    if (this.deps.ping !== undefined) return this.deps.ping(installation, port);
    return redisPing(installation.cliPath, LOOPBACK_ADDRESS, port, this.deps.paths.home, 3000);
  }

  private async readService(instanceId: string): Promise<RedisServiceRecord | undefined> {
    return this.deps.storage.StorageGetAsync(REDIS_MODULE_ID, REDIS_STORAGE_KEYS.service(instanceId), RedisServiceRecordSchema);
  }

  private async writeService(record: RedisServiceRecord): Promise<void> {
    const parsed = RedisServiceRecordSchema.parse(record);
    await this.deps.storage.StorageSetAsync(REDIS_MODULE_ID, REDIS_STORAGE_KEYS.service(parsed.instanceId), parsed, RedisServiceRecordSchema);
  }

  async reset(): Promise<void> {
    await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
  }

  /** Read-only status; reconciling a vanished process is the only write it performs. */
  async status(moduleId: string): Promise<RedisStatusView> {
    if (moduleId !== REDIS_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'redis.moduleUnsupported', false);
    const target = redisTarget(this.platform, this.architecture);
    const asset = target !== undefined ? REDIS_ASSETS[target] : undefined;
    const supported = asset?.supported === true;
    const tested = asset?.tested === true;
    const installation = await this.deps.installer.installed();
    const service = await this.serviceView(installation);
    return RedisStatusViewSchema.parse({
      moduleId: REDIS_MODULE_ID,
      pinnedVersion: REDIS_VERSION,
      platform: target !== undefined ? redisPlatform() : this.normalizedPlatform(),
      architecture: this.architecture === 'arm64' ? 'arm64' : 'x64',
      supported,
      tested,
      installed: installation !== undefined,
      ...(installation !== undefined ? { installation: this.deps.installer.view(installation) } : {}),
      service
    });
  }

  private normalizedPlatform(): 'win32' | 'linux' | 'darwin' {
    if (this.platform === 'win32' || this.platform === 'windows') return 'win32';
    if (this.platform === 'darwin') return 'darwin';
    return 'linux';
  }

  private async serviceView(installation: RedisInstallationRecord | undefined): Promise<RedisStatusView['service']> {
    const { paths } = this.deps;
    const base = {
      port: this.port,
      bind: LOOPBACK_ADDRESS as '127.0.0.1',
      configPath: paths.config,
      dataDir: paths.data,
      logPath: paths.log,
      pidFile: paths.pid,
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
    const healthy = installation !== undefined ? await this.ping(installation, process.port) : false;
    return {
      state: healthy ? 'running' : 'unknown',
      pid: process.pid,
      ...base,
      port: process.port,
      configPath: process.configPath,
      dataDir: process.dataDir,
      logPath: process.logPath,
      pidFile: process.pidFile
    };
  }

  start(request: RedisLifecycleRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(async () => {
      const progress = new OperationProgress(context);
      try {
        const result = await this.startInner(request, context, progress);
        progress.terminal(result);
        return result;
      } catch (error) {
        const failure = asFailure(error, context.signal);
        this.deps.logger?.info('redis.startFailed', {
          code: failure.code,
          ...(failure.detail !== undefined ? { detail: failure.detail } : {})
        });
        const result = failureResult(context.operationId, errorOf(failure), DEFAULT_INSTANCE_ID);
        progress.terminal(result);
        return result;
      }
    });
  }

  stop(request: RedisLifecycleRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(async () => {
      const progress = new OperationProgress(context);
      try {
        const record = await this.readService(DEFAULT_INSTANCE_ID);
        if (record?.process === undefined) {
          const result = buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], [], 'completed');
          progress.terminal(result);
          return result;
        }
        progress.emit('redis.stop', 0.4);
        const outcome = await this.stopProcess(record.process, identityOf(record.process));
        if (outcome.status === 'identity-mismatch') throw new OperationFailure('CONFLICT', 'redis.identityMismatch', false, outcome.reason);
        if (outcome.status === 'unconfirmed') {
          const result = buildResult(
            context.operationId,
            [{ id: DEFAULT_INSTANCE_ID, status: 'unknown', error: { code: 'UNKNOWN', messageKey: 'redis.stopUnconfirmed', retryable: false } }],
            [],
            'unknown'
          );
          progress.terminal(result);
          return result;
        }
        const result = buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], [], 'completed');
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

  async logs(request: RedisLogsRequest): Promise<RedisLogsView> {
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    const fallback = this.deps.paths.log;
    const path = record?.process?.logPath !== undefined && isWithin(this.deps.paths.home, record.process.logPath) ? record.process.logPath : fallback;
    const tail = await readLogTail(path, Math.min(request.maxBytes, this.limits.maxLogBytes));
    return RedisLogsViewSchema.parse({ path, bytes: tail.bytes, truncated: tail.truncated, text: tail.text });
  }

  /** Startup reconciliation: terminate only verified orphans, never an unverified PID. */
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
      this.deps.logger?.info('redis.reconcileUnverified', { reason: check.reason });
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
        exitObserved: () => true
      }).catch(() => undefined);
    }
    this.live.clear();
  }

  private serialized(run: () => Promise<OperationResult>): Promise<OperationResult> {
    const existing = this.inflight.get(DEFAULT_INSTANCE_ID);
    if (existing !== undefined) return existing;
    const promise = run().finally(() => {
      this.inflight.delete(DEFAULT_INSTANCE_ID);
    });
    this.inflight.set(DEFAULT_INSTANCE_ID, promise);
    return promise;
  }

  private async startInner(request: RedisLifecycleRequest, context: OperationContext, progress: OperationProgress): Promise<OperationResult> {
    throwIfAborted(context.signal);
    const installation = await this.deps.installer.installed();
    if (installation === undefined) throw new OperationFailure('UNAVAILABLE', 'redis.notInstalled', false);
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    if (record?.process !== undefined) {
      const check = await checkIdentity(identityOf(record.process), { requireProcToken: false });
      if (check.status === 'match' && (await this.ping(installation, record.process.port))) {
        progress.emit('redis.alreadyRunning', 0.9);
        return buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], [], 'completed');
      }
      if (check.status === 'mismatch') {
        await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'unknown', unverified: { pid: record.process.pid, observedAt: nowIso(), reason: check.reason } });
        throw new OperationFailure('CONFLICT', 'redis.identityMismatch', false, check.reason);
      }
      if (check.status === 'match') {
        // Our process exists but does not answer PING: report failure instead of claiming readiness.
        throw new OperationFailure('CONFLICT', 'redis.notRunning', false, 'process alive without PONG');
      }
      this.live.delete(DEFAULT_INSTANCE_ID);
    }

    progress.emit('redis.preflight', 0.05);
    if (await this.probe(this.port)) {
      const owner = await describePortOwner(this.port);
      throw new OperationFailure('CONFLICT', 'redis.portInUse', false, `port=${this.port}${owner !== undefined ? ` owner=${owner}` : ''}`);
    }

    progress.emit('redis.config', 0.2);
    const configPath = await this.writeManagedConfig(installation, context.signal);
    throwIfAborted(context.signal);

    progress.emit('redis.spawn', 0.4);
    const procToken = randomBytes(16).toString('hex');
    const stdoutLog = await CappedLog.open(join(this.deps.paths.logs, 'stdout.log'), this.limits.maxLogBytes);
    const stderrLog = await CappedLog.open(join(this.deps.paths.logs, 'stderr.log'), this.limits.maxLogBytes);
    let exited = false;
    const spawned = await spawnDetached({
      command: join(installation.directory, 'bin', 'redis-server'),
      args: [configPath],
      cwd: this.deps.paths.service,
      env: redisChildEnvironment(procToken, this.deps.paths.home),
      onStdout: chunk => stdoutLog.write(chunk),
      onStderr: chunk => stderrLog.write(chunk),
      onExit: () => {
        exited = true;
      }
    });
    const identity = await captureIdentity(spawned.pid, procToken);
    if (identity === undefined) {
      spawned.stop('SIGKILL');
      throw new OperationFailure('IO_ERROR', 'redis.identityCaptureFailed', true);
    }
    const handle: LiveProcess = { pid: spawned.pid, identity, exited: false };
    const isExited = (): boolean => exited || handle.exited;
    this.live.set(DEFAULT_INSTANCE_ID, handle);

    const deadline = Date.now() + Math.min(request.timeoutMs ?? this.limits.readinessTimeoutMs, this.limits.readinessTimeoutMs);
    let ready = false;
    while (Date.now() < deadline) {
      if (context.signal.aborted) break;
      if (isExited()) break;
      if (await this.ping(installation, this.port)) {
        ready = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) {
      await stdoutLog.flush();
      await stderrLog.flush();
      await this.stopHandle(handle);
      await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
      const tail = await readLogTail(this.deps.paths.log, 4096);
      throw new OperationFailure('UNAVAILABLE', 'redis.startFailed', true, `${isExited() ? 'process exited' : 'readiness timeout'} logBytes=${tail.bytes}`);
    }

    progress.emit('redis.ready', 0.95);
    try {
      await this.writeService({
        instanceId: DEFAULT_INSTANCE_ID,
        status: 'running',
        process: RedisProcessRecordSchema.parse({
          instanceId: DEFAULT_INSTANCE_ID,
          pid: spawned.pid,
          executable: identity.executable,
          startToken: identity.startToken,
          procToken,
          port: this.port,
          configPath,
          dataDir: this.deps.paths.data,
          logPath: this.deps.paths.log,
          pidFile: this.deps.paths.pid,
          startedAt: spawned.startedAt
        })
      });
    } catch {
      // A service we cannot record must not be left running as an orphan.
      await this.stopHandle(handle);
      throw new OperationFailure('IO_ERROR', 'redis.startFailed', true);
    }
    return buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], [], 'completed');
  }

  private async stopProcess(process: RedisProcessRecord, identity: ProcessIdentity): Promise<StopOutcome> {
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
      this.deps.logger?.info('redis.stopUnconfirmed', { forced: termination.forced });
      return { status: 'unconfirmed' };
    }
    this.live.delete(DEFAULT_INSTANCE_ID);
    await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
    return { status: 'stopped' };
  }

  private async stopHandle(handle: LiveProcess): Promise<void> {
    this.live.delete(DEFAULT_INSTANCE_ID);
    try {
      await terminateTree(handle.pid, {
        graceMs: this.limits.stopGraceMs,
        killMs: this.limits.stopKillMs,
        expected: handle.identity,
        exitObserved: () => handle.exited
      });
    } catch {
      /* cleanup only */
    }
  }

  /** Render and atomically replace the managed config; no caller-supplied path or port. */
  private async writeManagedConfig(installation: RedisInstallationRecord, signal: AbortSignal): Promise<string> {
    const { paths } = this.deps;
    const server = join(installation.directory, 'bin', 'redis-server');
    if (!isWithin(paths.home, paths.config) || !isInside(installation.directory, server)) {
      throw new OperationFailure('INVALID_REQUEST', 'redis.unsafePath', false);
    }
    await mkdir(paths.conf, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await mkdir(paths.data, { recursive: true });
    let rendered: string;
    try {
      rendered = renderRedisConfig({
        installDir: installation.directory,
        configPath: paths.config,
        dataDir: paths.data,
        logPath: paths.log,
        pidFile: paths.pid,
        port: this.port
      });
    } catch {
      throw new OperationFailure('INVALID_REQUEST', 'redis.unsafePath', false);
    }
    throwIfAborted(signal);
    const candidate = `${paths.config}.${Date.now().toString(36)}.candidate.conf`;
    await atomicWriteFile(candidate, rendered);
    try {
      await rename(candidate, paths.config);
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => undefined);
      throw error;
    }
    return paths.config;
  }
}
