import { readFile, readlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { PersistedProcess } from './state.js';

export type IdentityStatus =
  | { readonly status: 'match' }
  | { readonly status: 'gone' }
  | { readonly status: 'mismatch'; readonly reason: 'executable' | 'start-token' | 'proc-token' | 'unverifiable' };

async function isAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function linuxIdentity(pid: number): Promise<{ startToken?: string; executable?: string }> {
  let startToken: string | undefined;
  let executable: string | undefined;
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close >= 0) startToken = raw.slice(close + 2).trim().split(/\s+/)[19];
  } catch {
    /* unverifiable */
  }
  try {
    executable = (await readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '');
  } catch {
    /* unverifiable */
  }
  return {
    ...(startToken !== undefined ? { startToken } : {}),
    ...(executable !== undefined ? { executable } : {})
  };
}

async function procTokenMatches(pid: number, token: string): Promise<boolean | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`);
    return raw.toString('utf8').split('\u0000').includes(`STACKMANAGE_PROC_TOKEN=${token}`);
  } catch {
    return undefined;
  }
}

/**
 * Read-only process identity check. A live PID is not proof of ownership:
 * Linux requires executable, OS start token and the persisted environment token
 * to match. Other platforms expose only liveness, so they remain unverifiable.
 */
export async function inspectProcess(expected: PersistedProcess): Promise<IdentityStatus> {
  if (!(await isAlive(expected.pid))) return { status: 'gone' };
  if (process.platform !== 'linux') return { status: 'mismatch', reason: 'unverifiable' };
  const live = await linuxIdentity(expected.pid);
  if (live.executable === undefined || live.startToken === undefined) return { status: 'mismatch', reason: 'unverifiable' };
  if (live.executable !== expected.executable.replace(/ \(deleted\)$/, '')) return { status: 'mismatch', reason: 'executable' };
  if (live.startToken !== expected.startToken) return { status: 'mismatch', reason: 'start-token' };
  const token = await procTokenMatches(expected.pid, expected.procToken);
  if (token !== true) return { status: 'mismatch', reason: token === false ? 'proc-token' : 'unverifiable' };
  return { status: 'match' };
}

/** Loopback readiness probe. This never binds a listener. */
export function probeLoopback(port: number, timeoutMs = 350): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
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
