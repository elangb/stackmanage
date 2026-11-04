import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LIMITS,
  OPERATION_TIMEOUTS,
  WorkerManagementRequestSchema,
  WorkerManagementResponseSchema,
  WorkerRequestSchema,
  WorkerResponseSchema,
  parseBounded
} from '@stackmanage/core';
import type {
  ErrorCode,
  InstallRequest,
  InstanceRequest,
  LogTailRequest,
  OperationError,
  OperationEvent,
  ServiceRequest,
  SiteRemoveRequest,
  SitesApplyRequest,
  WorkerManagementMethod,
  WorkerMethodResult,
  WorkerResponse
} from '@stackmanage/core';

/**
 * Fork supervisor and typed management client.
 *
 * The renderer never sees this object: it owns the child process handle, the request IDs
 * used for correlation and the raw worker frames. A malformed or unsolicited frame is
 * ignored and can never settle a pending call.
 */

export type Terminal = { ok: true; result: WorkerMethodResult } | { ok: false; error: OperationError };
export type ProgressSink = (event: OperationEvent) => void;

/** Failure of the transport itself (child exited, frame rejected), not an operation result. */
export class WorkerCallError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string
  ) {
    super(message ?? code);
    this.name = 'WorkerCallError';
  }
}

interface PendingCall {
  readonly kind: 'call';
  readonly resolve: (value: Terminal) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onProgress: ProgressSink | undefined;
}

interface PendingHealth {
  readonly kind: 'health';
  readonly resolve: (value: WorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type Pending = PendingCall | PendingHealth;

/** Client-side deadline per method, always above the worker's own bound. */
export function timeoutFor(method: WorkerManagementMethod): number {
  switch (method) {
    case 'install':
      return OPERATION_TIMEOUTS.install + OPERATION_TIMEOUTS.read;
    case 'service.start':
    case 'service.stop':
    case 'service.restart':
      return OPERATION_TIMEOUTS.service + OPERATION_TIMEOUTS.read;
    case 'sites.apply':
    case 'sites.remove':
      return OPERATION_TIMEOUTS.sites + OPERATION_TIMEOUTS.read;
    default:
      return OPERATION_TIMEOUTS.read * 2;
  }
}

export interface WorkerClientOptions {
  readonly entry: string;
  readonly forkImpl?: typeof fork;
  readonly execArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
}

export class WorkerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private readonly healthPending = new Map<string, PendingHealth>();
  private readonly requestTimeoutMs: number;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: WorkerClientOptions) {
    const forkImpl = options.forkImpl ?? fork;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_LIMITS.requestTimeoutMs * 120;
    this.child = forkImpl(options.entry, [...(options.execArgv ?? [])], {
      env: { ...process.env, ...options.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'json'
    });
    this.child.on('message', this.onMessage);
    this.child.on('error', this.onError);
    this.child.on('exit', this.onExit);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get connected(): boolean {
    return !this.closed && this.child.connected;
  }

  private readonly onMessage = (input: unknown): void => {
    // `health` keeps its frozen v1 shape and its own pending map, so it can never settle
    // a management call and vice versa.
    const health = WorkerResponseSchema.safeParse(input);
    if (health.success) {
      const pending = this.healthPending.get(health.data.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.healthPending.delete(health.data.id);
      pending.resolve(health.data);
      return;
    }
    const parsed = WorkerManagementResponseSchema.safeParse(input);
    if (!parsed.success) return;
    const frame = parsed.data;
    const pending = this.pending.get(frame.id);
    if (pending === undefined || pending.kind !== 'call') return;
    if (frame.status === 'progress') {
      pending.onProgress?.(frame.event);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.status === 'error') pending.resolve({ ok: false, error: frame.error });
    else pending.resolve({ ok: true, result: frame.result });
  };

  health(): Promise<WorkerResponse> {
    if (!this.connected) return Promise.reject(new WorkerCallError('UNAVAILABLE'));
    if (this.size() >= DEFAULT_LIMITS.maxPendingRequests) return Promise.reject(new WorkerCallError('CONFLICT'));
    const request = WorkerRequestSchema.parse({ apiVersion: 1, id: randomUUID(), method: 'health' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.healthPending.delete(request.id);
        reject(new WorkerCallError('TIMEOUT'));
      }, OPERATION_TIMEOUTS.read);
      timer.unref?.();
      this.healthPending.set(request.id, { kind: 'health', resolve, reject, timer });
      this.child.send(request, error => {
        if (!error) return;
        const pending = this.healthPending.get(request.id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.healthPending.delete(request.id);
        pending.reject(new WorkerCallError('UNAVAILABLE'));
      });
    });
  }

  /**
   * One management call. Progress frames stream to `onProgress`; the promise settles
   * exactly once with the terminal result or typed error. A transport timeout means the
   * operation's outcome is unknown, so callers must not retry a mutation blindly.
   */
  call(method: WorkerManagementMethod, params?: unknown, onProgress?: ProgressSink): Promise<Terminal> {
    if (!this.connected) return Promise.reject(new WorkerCallError('UNAVAILABLE'));
    if (this.size() >= DEFAULT_LIMITS.maxPendingRequests) return Promise.reject(new WorkerCallError('CONFLICT'));
    const request = params === undefined ? { apiVersion: 1 as const, id: randomUUID(), method } : { apiVersion: 1 as const, id: randomUUID(), method, params };
    let id: string;
    try {
      id = parseBounded(WorkerManagementRequestSchema, request).id;
    } catch {
      return Promise.reject(new WorkerCallError('INVALID_REQUEST'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkerCallError('TIMEOUT'));
      }, Math.min(this.requestTimeoutMs, timeoutFor(method)));
      timer.unref?.();
      this.pending.set(id, { kind: 'call', resolve, reject, timer, onProgress });
      this.child.send(request, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new WorkerCallError('UNAVAILABLE'));
      });
    });
  }

  /* --------------------------- typed convenience --------------------------- */

  install(request: InstallRequest, onProgress?: ProgressSink): Promise<Terminal> {
    return this.call('install', request, onProgress);
  }

  start(request: ServiceRequest, onProgress?: ProgressSink): Promise<Terminal> {
    return this.call('service.start', request, onProgress);
  }

  stop(request: ServiceRequest, onProgress?: ProgressSink): Promise<Terminal> {
    return this.call('service.stop', request, onProgress);
  }

  restart(request: ServiceRequest, onProgress?: ProgressSink): Promise<Terminal> {
    return this.call('service.restart', request, onProgress);
  }

  status(request: InstanceRequest): Promise<Terminal> {
    return this.call('service.status', request);
  }

  listServices(): Promise<Terminal> {
    return this.call('services.list');
  }

  listInstallations(): Promise<Terminal> {
    return this.call('installations.list');
  }

  tailLogs(request: LogTailRequest): Promise<Terminal> {
    return this.call('logs.tail', request);
  }

  readConfig(request: InstanceRequest): Promise<Terminal> {
    return this.call('config.read', request);
  }

  applySites(request: SitesApplyRequest, onProgress?: ProgressSink): Promise<Terminal> {
    return this.call('sites.apply', request, onProgress);
  }

  listSites(): Promise<Terminal> {
    return this.call('sites.list');
  }

  removeSite(request: SiteRemoveRequest, onProgress?: ProgressSink): Promise<Terminal> {
    return this.call('sites.remove', request, onProgress);
  }

  /* ------------------------------- lifecycle ------------------------------- */

  private size(): number {
    return this.pending.size + this.healthPending.size;
  }

  private failPending(error: Error): void {
    for (const pending of [...this.pending.values(), ...this.healthPending.values()]) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.healthPending.clear();
  }

  private readonly onError = (): void => {
    this.closed = true;
    this.failPending(new WorkerCallError('UNAVAILABLE'));
  };

  private readonly onExit = (): void => {
    this.closed = true;
    this.failPending(new WorkerCallError('UNAVAILABLE'));
    this.child.off('message', this.onMessage);
  };

  /** Graceful disconnect, then SIGKILL, with a hard deadline on confirmation. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.failPending(new WorkerCallError('UNAVAILABLE'));
    this.closePromise = new Promise((resolve, reject) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const forceTimer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error('Worker shutdown not confirmed'));
      }, 6000);
      const cleanup = (): void => {
        clearTimeout(forceTimer);
        clearTimeout(deadline);
        this.child.off('exit', done);
        this.child.off('message', this.onMessage);
      };
      const done = (): void => {
        cleanup();
        resolve();
      };
      this.child.once('exit', done);
      if (this.child.connected) this.child.disconnect();
      else this.child.kill();
    });
    return this.closePromise;
  }
}
