import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type { CommandSpec, ProcessRunner, RunOptions, RunResult } from './command.js';

/** Upper bound for captured output. Excess output is truncated, never buffered without limit. */
export const MAX_CAPTURE_BYTES = 256 * 1024;

async function executableAt(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function createLinuxRunner(env: Readonly<Record<string, string | undefined>>): ProcessRunner {
  const which = async (file: string): Promise<string | undefined> => {
    if (file.includes('/') || file.includes('\\') || file.includes('\0')) return undefined;
    for (const entry of (env.PATH ?? '').split(delimiter)) {
      if (entry.trim().length === 0) continue;
      const candidate = join(entry, file);
      if (await executableAt(candidate)) return candidate;
    }
    return undefined;
  };

  const run = (command: CommandSpec, options: RunOptions): Promise<RunResult> =>
    new Promise(resolve => {
      if (options.signal?.aborted) {
        resolve({ ok: false, reason: 'aborted', stdout: '', stderr: '', timedOut: false });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const child = spawn(command.file, [...command.args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: {}, detached: true });
      /** Kills the spawned process *group* so grandchildren cannot keep the pipes open. */
      const terminate = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
      const onAbort = (): void => {
        terminate();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString('utf8').slice(0, MAX_CAPTURE_BYTES - stdout.length);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString('utf8').slice(0, MAX_CAPTURE_BYTES - stderr.length);
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        const reason = error.code === 'ENOENT' ? 'missing' : error.code === 'EACCES' ? 'permission' : 'failed';
        finish({ ok: false, reason, stdout, stderr, timedOut: false });
      });
      child.on('close', (code, signal) => {
        // A large timeout can race with a late abort; the earlier cause wins.
        if (options.signal?.aborted && !timedOut) {
          finish({ ok: false, reason: 'aborted', stdout, stderr, timedOut: false });
          return;
        }
        if (timedOut) {
          finish({ ok: false, reason: 'timeout', stdout, stderr, timedOut: true, ...(code === null ? {} : { code }) });
          return;
        }
        if (code === null) {
          finish({ ok: false, reason: 'failed', stdout, stderr: `${stderr}${signal ? `terminated by ${signal}` : ''}`, timedOut: false });
          return;
        }
        finish({ ok: true, code, stdout, stderr, timedOut: false });
      });
      if (options.stdin !== undefined) {
        child.stdin.end(options.stdin);
      } else {
        child.stdin.end();
      }
    });

  return { which, run };
}
