import { spawn } from 'node:child_process';

export interface NodeVersionProbe {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Execute the installed runtime with a fixed argument array; no shell, bounded output. */
export function runNodeBinary(
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<NodeVersionProbe> {
  return new Promise(resolve => {
    const child = spawn(binary, [...args], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 8192) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.once('error', () => finish(null));
    child.once('close', code => finish(code));
  });
}

/** Minimal child environment: never inherit unrelated secrets from the worker process. */
export function nodeChildEnvironment(home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: process.env['TMPDIR'] ?? home
  };
  if (process.platform === 'win32') {
    base['USERPROFILE'] = home;
    base['TEMP'] = home;
    base['TMP'] = home;
    base['SystemRoot'] = process.env['SystemRoot'] ?? 'C:\\Windows';
  }
  return base;
}

/** Exact pinned output (`v24.22.2`), not a prefix match. */
export async function validateNodeVersion(binary: string, home: string, timeoutMs: number, expectedVersion: string): Promise<string> {
  const result = await runNodeBinary(binary, ['--version'], home, timeoutMs, nodeChildEnvironment(home));
  const output = result.stdout.trim();
  if (result.timedOut || result.code !== 0 || output !== `v${expectedVersion}`) {
    throw new Error(`node --version mismatch exit=${String(result.code)} timedOut=${result.timedOut}`);
  }
  return output;
}
