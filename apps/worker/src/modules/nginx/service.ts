/**
 * Nginx service lifecycle.
 *
 * The worker owns the real master process, its verified identity, the generated
 * configuration and the PID/log records. A PID is never signalled without
 * executable, start-token and environment-token agreement.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConfigReadView,
  ModuleStorage,
  NginxLifecycleRequest,
  NginxLogsRequest,
  NginxLogsView,
  NginxStatusView,
  OperationContext,
  OperationResult
} from '@stackmanage/core';
import {
  ConfigReadViewSchema,
  NginxLogsViewSchema,
  NginxStatusViewSchema,
  OperationResultSchema
} from '@stackmanage/core';
import { atomicWriteFile, isInside, isWithin, pathExists } from '../../shared/files';
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
import { defaultIndexHtml, renderNginxConfig } from './config';
import type { NginxInstaller } from './installer';
import {
  DEFAULT_HOSTNAME,
  DEFAULT_INSTANCE_ID,
  DEFAULT_NGINX_LIMITS,
  DEFAULT_SITE_PORT,
  NGINX_ASSETS,
  NGINX_MODULE_ID,
  NGINX_VERSION,
  type NginxLimits,
  nginxTarget
} from './manifest';
import type { NginxPaths } from './paths';
import { nginxChildEnvironment, validateNginxConfig } from './run';
import { NGINX_STORAGE_KEYS, NginxProcessRecordSchema, NginxServiceRecordSchema, type NginxInstallationRecord, type NginxProcessRecord, type NginxServiceRecord } from './state';

export interface NginxServiceDeps {
  storage: ModuleStorage;
  paths: NginxPaths;
  installer: Pick<NginxInstaller, 'installed' | 'view'>;
  limits?: NginxLimits;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  /** Test seam; production binds the fixed loopback port. */
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

function buildResult(operationId: string, items: OperationResult['items'], warnings: OperationResult['warnings'], status: OperationResult['status']): OperationResult {
  return OperationResultSchema.parse({ operationId, status, items, warnings });
}

function errorOf(failure: OperationFailure): NonNullable<OperationResult['items'][number]['error']> {
  return { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable };
}

function asFailure(error: unknown, signal: AbortSignal): OperationFailure {
  if (signal.aborted || error instanceof OperationAbortedError) return new OperationFailure('CANCELLED', 'cancelled', false);
  return error instanceof OperationFailure ? error : new OperationFailure('UNKNOWN', 'nginx.unknown', false);
}

export function identityOf(process: NginxProcessRecord): ProcessIdentity {
  return { pid: process.pid, executable: process.executable, startToken: process.startToken, procToken: process.procToken };
}

export class NginxServiceManager {
  private readonly limits: NginxLimits;
  private readonly platform: string;
  private readonly architecture: string;
  private readonly port: number;
  private readonly live = new Map<string, LiveProcess>();
  private readonly inflight = new Map<string, Promise<OperationResult>>();

  constructor(private readonly deps: NginxServiceDeps) {
    this.limits = deps.limits ?? DEFAULT_NGINX_LIMITS;
    this.platform = deps.platform ?? process.platform;
    this.architecture = deps.architecture ?? process.arch;
    this.port = deps.port ?? DEFAULT_SITE_PORT;
  }

  private probe(port: number): Promise<boolean> {
    return this.deps.probe !== undefined ? this.deps.probe(port) : isPortInUse('127.0.0.1', port);
  }

  private async readService(instanceId: string): Promise<NginxServiceRecord | undefined> {
    return this.deps.storage.StorageGetAsync(NGINX_MODULE_ID, NGINX_STORAGE_KEYS.service(instanceId), NginxServiceRecordSchema);
  }

  private async writeService(record: NginxServiceRecord): Promise<void> {
    const parsed = NginxServiceRecordSchema.parse(record);
    await this.deps.storage.StorageSetAsync(NGINX_MODULE_ID, NGINX_STORAGE_KEYS.service(parsed.instanceId), parsed, NginxServiceRecordSchema);
  }

  async reset(): Promise<void> {
    await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
  }

  /** Read-only status; reconciling a vanished process is the only write it performs. */
  async status(moduleId: string): Promise<NginxStatusView> {
    if (moduleId !== NGINX_MODULE_ID) throw new OperationFailure('NOT_IMPLEMENTED', 'nginx.moduleUnsupported', false);
    const target = nginxTarget(this.platform, this.architecture);
    const asset = target !== undefined ? NGINX_ASSETS[target] : undefined;
    const supported = asset?.supported === true && asset.kind === 'source';
    const tested = asset?.tested === true;
    const installation = await this.deps.installer.installed();
    const service = await this.serviceView(installation);
    return NginxStatusViewSchema.parse({
      moduleId: NGINX_MODULE_ID,
      pinnedVersion: NGINX_VERSION,
      platform: asset !== undefined ? (target?.startsWith('win-') === true ? 'win32' : 'linux') : this.normalizedPlatform(),
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

  private async serviceView(installation: NginxInstallationRecord | undefined): Promise<NginxStatusView['service']> {
    const base = {
      port: this.port,
      ports: [] as number[],
      configPath: join(this.deps.paths.conf, 'nginx.conf'),
      logPath: join(this.deps.paths.logs, 'error.log'),
      observedAt: nowIso()
    };
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    if (record?.process === undefined) {
      return {
        state: record?.status === 'unknown' ? 'unknown' : installation === undefined ? 'stopped' : 'stopped',
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
    const listening = await this.probe(process.port);
    return {
      state: listening ? 'running' : 'unknown',
      pid: process.pid,
      port: process.port,
      ports: listening ? [process.port] : [],
      configPath: process.configPath,
      logPath: process.logPath,
      observedAt: nowIso()
    };
  }

  start(request: NginxLifecycleRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(async () => {
      const progress = new OperationProgress(context);
      try {
        const result = await this.startInner(request, context, progress);
        progress.terminal(result);
        return result;
      } catch (error) {
        const failure = asFailure(error, context.signal);
        this.deps.logger?.info('nginx.startFailed', {
          code: failure.code,
          ...(failure.detail !== undefined ? { detail: failure.detail } : {})
        });
        const result = failureResult(context.operationId, errorOf(failure), DEFAULT_INSTANCE_ID);
        progress.terminal(result);
        return result;
      }
    });
  }

  stop(request: NginxLifecycleRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(async () => {
      const progress = new OperationProgress(context);
      try {
        const record = await this.readService(DEFAULT_INSTANCE_ID);
        if (record?.process === undefined) {
          const result = buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], [], 'completed');
          progress.terminal(result);
          return result;
        }
        progress.emit('nginx.stop', 0.4);
        const outcome = await this.stopProcess(record.process, identityOf(record.process));
        if (outcome.status === 'identity-mismatch') throw new OperationFailure('CONFLICT', 'nginx.identityMismatch', false, outcome.reason);
        if (outcome.status === 'unconfirmed') {
          const result = buildResult(
            context.operationId,
            [{ id: DEFAULT_INSTANCE_ID, status: 'unknown', error: { code: 'UNKNOWN', messageKey: 'nginx.stopUnconfirmed', retryable: false } }],
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

  reload(request: NginxLifecycleRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(async () => {
      const progress = new OperationProgress(context);
      try {
        const installation = await this.deps.installer.installed();
        if (installation === undefined) throw new OperationFailure('UNAVAILABLE', 'nginx.notInstalled', false);
        const record = await this.readService(DEFAULT_INSTANCE_ID);
        if (record?.process === undefined) throw new OperationFailure('CONFLICT', 'nginx.notRunning', false);
        const currentProcess = record.process;
        const identity = identityOf(currentProcess);
        const check = await checkIdentity(identity, { requireProcToken: false });
        if (check.status === 'gone') {
          await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
          throw new OperationFailure('CONFLICT', 'nginx.notRunning', false);
        }
        if (check.status === 'mismatch') {
          await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'unknown', unverified: { pid: currentProcess.pid, observedAt: nowIso(), reason: check.reason } });
          throw new OperationFailure('CONFLICT', 'nginx.identityMismatch', false, check.reason);
        }

        progress.emit('nginx.reload.config', 0.3);
        await this.writeValidatedConfig(installation, context.signal);
        throwIfAborted(context.signal);

        progress.emit('nginx.reload.signal', 0.6);
        try {
          globalThis.process.kill(currentProcess.pid, 'SIGHUP');
        } catch {
          throw new OperationFailure('IO_ERROR', 'nginx.reloadFailed', true);
        }
        const deadline = Date.now() + Math.min(request.timeoutMs ?? this.limits.readinessTimeoutMs, this.limits.readinessTimeoutMs);
        let ready = false;
        while (Date.now() < deadline) {
          if (context.signal.aborted) break;
          if ((await checkIdentity(identity, { requireProcToken: false })).status !== 'match') break;
          if (await this.probe(currentProcess.port)) {
            ready = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) {
          const still = (await checkIdentity(identity, { requireProcToken: false })).status === 'match';
          if (!still) {
            await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'stopped' });
            throw new OperationFailure('UNAVAILABLE', 'nginx.reloadFailed', true);
          }
          // The master is alive but did not re-open the listener within the bound.
          throw new OperationFailure('UNAVAILABLE', 'nginx.reloadFailed', true);
        }
        progress.emit('nginx.reload.done', 0.95);
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

  async logs(request: NginxLogsRequest): Promise<NginxLogsView> {
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    const fallback = join(this.deps.paths.logs, 'error.log');
    const path = record?.process?.logPath !== undefined && isWithin(this.deps.paths.home, record.process.logPath) ? record.process.logPath : fallback;
    const tail = await readLogTail(path, Math.min(request.maxBytes, this.limits.maxLogBytes));
    return NginxLogsViewSchema.parse({ path, bytes: tail.bytes, truncated: tail.truncated, text: tail.text });
  }

  async config(): Promise<ConfigReadView> {
    const path = join(this.deps.paths.conf, 'nginx.conf');
    if (!isWithin(this.deps.paths.home, path) || !(await pathExists(path))) {
      return ConfigReadViewSchema.parse({ path, exists: false, content: '' });
    }
    const content = await readFile(path, 'utf8');
    return ConfigReadViewSchema.parse({ path, exists: true, content: content.slice(0, 240_000) });
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
      this.deps.logger?.info('nginx.reconcileUnverified', { reason: check.reason });
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

  private async startInner(request: NginxLifecycleRequest, context: OperationContext, progress: OperationProgress): Promise<OperationResult> {
    throwIfAborted(context.signal);
    const installation = await this.deps.installer.installed();
    if (installation === undefined) throw new OperationFailure('UNAVAILABLE', 'nginx.notInstalled', false);
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    if (record?.process !== undefined) {
      const check = await checkIdentity(identityOf(record.process), { requireProcToken: false });
      if (check.status === 'match') {
        progress.emit('nginx.alreadyRunning', 0.9);
        return buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], [], 'completed');
      }
      if (check.status === 'mismatch') {
        await this.writeService({ instanceId: DEFAULT_INSTANCE_ID, status: 'unknown', unverified: { pid: record.process.pid, observedAt: nowIso(), reason: check.reason } });
        throw new OperationFailure('CONFLICT', 'nginx.identityMismatch', false, check.reason);
      }
      this.live.delete(DEFAULT_INSTANCE_ID);
    }

    progress.emit('nginx.preflight', 0.05);
    if (await this.probe(this.port)) {
      const owner = await describePortOwner(this.port);
      throw new OperationFailure('CONFLICT', 'nginx.portInUse', false, `port=${this.port}${owner !== undefined ? ` owner=${owner}` : ''}`);
    }

    progress.emit('nginx.config', 0.2);
    const configPath = await this.writeValidatedConfig(installation, context.signal);
    throwIfAborted(context.signal);

    progress.emit('nginx.spawn', 0.4);
    const procToken = randomBytes(16).toString('hex');
    const logPath = join(this.deps.paths.logs, 'error.log');
    const stdoutLog = await CappedLog.open(join(this.deps.paths.logs, 'stdout.log'), this.limits.maxLogBytes);
    const stderrLog = await CappedLog.open(join(this.deps.paths.logs, 'stderr.log'), this.limits.maxLogBytes);
    let exited = false;
    const spawned = await spawnDetached({
      command: join(installation.directory, 'sbin', 'nginx'),
      args: ['-p', installation.directory, '-c', configPath],
      cwd: this.deps.paths.service,
      env: nginxChildEnvironment(procToken, this.deps.paths.home),
      onStdout: chunk => stdoutLog.write(chunk),
      onStderr: chunk => stderrLog.write(chunk),
      onExit: () => {
        exited = true;
      }
    });
    const identity = await captureIdentity(spawned.pid, procToken);
    if (identity === undefined) {
      spawned.stop('SIGKILL');
      throw new OperationFailure('IO_ERROR', 'nginx.identityCaptureFailed', true);
    }
    const handle: LiveProcess = { pid: spawned.pid, identity, exited: false };
    const isExited = (): boolean => exited || handle.exited;
    this.live.set(DEFAULT_INSTANCE_ID, handle);

    const deadline = Date.now() + Math.min(request.timeoutMs ?? this.limits.readinessTimeoutMs, this.limits.readinessTimeoutMs);
    let ready = false;
    while (Date.now() < deadline) {
      if (context.signal.aborted) break;
      if (isExited()) break;
      if (await this.probe(this.port)) {
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
      const tail = await readLogTail(logPath, 4096);
      throw new OperationFailure('UNAVAILABLE', 'nginx.startFailed', true, `${isExited() ? 'process exited' : 'readiness timeout'} logBytes=${tail.bytes}`);
    }

    progress.emit('nginx.ready', 0.95);
    try {
      await this.writeService({
        instanceId: DEFAULT_INSTANCE_ID,
        status: 'running',
        process: NginxProcessRecordSchema.parse({
          instanceId: DEFAULT_INSTANCE_ID,
          pid: spawned.pid,
          executable: identity.executable,
          startToken: identity.startToken,
          procToken,
          port: this.port,
          configPath,
          logPath,
          startedAt: spawned.startedAt
        })
      });
    } catch {
      // A service we cannot record must not be left running as an orphan.
      await this.stopHandle(handle);
      throw new OperationFailure('IO_ERROR', 'nginx.startFailed', true);
    }
    return buildResult(context.operationId, [{ id: DEFAULT_INSTANCE_ID, status: 'completed' }], [], 'completed');
  }

  private async stopProcess(process: NginxProcessRecord, identity: ProcessIdentity): Promise<StopOutcome> {
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
      this.deps.logger?.info('nginx.stopUnconfirmed', { forced: termination.forced });
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

  /** Render, validate with the real binary, then atomically replace the live config. */
  private async writeValidatedConfig(installation: NginxInstallationRecord, signal: AbortSignal): Promise<string> {
    const { paths } = this.deps;
    const configPath = join(paths.conf, 'nginx.conf');
    const binary = join(installation.directory, 'sbin', 'nginx');
    if (!isWithin(paths.home, configPath) || !isInside(installation.directory, binary)) {
      throw new OperationFailure('INVALID_REQUEST', 'nginx.unsafePath', false);
    }
    await mkdir(paths.conf, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await mkdir(paths.tmp, { recursive: true });
    for (const name of ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']) await mkdir(join(paths.tmp, name), { recursive: true });
    await mkdir(paths.defaultSite, { recursive: true });
    const indexPath = join(paths.defaultSite, 'index.html');
    if (!(await pathExists(indexPath))) await atomicWriteFile(indexPath, defaultIndexHtml());

    let rendered: string;
    try {
      rendered = renderNginxConfig({
        installDir: installation.directory,
        pidPath: join(paths.logs, 'nginx.pid'),
        errorLogPath: join(paths.logs, 'error.log'),
        accessLogPath: join(paths.logs, 'access.log'),
        tempDir: paths.tmp,
        root: paths.defaultSite,
        port: this.port,
        hostname: DEFAULT_HOSTNAME
      });
    } catch {
      throw new OperationFailure('INVALID_REQUEST', 'nginx.unsafePath', false);
    }
    throwIfAborted(signal);
    const candidate = `${configPath}.${Date.now().toString(36)}.candidate.conf`;
    await atomicWriteFile(candidate, rendered);
    try {
      await validateNginxConfig(binary, candidate, installation.directory, paths.home, this.limits.configTimeoutMs);
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => undefined);
      throw error;
    }
    await rename(candidate, configPath);
    return configPath;
  }
}
