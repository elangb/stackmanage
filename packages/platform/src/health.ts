import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';

export type PortProbe =
  | { readonly status: 'open'; readonly host: string; readonly port: number; readonly elapsedMs: number }
  | { readonly status: 'closed'; readonly host: string; readonly port: number; readonly elapsedMs: number; readonly reason: string }
  | { readonly status: 'timeout'; readonly host: string; readonly port: number; readonly elapsedMs: number };

export const LOOPBACK = '127.0.0.1';

/**
 * Real TCP connect probe against a loopback host. A refused connection is
 * `closed` (nothing listening), which is distinct from `timeout` (unknown).
 */
export function probePort(host: string, port: number, timeoutMs = 1000): Promise<PortProbe> {
  const started = performance.now();
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (result: PortProbe, destroy: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      if (destroy) socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ status: 'open', host, port, elapsedMs: performance.now() - started }, true));
    socket.once('error', (error: NodeJS.ErrnoException) => finish({ status: 'closed', host, port, elapsedMs: performance.now() - started, reason: error.code ?? 'error' }, true));
    socket.once('timeout', () => finish({ status: 'timeout', host, port, elapsedMs: performance.now() - started }, true));
  });
}

/** Acquires a loopback ephemeral port, releases it, and returns the number. */
export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('no address assigned'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Starts a disposable loopback TCP listener owned by this test/session. */
export function startEphemeralListener(): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer(socket => socket.end());
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('no address assigned'));
        return;
      }
      const port = address.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close(error => (error ? fail(error) : done()));
          })
      });
    });
  });
}

export type StopResult =
  | { readonly status: 'stopped'; readonly pid: number; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly status: 'unknown'; readonly pid: number; readonly reason: string };

/**
 * Owns and stops a process this module spawned. Only used with a disposable
 * child created by the test; it never targets an arbitrary PID from input.
 */
export class OwnedProcess {
  private constructor(readonly pid: number, private readonly child: ReturnType<typeof spawn>) {}

  static spawn(file: string, args: readonly string[]): OwnedProcess {
    const child = spawn(file, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid === undefined) throw new Error('spawn failed without a pid');
    return new OwnedProcess(child.pid, child);
  }

  stop(timeoutMs = 5000): Promise<StopResult> {
    return new Promise(resolve => {
      if (this.child.exitCode !== null) {
        resolve({ status: 'stopped', pid: this.pid, code: this.child.exitCode, signal: null });
        return;
      }
      let settled = false;
      const finish = (result: StopResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      this.child.once('exit', (code, signal) => {
        if (code === null && signal === null) {
          finish({ status: 'unknown', pid: this.pid, reason: 'exit event without code or signal' });
          return;
        }
        finish({ status: 'stopped', pid: this.pid, code, signal });
      });
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        finish({ status: 'unknown', pid: this.pid, reason: 'graceful termination timed out; SIGKILL sent, exit not observed' });
      }, timeoutMs);
      try {
        process.kill(-this.pid, 'SIGTERM');
      } catch {
        this.child.kill('SIGTERM');
      }
    });
  }
}
