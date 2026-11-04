import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS, parseBounded, WorkerRequestSchema, WorkerResponseSchema } from '@stackmanage/core';
import type { WorkerResponse } from '@stackmanage/core';

type Pending = { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Main-process owner. Never expose this class or child-process handles to renderer. */
export class WorkerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(entry: string, private readonly timeoutMs = DEFAULT_LIMITS.requestTimeoutMs) {
    this.child = fork(entry, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'json' });
    this.child.on('message', this.onMessage);
    this.child.on('error', this.onError);
    this.child.on('exit', this.onExit);
  }

  private readonly onMessage = (input: unknown): void => {
    let response: WorkerResponse;
    try { response = parseBounded(WorkerResponseSchema, input); } catch { return; }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  };
  private failPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private readonly onError = (): void => { this.closed = true; this.failPending(new Error('UNAVAILABLE')); };
  private readonly onExit = (): void => {
    this.closed = true;
    this.failPending(new Error('UNAVAILABLE'));
    this.child.off('message', this.onMessage);
  };

  health(): Promise<WorkerResponse> {
    if (this.closed || !this.child.connected) return Promise.reject(new Error('UNAVAILABLE'));
    if (this.pending.size >= DEFAULT_LIMITS.maxPendingRequests) return Promise.reject(new Error('CONFLICT'));
    const request = WorkerRequestSchema.parse({ apiVersion: 1, id: randomUUID(), method: 'health' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request.id); reject(new Error('TIMEOUT')); }, this.timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      this.child.send(request, error => {
        if (!error) return;
        const pending = this.pending.get(request.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(request.id);
        pending.reject(new Error('UNAVAILABLE'));
      });
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.failPending(new Error('UNAVAILABLE'));
    this.closePromise = new Promise((resolve, reject) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) { resolve(); return; }
      const forceTimer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
      const deadline = setTimeout(() => { cleanup(); reject(new Error('Worker shutdown not confirmed')); }, 3000);
      const cleanup = (): void => {
        clearTimeout(forceTimer); clearTimeout(deadline);
        this.child.off('exit', done);
        this.child.off('message', this.onMessage);
      };
      const done = (): void => { cleanup(); resolve(); };
      this.child.once('exit', done);
      if (this.child.connected) this.child.disconnect();
      else this.child.kill();
    });
    return this.closePromise;
  }
}
