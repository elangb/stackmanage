import { fork, type ChildProcess } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_MAX_MESSAGE_BYTES,
  PLUGIN_PROBE_METHODS,
  PluginFatalNotificationSchema,
  PluginReadyNotificationSchema,
  PluginRpcResponseSchema,
  type PluginProbeMethod
} from '@stackmanage/plugin-sdk';
import { PluginHostError } from './errors';
import { isInside } from './paths';

export type PluginRuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface PluginRuntimeView {
  readonly state: PluginRuntimeState;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly lastHeartbeatAt?: string;
  readonly failureReason?: string;
}

export interface PluginRuntimeLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}

export interface PluginRuntimeOptions {
  readonly id: string;
  readonly entryPath: string;
  readonly pluginDir: string;
  readonly runnerPath?: string;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxPendingRequests?: number;
  readonly maxOutputBytes?: number;
  readonly envAllowlist?: readonly string[];
  readonly logger?: PluginRuntimeLogger;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG', 'LC_ALL', 'LC_CTYPE']);
const DEFAULT_RUNNER_PATH = fileURLToPath(new URL('./runtime/runner.mjs', import.meta.url));

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return undefined;
  }
}

function isProbeMethod(value: string): value is PluginProbeMethod {
  return (PLUGIN_PROBE_METHODS as readonly string[]).includes(value);
}

/**
 * One child process per enabled plugin.
 *
 * This class is intentionally explicit about isolation: it separates crashes and applies
 * a small environment allowlist, but a Node child is not an OS sandbox. The only host API
 * is the read-only `plugin.ping`/`plugin.status` RPC surface; no filesystem, network, shell
 * or exec function is bridged into the child.
 */
export class PluginRuntime {
  private readonly options: Required<Omit<PluginRuntimeOptions, 'logger' | 'envAllowlist' | 'runnerPath'>> & {
    readonly logger?: PluginRuntimeLogger;
    readonly envAllowlist: readonly string[];
    readonly runnerPath: string;
  };
  private child: ChildProcess | undefined;
  private stateName: PluginRuntimeState = 'stopped';
  private pid: number | undefined;
  private startedAt: string | undefined;
  private lastHeartbeatAt: string | undefined;
  private failureReason: string | undefined;
  private startPromise: Promise<void> | undefined;
  private ready: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatInFlight = false;
  private exitHandled = false;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly outputBytes = { stdout: 0, stderr: 0, truncated: false };

  constructor(options: PluginRuntimeOptions) {
    const pluginDir = options.pluginDir;
    const entryPath = options.entryPath;
    if (!isInside(pluginDir, entryPath)) throw new PluginHostError('FORBIDDEN', 'entry-outside-plugin');
    this.options = {
      id: options.id,
      entryPath,
      pluginDir,
      runnerPath: options.runnerPath ?? DEFAULT_RUNNER_PATH,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 5_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 2_000,
      stopGraceMs: options.stopGraceMs ?? 1_500,
      maxMessageBytes: options.maxMessageBytes ?? PLUGIN_MAX_MESSAGE_BYTES,
      maxPendingRequests: options.maxPendingRequests ?? 16,
      maxOutputBytes: options.maxOutputBytes ?? 65_536,
      envAllowlist: options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST,
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    };
  }

  get id(): string {
    return this.options.id;
  }

  view(): PluginRuntimeView {
    return {
      state: this.stateName,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ...(this.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: this.lastHeartbeatAt } : {}),
      ...(this.failureReason !== undefined ? { failureReason: this.failureReason } : {})
    };
  }

  private childEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of this.options.envAllowlist) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env['STACKMANAGE_PLUGIN_ID'] = this.options.id;
    env['STACKMANAGE_PLUGIN_ENTRY'] = this.options.entryPath;
    env['STACKMANAGE_PLUGIN_API_VERSION'] = '1';
    return env;
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.options.logger?.info(event, { pluginId: this.options.id, ...fields });
  }

  private captureOutput(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const remaining = this.options.maxOutputBytes - this.outputBytes[stream];
    if (remaining <= 0) {
      if (!this.outputBytes.truncated) {
        this.outputBytes.truncated = true;
        this.log('plugin.output.truncated', { stream, limit: this.options.maxOutputBytes });
      }
      return;
    }
    const text = chunk.subarray(0, remaining).toString('utf8');
    this.outputBytes[stream] += Buffer.byteLength(text, 'utf8');
    if (text.length > 0) this.log('plugin.output', { stream, text });
    if (chunk.byteLength > remaining && !this.outputBytes.truncated) {
      this.outputBytes.truncated = true;
      this.log('plugin.output.truncated', { stream, limit: this.options.maxOutputBytes });
    }
  }

  private attach(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: Buffer) => this.captureOutput('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.captureOutput('stderr', chunk));
    child.on('message', (message: unknown) => this.onMessage(message));
    child.on('error', () => this.onExit(1, null, 'spawn-error'));
    child.on('exit', (code, signal) => this.onExit(code, signal, 'exit'));
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private rejectPending(error: PluginHostError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const timer = setInterval(() => {
      if (this.stateName !== 'running' || this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      this.sendRequestInternal('plugin.ping', undefined, this.options.heartbeatTimeoutMs)
        .then(() => {
          this.lastHeartbeatAt = new Date().toISOString();
        })
        .catch((error: unknown) => {
          // An RPC-level handler failure still proves the child answered; only a
          // missing/uncorrelated response or a dead child is a heartbeat failure.
          if (error instanceof PluginHostError && error.detail === 'rpc-error') {
            this.lastHeartbeatAt = new Date().toISOString();
            return;
          }
          this.failRuntime('heartbeat-timeout');
        })
        .finally(() => {
          this.heartbeatInFlight = false;
        });
    }, this.options.heartbeatIntervalMs);
    timer.unref?.();
    this.heartbeatTimer = timer;
  }

  private onMessage(message: unknown): void {
    const bytes = serializedBytes(message);
    if (bytes === undefined || bytes > this.options.maxMessageBytes) {
      this.rejectPending(new PluginHostError('PROTOCOL_ERROR', 'message-too-large'));
      this.failRuntime('protocol');
      return;
    }

    const ready = PluginReadyNotificationSchema.safeParse(message);
    if (ready.success) {
      if (this.stateName !== 'starting') return;
      if (ready.data.params.pluginId !== this.options.id || ready.data.params.apiVersion !== 1) {
        this.failRuntime('protocol');
        return;
      }
      this.clearHandshakeTimer();
      this.stateName = 'running';
      this.pid = ready.data.params.pid;
      this.startedAt = new Date().toISOString();
      this.lastHeartbeatAt = this.startedAt;
      const pendingReady = this.ready;
      this.ready = undefined;
      pendingReady?.resolve();
      this.startHeartbeat();
      return;
    }

    const fatal = PluginFatalNotificationSchema.safeParse(message);
    if (fatal.success) {
      this.failureReason = fatal.data.params.reason;
      const fatalError =
        fatal.data.params.reason === 'protocol'
          ? new PluginHostError('PROTOCOL_ERROR', 'plugin-protocol')
          : new PluginHostError('UNAVAILABLE', fatal.data.params.reason);
      this.rejectPending(fatalError);
      const pendingReady = this.ready;
      this.ready = undefined;
      pendingReady?.reject(fatalError);
      this.stateName = 'failed';
      this.terminate(0).catch(() => undefined);
      return;
    }

    const response = PluginRpcResponseSchema.safeParse(message);
    if (!response.success) {
      this.failRuntime('protocol');
      return;
    }
    const id = String(response.data.id);
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if ('error' in response.data) {
      pending.reject(new PluginHostError('UNAVAILABLE', 'rpc-error'));
      return;
    }
    const resultBytes = serializedBytes(response.data.result);
    if (resultBytes === undefined || resultBytes > this.options.maxMessageBytes) {
      pending.reject(new PluginHostError('PROTOCOL_ERROR', 'result-too-large'));
      this.failRuntime('protocol');
      return;
    }
    pending.resolve(response.data.result);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, reason: string): void {
    if (this.exitHandled) return;
    this.exitHandled = true;
    const wasStopping = this.stateName === 'stopping';
    this.clearHandshakeTimer();
    this.clearHeartbeat();
    this.rejectPending(new PluginHostError('UNAVAILABLE', 'child-exit'));
    const pendingReady = this.ready;
    this.ready = undefined;
    pendingReady?.reject(new PluginHostError('UNAVAILABLE', 'child-exit'));
    this.child = undefined;
    this.pid = undefined;
    this.startPromise = undefined;
    if (wasStopping) {
      this.stateName = 'stopped';
      return;
    }
    if (this.stateName === 'failed') return;
    this.stateName = 'failed';
    this.failureReason = code === null ? (signal ?? reason) : reason;
    this.log('plugin.exit', { code, signal: signal ?? '', reason });
  }

  private failRuntime(reason: string): void {
    if (this.stateName === 'stopped' || this.stateName === 'stopping') return;
    this.failureReason = reason;
    this.stateName = 'failed';
    this.log('plugin.failed', { reason });
    this.terminate(0).catch(() => undefined);
  }

  private sendRequestInternal(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (child === undefined || !child.connected) return Promise.reject(new PluginHostError('PLUGIN_NOT_RUNNING'));
    if (this.pending.size >= this.options.maxPendingRequests) return Promise.reject(new PluginHostError('UNAVAILABLE', 'pending-limit'));

    const id = String(this.nextRequestId++);
    const message = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    const bytes = serializedBytes(message);
    if (bytes === undefined || bytes > this.options.maxMessageBytes) return Promise.reject(new PluginHostError('PROTOCOL_ERROR', 'request-too-large'));

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginHostError('TIMEOUT'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.send(message, error => {
        if (error === null) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(new PluginHostError('UNAVAILABLE', 'send'));
      });
    });
  }

  /** Only the two read-only probe methods are exposed by the runtime API. */
  async probe(method: PluginProbeMethod, params?: Record<string, unknown>): Promise<unknown> {
    if (!isProbeMethod(method)) throw new PluginHostError('FORBIDDEN', 'method');
    if (this.stateName !== 'running') throw new PluginHostError('PLUGIN_NOT_RUNNING');
    return this.sendRequestInternal(method, params, this.options.requestTimeoutMs);
  }

  ping(): Promise<unknown> {
    return this.probe('plugin.ping');
  }

  status(): Promise<unknown> {
    return this.probe('plugin.status');
  }

  async start(): Promise<void> {
    if (this.stateName === 'running') return;
    if (this.startPromise !== undefined) return this.startPromise;
    const promise = this.startInternal();
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const entryStats = await lstat(this.options.entryPath).catch(() => undefined);
    if (entryStats === undefined || !entryStats.isFile() || entryStats.isSymbolicLink()) {
      this.stateName = 'failed';
      this.failureReason = 'entry-missing';
      throw new PluginHostError('FORBIDDEN', 'entry');
    }

    this.stateName = 'starting';
    this.failureReason = undefined;
    this.exitHandled = false;
    this.outputBytes.stdout = 0;
    this.outputBytes.stderr = 0;
    this.outputBytes.truncated = false;

    await new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = fork(this.options.runnerPath, [], {
          cwd: this.options.pluginDir,
          env: this.childEnvironment(),
          execArgv: [],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });
      } catch {
        this.stateName = 'failed';
        this.failureReason = 'spawn-error';
        reject(new PluginHostError('UNAVAILABLE', 'spawn'));
        return;
      }
      this.child = child;
      this.attach(child);
      this.ready = { resolve, reject };
      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = undefined;
        if (this.stateName !== 'starting') return;
        this.stateName = 'failed';
        this.failureReason = 'handshake-timeout';
        this.rejectPending(new PluginHostError('TIMEOUT', 'handshake'));
        const pendingReady = this.ready;
        this.ready = undefined;
        pendingReady?.reject(new PluginHostError('TIMEOUT', 'handshake'));
        this.terminate(0).catch(() => undefined);
      }, this.options.handshakeTimeoutMs);
      this.handshakeTimer.unref?.();
    });
  }

  private async terminate(graceMs: number): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(graceMs)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(1_000)]);
    }
  }

  /** Graceful stop: shutdown RPC, then SIGTERM, then SIGKILL after the grace period. */
  async stop(graceMs = this.options.stopGraceMs): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      this.stateName = 'stopped';
      return;
    }
    const previous = this.stateName;
    this.stateName = 'stopping';
    this.clearHandshakeTimer();
    this.clearHeartbeat();

    if (previous === 'running' && child.connected) {
      try {
        await this.sendRequestInternal('plugin.shutdown', undefined, Math.min(1_000, graceMs));
      } catch {
        // A shutdown RPC failure escalates to process termination below.
      }
    }

    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, delay(graceMs)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(1_000)]);
    }

    this.rejectPending(new PluginHostError('UNAVAILABLE', 'stopped'));
    if (child.exitCode === null && child.signalCode === null) {
      this.stateName = 'failed';
      this.failureReason = 'stop-timeout';
      throw new PluginHostError('UNAVAILABLE', 'stop-timeout');
    }
    this.child = undefined;
    this.pid = undefined;
    this.stateName = 'stopped';
  }
}
