import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, readFile, readlink, stat, truncate } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createConnection } from 'node:net';

/**
 * Verified process identity. A PID alone never proves ownership: the OS may
 * recycle it, so executable, start token and a per-spawn environment token must
 * all match before any kill is attempted.
 */
export interface ProcessIdentity {
  pid: number;
  /** Absolute executable path reported by the OS for this PID. */
  executable: string;
  /** Stable OS start token (Linux `/proc/<pid>/stat` field 22). */
  startToken: string;
  /** Random token injected into the child environment and persisted with the record. */
  procToken: string;
}

export type IdentityCheck =
  | { status: 'match' }
  | { status: 'gone' }
  | { status: 'mismatch'; reason: 'executable' | 'start-token' | 'proc-token' | 'unverifiable' };

function readProcStat(pid: number): Promise<string[] | undefined> {
  return readFile(`/proc/${pid}/stat`, 'utf8')
    .then(raw => {
      // Field 2 (comm) is parenthesized and may contain spaces: split after the last ')'.
      const close = raw.lastIndexOf(')');
      if (close < 0) return undefined;
      return raw.slice(close + 2).trim().split(/\s+/);
    })
    .catch(() => undefined);
}

async function readProcExe(pid: number): Promise<string | undefined> {
  return readlink(`/proc/${pid}/exe`).catch(() => undefined);
}

async function readProcEnvToken(pid: number, procToken: string): Promise<boolean | undefined> {
  return readFile(`/proc/${pid}/environ`)
    .then(buffer => buffer.toString('utf8').split('\0').includes(`STACKMANAGE_PROC_TOKEN=${procToken}`))
    .catch(() => undefined);
}

async function linuxIdentity(pid: number): Promise<{ startToken?: string; executable?: string }> {
  const [fields, executable] = await Promise.all([readProcStat(pid), readProcExe(pid)]);
  const identity: { startToken?: string; executable?: string } = {};
  const startToken = fields?.[19];
  if (startToken !== undefined) identity.startToken = startToken;
  if (executable !== undefined) identity.executable = executable;
  return identity;
}

function runCaptured(command: string, args: string[], timeoutMs = 5000): Promise<string | undefined> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (output.length < 64 * 1024) output += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      resolve(code === 0 ? output : undefined);
    });
  });
}

async function portableIdentity(pid: number): Promise<{ startToken?: string; executable?: string }> {
  if (process.platform === 'linux') return linuxIdentity(pid);
  if (process.platform === 'darwin') {
    const output = await runCaptured('ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(pid)]);
    if (output === undefined) return {};
    const match = /^(.{24})\s+(.+)$/.exec(output.trim());
    if (match === null) return {};
    const identity: { startToken?: string; executable?: string } = {};
    if (match[1] !== undefined) identity.startToken = match[1].trim();
    if (match[2] !== undefined) identity.executable = match[2].trim();
    return identity;
  }
  // Windows process identity is not implemented: callers must treat this as unverifiable.
  return {};
}

export async function isPidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function checkIdentity(expected: ProcessIdentity): Promise<IdentityCheck> {
  if (!(await isPidAlive(expected.pid))) return { status: 'gone' };
  const live = await portableIdentity(expected.pid);
  if (live.startToken === undefined || live.executable === undefined) return { status: 'mismatch', reason: 'unverifiable' };
  if (live.executable.replace(/ \(deleted\)$/, '') !== expected.executable) return { status: 'mismatch', reason: 'executable' };
  if (live.startToken !== expected.startToken) return { status: 'mismatch', reason: 'start-token' };
  if (process.platform === 'linux') {
    const tokenMatch = await readProcEnvToken(expected.pid, expected.procToken);
    if (tokenMatch !== true) return { status: 'mismatch', reason: 'proc-token' };
  }
  return { status: 'match' };
}

/** Capture identity of a freshly spawned child, retrying until /proc is populated. */
export async function captureIdentity(pid: number, procToken: string): Promise<ProcessIdentity | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const live = await portableIdentity(pid);
    if (live.startToken !== undefined && live.executable !== undefined) {
      return { pid, executable: live.executable.replace(/ \(deleted\)$/, ''), startToken: live.startToken, procToken };
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return undefined;
}

/** Append-only log with a hard byte cap; the file is truncated when the cap is reached. */
export class CappedLog {
  private size = 0;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly maxBytes: number
  ) {}

  static async open(path: string, maxBytes: number): Promise<CappedLog> {
    await mkdir(dirname(path), { recursive: true });
    const log = new CappedLog(path, maxBytes);
    const stats = await stat(path).catch(() => undefined);
    if (stats !== undefined && stats.size > maxBytes) await truncate(path, 0);
    log.size = (await stat(path).catch(() => undefined))?.size ?? 0;
    return log;
  }

  write(chunk: Buffer | string): void {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (buffer.byteLength === 0) return;
    this.chain = this.chain
      .then(async () => {
        if (this.size + buffer.byteLength > this.maxBytes) {
          await truncate(this.path, 0);
          this.size = 0;
        }
        await appendFile(this.path, buffer, { mode: 0o600 });
        this.size += buffer.byteLength;
      })
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}

export interface SpawnedProcess {
  pid: number;
  startedAt: string;
  stop(signal?: NodeJS.Signals): boolean;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStdout: (chunk: Buffer) => void;
  onStderr: (chunk: Buffer) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** Spawn with an argument array only: never a shell and never an interpolated command line. */
export async function spawnDetached(spec: SpawnSpec): Promise<SpawnedProcess> {
  await mkdir(spec.cwd, { recursive: true });
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: false,
    windowsHide: true
  });
  if (child.pid === undefined) throw new Error('spawn failed');
  child.stdout?.on('data', (chunk: Buffer) => spec.onStdout(chunk));
  child.stderr?.on('data', (chunk: Buffer) => spec.onStderr(chunk));
  child.on('error', () => spec.onExit(null, null));
  child.on('exit', (code, signal) => spec.onExit(code, signal));
  return {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stop: signal => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid!, signal ?? 'SIGTERM');
        else child.kill(signal ?? 'SIGTERM');
        return true;
      } catch {
        try {
          return child.kill(signal ?? 'SIGTERM');
        } catch {
          return false;
        }
      }
    }
  };
}

/**
 * Terminate the whole process tree and report whether it actually exited. The
 * child runs detached (own process group) so a negative PID signals the group.
 * Identity is re-verified before the forced kill; a recycled PID is never
 * signalled a second time.
 */
export async function terminateTree(
  pid: number,
  options: { graceMs: number; killMs: number; expected: ProcessIdentity; exitObserved: () => boolean }
): Promise<{ exited: boolean; forced: boolean; reason?: 'identity-mismatch' }> {
  const signal = (sig: NodeJS.Signals): void => {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        /* fall through to a single-pid signal */
      }
    }
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  };
  const verifyGone = async (): Promise<boolean> => {
    if (options.exitObserved()) return true;
    if (!(await isPidAlive(pid))) return true;
    // A live PID whose identity no longer matches is not ours: stop signalling it.
    return (await checkIdentity(options.expected)).status === 'mismatch';
  };

  signal('SIGTERM');
  if (await waitForExit(verifyGone, options.graceMs)) return { exited: true, forced: false };
  const remaining = await checkIdentity(options.expected);
  if (remaining.status === 'mismatch') return { exited: false, forced: false, reason: 'identity-mismatch' };
  signal('SIGKILL');
  const forced = await waitForExit(verifyGone, options.killMs);
  return { exited: forced, forced: true };
}

async function waitForExit(verifyGone: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await verifyGone()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

/** True when something already accepts TCP connections on host:port. */
export function isPortInUse(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** Best-effort owner of an occupied port for diagnostics only; never used for killing. */
export async function describePortOwner(port: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const output = await runCaptured('ss', ['-H', '-ltnp', `sport = :${port}`]);
    const match = output === undefined ? null : /users:\(\("([^"]+)",pid=(\d+)/.exec(output);
    return match !== null ? `${match[1]}:${match[2]}` : undefined;
  }
  if (process.platform === 'darwin') {
    const output = await runCaptured('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    const line = output?.split('\n')[1]?.trim().split(/\s+/);
    return line !== undefined && line.length > 1 ? `${line[0]}:${line[1]}` : undefined;
  }
  return undefined;
}

/** Read at most `maxBytes` from the end of a file without loading the whole log. */
export async function readLogTail(path: string, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (handle === undefined) return { text: '', bytes: 0, truncated: false };
  try {
    const stats = await handle.stat();
    const start = Math.max(0, stats.size - maxBytes);
    const length = Number(stats.size - start);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, Number(start));
    return { text: buffer.toString('utf8'), bytes: length, truncated: start > 0 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function executableExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function binaryPath(installDir: string, platform: string): string {
  return join(installDir, platform === 'win32' ? 'caddy.exe' : 'caddy');
}

export async function ensureLogDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
