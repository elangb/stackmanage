import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  InstanceRequest,
  LogTailRequest,
  LogTailView,
  ModuleStorage,
  OperationContext,
  OperationResult,
  ServiceListView,
  ServiceRequest,
  ServiceState,
  Site
} from '@stackmanage/core';
import { LogTailViewSchema, OperationResultSchema, ServiceStateSchema } from '@stackmanage/core';
import {
  DEFAULT_INSTANCE_ID,
  DEFAULT_OPERATIONAL_LIMITS,
  OperationAbortedError,
  OperationFailure,
  OperationProgress,
  failureResult,
  throwIfAborted,
  type OperationalLimits
} from './manifest';
import type { CaddyInstaller } from './installer';
import { INSTALLATION_ID, childEnvironment, runCaddy } from './installer';
import { CADDY_MODULE_ID, CaddyServiceRecordSchema, CaddySiteRecordSchema, STORAGE_KEYS, type CaddyInstallationRecord, type CaddyProcessRecord, type CaddyServiceRecord } from './state';
import { atomicWriteFile, isInside, type Paths } from './paths';
import { renderCaddyfile } from './caddyfile';
import {
  CappedLog,
  binaryPath,
  captureIdentity,
  checkIdentity,
  describePortOwner,
  isPortInUse,
  readLogTail,
  spawnDetached,
  terminateTree,
  type ProcessIdentity
} from './process';

export interface ServiceManagerDeps {
  storage: ModuleStorage;
  paths: Paths;
  installer: Pick<CaddyInstaller, 'installed'>;
  limits?: OperationalLimits;
  platform?: NodeJS.Platform | string;
  /** Injectable readiness probe for tests; defaults to a real loopback TCP connect. */
  probe?: (port: number) => Promise<boolean>;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

interface LiveProcess {
  pid: number;
  token: string;
  identity: ProcessIdentity;
  exited: boolean;
}

export type StopOutcome =
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
  return error instanceof OperationFailure ? error : new OperationFailure('UNKNOWN', 'unknown', false);
}

export function identityOf(process: CaddyProcessRecord): ProcessIdentity {
  return { pid: process.pid, executable: process.executable, startToken: process.startToken, procToken: process.procToken };
}

export class CaddyServiceManager {
  private readonly limits: OperationalLimits;
  private readonly platform: string;
  private readonly live = new Map<string, LiveProcess>();
  /** One mutation per instance at a time; a duplicate request attaches to it. */
  private readonly inflight = new Map<string, Promise<OperationResult>>();

  constructor(private readonly deps: ServiceManagerDeps) {
    this.limits = deps.limits ?? DEFAULT_OPERATIONAL_LIMITS;
    this.platform = deps.platform ?? process.platform;
  }

  private probe(port: number): Promise<boolean> {
    return this.deps.probe !== undefined ? this.deps.probe(port) : isPortInUse('127.0.0.1', port);
  }

  private async readService(instanceId: string): Promise<CaddyServiceRecord | undefined> {
    return this.deps.storage.StorageGetAsync(CADDY_MODULE_ID, STORAGE_KEYS.service(instanceId), CaddyServiceRecordSchema);
  }

  /** Diagnostics only: the persisted record for one instance. */
  async read(instanceId: string): Promise<CaddyServiceRecord | undefined> {
    return this.readService(instanceId);
  }

  private async writeService(record: CaddyServiceRecord): Promise<void> {
    const parsed = CaddyServiceRecordSchema.parse(record);
    await this.deps.storage.StorageSetAsync(CADDY_MODULE_ID, STORAGE_KEYS.service(parsed.instanceId), parsed, CaddyServiceRecordSchema);
  }

  private refFor(installation?: CaddyInstallationRecord) {
    return { moduleId: CADDY_MODULE_ID, installationId: installation?.installation.id ?? INSTALLATION_ID, instanceId: DEFAULT_INSTANCE_ID };
  }

  private async requireInstallation(): Promise<CaddyInstallationRecord> {
    const installation = await this.deps.installer.installed();
    if (installation === undefined) throw new OperationFailure('UNAVAILABLE', 'caddy.notInstalled', false);
    return installation;
  }

  async serviceRef(instanceId = DEFAULT_INSTANCE_ID): Promise<{ moduleId: string; installationId: string; instanceId: string }> {
    const installation = await this.deps.installer.installed();
    return { moduleId: CADDY_MODULE_ID, installationId: installation?.installation.id ?? INSTALLATION_ID, instanceId };
  }

  async validateServiceRef(ref: { moduleId: string; installationId: string; instanceId: string }): Promise<boolean> {
    const installation = await this.deps.installer.installed();
    return ref.moduleId === CADDY_MODULE_ID && ref.instanceId === DEFAULT_INSTANCE_ID && ref.installationId === (installation?.installation.id ?? INSTALLATION_ID);
  }

  /** Read-only status; reconciling a vanished process is the only write it performs. */
  async status(request: InstanceRequest): Promise<ServiceState> {
    const instanceId = request.instanceId;
    const installation = await this.deps.installer.installed();
    const ref = this.refFor(installation);
    if (instanceId !== DEFAULT_INSTANCE_ID) {
      return ServiceStateSchema.parse({ ref: { ...ref, instanceId }, state: 'stopped', ports: [], observedAt: nowIso() });
    }
    const record = await this.readService(instanceId);
    if (record?.process === undefined) {
      return ServiceStateSchema.parse({ ref, state: record?.status === 'unknown' ? 'unknown' : 'stopped', ports: [], observedAt: nowIso() });
    }
    const process = record.process;
    const check = await checkIdentity(identityOf(process));
    if (check.status === 'gone') {
      const live = this.live.get(instanceId);
      if (live !== undefined) live.exited = true;
      this.live.delete(instanceId);
      await this.writeService({ instanceId, status: 'stopped' });
      return ServiceStateSchema.parse({ ref, state: 'stopped', ports: [], observedAt: nowIso() });
    }
    if (check.status === 'mismatch') {
      await this.writeService({ instanceId, status: 'unknown', unverified: { pid: process.pid, observedAt: nowIso(), reason: check.reason } });
      return ServiceStateSchema.parse({ ref, state: 'unknown', ports: [], observedAt: nowIso() });
    }
    const listening = await this.probe(process.port);
    return ServiceStateSchema.parse({
      ref,
      state: listening ? 'running' : 'unknown',
      pid: process.pid,
      ports: listening ? [process.port] : [],
      observedAt: nowIso()
    });
  }

  async list(): Promise<ServiceListView> {
    const state = await this.status({ instanceId: DEFAULT_INSTANCE_ID });
    return { services: [state] };
  }

  /**
   * Startup reconciliation. A persisted PID is only terminated when executable,
   * start token and environment token all still match. A mismatch is preserved
   * as `unknown` for human review; nothing is ever killed blindly.
   */
  async reconcileOnStartup(): Promise<{ action: 'none' | 'stopped' | 'unknown'; instanceId: string }> {
    const instanceId = DEFAULT_INSTANCE_ID;
    const record = await this.readService(instanceId);
    if (record?.process === undefined) return { action: 'none', instanceId };
    const process = record.process;
    const identity = identityOf(process);
    const check = await checkIdentity(identity);
    if (check.status === 'gone') {
      await this.writeService({ instanceId, status: 'stopped' });
      return { action: 'none', instanceId };
    }
    if (check.status === 'mismatch') {
      await this.writeService({ instanceId, status: 'unknown', unverified: { pid: process.pid, observedAt: nowIso(), reason: check.reason } });
      this.deps.logger?.info('service.reconcile-unverified', { reason: check.reason });
      return { action: 'unknown', instanceId };
    }
    const outcome = await this.stopProcess(instanceId, process, identity);
    return { action: outcome.status === 'stopped' || outcome.status === 'already-stopped' ? 'stopped' : 'unknown', instanceId };
  }

  start(request: ServiceRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(request.ref.instanceId, async () => {
      const progress = new OperationProgress(context);
      try {
        const done = await this.startInner(request, context, progress);
        progress.terminal(done);
        return done;
      } catch (error) {
        const failure = asFailure(error, context.signal);
        this.deps.logger?.info('service.start-failed', {
          code: failure.code,
          ...(failure.detail !== undefined ? { detail: failure.detail } : {})
        });
        const failed = failureResult(context.operationId, errorOf(failure), request.ref.instanceId);
        progress.terminal(failed);
        return failed;
      }
    });
  }

  stop(request: ServiceRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(request.ref.instanceId, async () => {
      const progress = new OperationProgress(context);
      try {
        const done = await this.stopInner(request, context, progress, request.ref.instanceId);
        progress.terminal(done);
        return done;
      } catch (error) {
        const failure = asFailure(error, context.signal);
        const failed = failureResult(context.operationId, errorOf(failure), request.ref.instanceId);
        progress.terminal(failed);
        return failed;
      }
    });
  }

  restart(request: ServiceRequest, context: OperationContext): Promise<OperationResult> {
    return this.serialized(request.ref.instanceId, async () => {
      const progress = new OperationProgress(context);
      const items: OperationResult['items'] = [];
      const warnings: OperationResult['warnings'] = [];
      try {
        this.validateRef(request);
        progress.emit('service.restart.stop', 0.1);
        const stopResult = await this.stopInner(request, context, progress, `${request.ref.instanceId}:stop`);
        if (stopResult.status !== 'completed') {
          items.push({ id: `${request.ref.instanceId}:stop`, status: 'failed', error: stopResult.items[0]?.error ?? { code: 'UNKNOWN', messageKey: 'unknown', retryable: false } });
          const failed = buildResult(context.operationId, items, warnings, 'failed');
          progress.terminal(failed);
          return failed;
        }
        items.push({ id: `${request.ref.instanceId}:stop`, status: 'completed' });
        progress.emit('service.restart.start', 0.5);
        const startResult = await this.startInner(request, context, progress);
        if (startResult.status !== 'completed') {
          items.push({ id: `${request.ref.instanceId}:start`, status: 'failed', error: startResult.items[0]?.error ?? { code: 'UNKNOWN', messageKey: 'unknown', retryable: false } });
          const failed = buildResult(context.operationId, items, warnings, 'failed');
          progress.terminal(failed);
          return failed;
        }
        items.push({ id: `${request.ref.instanceId}:start`, status: 'completed' });
        const done = buildResult(context.operationId, items, warnings, 'completed');
        progress.terminal(done);
        return done;
      } catch (error) {
        const failure = asFailure(error, context.signal);
        items.push({ id: `${request.ref.instanceId}:restart`, status: 'failed', error: errorOf(failure) });
        const failed = buildResult(context.operationId, items, warnings, failure.code === 'CANCELLED' ? 'cancelled' : 'failed');
        progress.terminal(failed);
        return failed;
      }
    });
  }

  private serialized(instanceId: string, run: () => Promise<OperationResult>): Promise<OperationResult> {
    const existing = this.inflight.get(instanceId);
    if (existing !== undefined) return existing;
    const promise = run().finally(() => {
      this.inflight.delete(instanceId);
    });
    this.inflight.set(instanceId, promise);
    return promise;
  }

  private validateRef(request: ServiceRequest): void {
    if (request.ref.moduleId !== CADDY_MODULE_ID) throw new OperationFailure('INVALID_REQUEST', 'service.moduleMismatch', false);
    if (request.ref.instanceId !== DEFAULT_INSTANCE_ID) throw new OperationFailure('INVALID_REQUEST', 'service.instanceUnsupported', false);
    if (request.ref.installationId !== INSTALLATION_ID) throw new OperationFailure('INVALID_REQUEST', 'service.installationMismatch', false);
  }

  private async startInner(request: ServiceRequest, context: OperationContext, progress: OperationProgress): Promise<OperationResult> {
    const instanceId = request.ref.instanceId;
    this.validateRef(request);
    throwIfAborted(context.signal);
    const installation = await this.requireInstallation();
    const binary = binaryPath(installation.installation.directory, this.platform);
    progress.emit('service.preflight', 0.05);

    const record = await this.readService(instanceId);
    if (record?.process !== undefined) {
      const check = await checkIdentity(identityOf(record.process));
      if (check.status === 'match') {
        progress.emit('service.already-running', 0.9);
        return buildResult(context.operationId, [{ id: instanceId, status: 'completed' }], [], 'completed');
      }
      if (check.status === 'mismatch') {
        await this.writeService({ instanceId, status: 'unknown', unverified: { pid: record.process.pid, observedAt: nowIso(), reason: check.reason } });
        throw new OperationFailure('CONFLICT', 'service.identityMismatch', false, check.reason);
      }
      this.live.delete(instanceId);
    }

    const sites = (await this.deps.storage.StorageGetAsync(CADDY_MODULE_ID, STORAGE_KEYS.sites, CaddySiteRecordSchema))?.sites ?? [];
    const port = sites.find(site => site.id === 'default')?.port ?? sites[0]?.port ?? 18080;
    throwIfAborted(context.signal);
    if (await this.probe(port)) {
      const owner = await describePortOwner(port);
      throw new OperationFailure('CONFLICT', 'service.portInUse', false, `port=${port}${owner !== undefined ? ` owner=${owner}` : ''}`);
    }

    progress.emit('service.config', 0.2);
    const configPath = join(this.deps.paths.caddyfiles, `${instanceId}.Caddyfile`);
    await this.writeValidatedConfig(binary, installation, sites, configPath, context.signal);

    progress.emit('service.spawn', 0.4);
    const procToken = randomBytes(16).toString('hex');
    const logPath = join(this.deps.paths.logs, `${instanceId}.log`);
    const combined = await CappedLog.open(logPath, this.limits.maxLogBytes);
    const stdoutLog = await CappedLog.open(join(this.deps.paths.logs, `${instanceId}.stdout.log`), this.limits.maxLogBytes);
    const stderrLog = await CappedLog.open(join(this.deps.paths.logs, `${instanceId}.stderr.log`), this.limits.maxLogBytes);
    let exited = false;
    const spawned = await spawnDetached({
      command: binary,
      // `--adapter caddyfile` is explicit so the live config never depends on the file suffix.
      args: ['run', '--config', configPath, '--adapter', 'caddyfile'],
      cwd: join(this.deps.paths.instances, instanceId),
      env: childEnvironment(procToken, this.deps.paths.home),
      onStdout: chunk => {
        stdoutLog.write(chunk);
        combined.write(chunk);
      },
      onStderr: chunk => {
        stderrLog.write(chunk);
        combined.write(chunk);
      },
      onExit: () => {
        exited = true;
      }
    });
    const identity = await captureIdentity(spawned.pid, procToken);
    if (identity === undefined) {
      spawned.stop('SIGKILL');
      throw new OperationFailure('IO_ERROR', 'service.identityCaptureFailed', true);
    }
    const handle: LiveProcess = { pid: spawned.pid, token: procToken, identity, exited: false };
    const isExited = (): boolean => exited || handle.exited;
    this.live.set(instanceId, handle);

    const readinessDeadline = Date.now() + Math.min(request.timeoutMs ?? this.limits.readinessTimeoutMs, this.limits.readinessTimeoutMs);
    let ready = false;
    while (Date.now() < readinessDeadline) {
      if (context.signal.aborted) break;
      if (isExited()) break;
      if (await this.probe(port)) {
        ready = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) {
      await stdoutLog.flush();
      await stderrLog.flush();
      await this.stopHandle(instanceId, handle);
      await this.writeService({ instanceId, status: 'stopped' });
      const tail = await readLogTail(logPath, 4096);
      throw new OperationFailure('UNAVAILABLE', 'service.startFailed', true, `${isExited() ? 'process exited' : 'readiness timeout'} logBytes=${tail.bytes}`);
    }

    progress.emit('service.ready', 0.95);
    await this.writeService({
      instanceId,
      status: 'running',
      process: {
        instanceId,
        ref: { moduleId: CADDY_MODULE_ID, installationId: installation.installation.id, instanceId },
        pid: spawned.pid,
        executable: identity.executable,
        startToken: identity.startToken,
        procToken,
        port,
        configPath,
        logPath,
        startedAt: spawned.startedAt
      }
    });
    return buildResult(context.operationId, [{ id: instanceId, status: 'completed' }], [], 'completed');
  }

  private async stopInner(request: ServiceRequest, context: OperationContext, progress: OperationProgress, itemId: string): Promise<OperationResult> {
    this.validateRef(request);
    const instanceId = request.ref.instanceId;
    const record = await this.readService(instanceId);
    if (record?.process === undefined) {
      return buildResult(context.operationId, [{ id: itemId, status: 'completed' }], [], 'completed');
    }
    progress.emit('service.stopping', 0.5);
    const process = record.process;
    // The in-memory handle is only a status hint; identity is always re-verified against the OS.
    const outcome = await this.stopProcess(instanceId, process, identityOf(process));
    if (outcome.status === 'identity-mismatch') {
      throw new OperationFailure('CONFLICT', 'service.identityMismatch', false, outcome.reason);
    }
    if (outcome.status === 'unconfirmed') {
      return buildResult(
        context.operationId,
        [{ id: itemId, status: 'unknown', error: { code: 'UNKNOWN', messageKey: 'service.stopUnconfirmed', retryable: false } }],
        [],
        'unknown'
      );
    }
    progress.emit('service.stopped', 0.95);
    return buildResult(context.operationId, [{ id: itemId, status: 'completed' }], [], 'completed');
  }

  /** Truthful stop: a mismatched or unverifiable identity is never killed. */
  private async stopProcess(instanceId: string, process: CaddyProcessRecord, identity: ProcessIdentity): Promise<StopOutcome> {
    const check = await checkIdentity(identity);
    if (check.status === 'gone') {
      this.live.delete(instanceId);
      await this.writeService({ instanceId, status: 'stopped' });
      return { status: 'already-stopped' };
    }
    if (check.status === 'mismatch') {
      await this.writeService({ instanceId, status: 'unknown', unverified: { pid: process.pid, observedAt: nowIso(), reason: check.reason } });
      return { status: 'identity-mismatch', reason: check.reason };
    }
    const live = this.live.get(instanceId);
    const termination = await terminateTree(process.pid, {
      graceMs: this.limits.stopGraceMs,
      killMs: this.limits.stopKillMs,
      expected: identity,
      exitObserved: () => live?.exited === true
    });
    if (!termination.exited) {
      await this.writeService({ instanceId, status: 'unknown', process });
      this.deps.logger?.info('service.stop-unconfirmed', { forced: termination.forced });
      return { status: 'unconfirmed' };
    }
    this.live.delete(instanceId);
    await this.writeService({ instanceId, status: 'stopped' });
    return { status: 'stopped' };
  }

  /** Render, validate with the real binary, then atomically replace the config file. */
  private async writeValidatedConfig(binary: string, installation: CaddyInstallationRecord, sites: Site[], configPath: string, signal: AbortSignal): Promise<void> {
    if (!isInside(this.deps.paths.home, configPath)) throw new OperationFailure('INVALID_REQUEST', 'caddy.unsafePath', false);
    if (!isInside(installation.installation.directory, binary)) throw new OperationFailure('INVALID_REQUEST', 'caddy.unsafePath', false);
    let rendered: ReturnType<typeof renderCaddyfile>;
    try {
      rendered = renderCaddyfile(sites, this.deps.paths.siteRoots);
    } catch (error) {
      throw new OperationFailure('INVALID_REQUEST', 'site.invalid', false, error instanceof Error ? error.message : undefined);
    }
    throwIfAborted(signal);
    await mkdir(this.deps.paths.caddyfiles, { recursive: true });
    await mkdir(this.deps.paths.instances, { recursive: true });
    // Validate the candidate, never the live file: a rejected config cannot break a running service.
    // Adapter is inferred from the file name, so the candidate must still end in `.Caddyfile`.
    const candidate = `${configPath}.${Date.now().toString(36)}.candidate.Caddyfile`;
    await atomicWriteFile(candidate, rendered.content);
    const validation = await runCaddy(binary, ['validate', '--config', candidate, '--adapter', 'caddyfile'], this.deps.paths.instances, 10_000, childEnvironment('validate', this.deps.paths.home));
    if (validation.code !== 0) {
      await rm(candidate, { force: true });
      this.deps.logger?.info('service.config-invalid', { timedOut: validation.timedOut });
      throw new OperationFailure('INVALID_REQUEST', 'caddy.configInvalid', false);
    }
    await rename(candidate, configPath);
  }

  /** Cleanup after another failure; never masks the original error. */
  private async stopHandle(instanceId: string, handle: LiveProcess): Promise<void> {
    this.live.delete(instanceId);
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

  async logsTail(request: LogTailRequest): Promise<LogTailView> {
    const record = await this.readService(request.instanceId);
    const path = record?.process?.logPath ?? join(this.deps.paths.logs, `${request.instanceId}.log`);
    const tail = await readLogTail(path, Math.min(request.maxBytes, this.limits.maxLogBytes));
    return LogTailViewSchema.parse({ instanceId: request.instanceId, bytes: tail.bytes, truncated: tail.truncated, text: tail.text });
  }

  /** Worker shutdown: stop only verified children and keep the per-service outcome. */
  async shutdown(): Promise<void> {
    const record = await this.readService(DEFAULT_INSTANCE_ID);
    if (record?.process !== undefined) {
      const identity = identityOf(record.process);
      if ((await checkIdentity(identity)).status === 'match') await this.stopProcess(DEFAULT_INSTANCE_ID, record.process, identity);
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
}
