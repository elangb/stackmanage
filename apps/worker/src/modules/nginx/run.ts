import { spawn } from 'node:child_process';
import { OperationFailure } from '../../shared/operation';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface CommandOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Signal the whole process group so `make` cannot leave compilers behind. */
  killTree?: boolean;
}

const DEFAULT_OUTPUT_CAP = 256 * 1024;

/**
 * Run one external command with an argument array only (never a shell), bounded
 * output, a hard deadline and optional cancellation.
 */
export function runCommand(options: CommandOptions): Promise<CommandResult> {
  const cap = options.maxOutputBytes ?? DEFAULT_OUTPUT_CAP;
  return new Promise(resolve => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: options.killTree === true && process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= cap) return current;
      return current + chunk.toString('utf8').slice(0, cap - current.length);
    };
    const signalChild = (signal: NodeJS.Signals): void => {
      try {
        if (options.killTree === true && process.platform !== 'win32') process.kill(-child.pid!, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };
    const onAbort = (): void => {
      aborted = true;
      signalChild('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalChild('SIGKILL');
    }, options.timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    child.once('error', () => finish(null));
    child.once('close', code => finish(code));
  });
}

/** Minimal child environment; never inherit unrelated secrets from the worker process. */
export function nginxChildEnvironment(procToken: string, home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: process.env['TMPDIR'] ?? home,
    LANG: 'C',
    LC_ALL: 'C',
    STACKMANAGE_PROC_TOKEN: procToken
  };
  if (process.platform === 'win32') {
    base['USERPROFILE'] = home;
    base['TEMP'] = home;
    base['TMP'] = home;
    base['SystemRoot'] = process.env['SystemRoot'] ?? 'C:\\Windows';
  }
  return base;
}

/** Build environment: PATH for cc/make and no vendor credentials. */
export function nginxBuildEnvironment(home: string, tempDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: tempDir,
    LANG: 'C',
    LC_ALL: 'C'
  };
  const cc = process.env['CC']?.trim();
  if (cc !== undefined && cc !== '' && /^[\w./-]+$/.test(cc)) env['CC'] = cc;
  return env;
}

export function runNginxBinary(
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return runCommand({ command: binary, args, cwd, env, timeoutMs });
}

const VERSION_PATTERN = /^nginx version: nginx\/1\.30\.6(?:\s|$)/;

export async function validateNginxVersion(binary: string, home: string, expectedVersion = '1.30.6', timeoutMs = 10_000): Promise<string> {
  const result = await runNginxBinary(binary, ['-v'], home, timeoutMs, nginxChildEnvironment('validate', home));
  const output = (result.stderr.trim() !== '' ? result.stderr : result.stdout).split('\n')[0]?.trim() ?? '';
  if (result.timedOut || result.code !== 0 || !VERSION_PATTERN.test(output) || !output.includes(`nginx/${expectedVersion}`)) {
    throw new OperationFailure('IO_ERROR', 'nginx.versionMismatch', false, `exit=${String(result.code)} timedOut=${result.timedOut}`);
  }
  return output.slice(0, 200);
}

/** `nginx -t` on a candidate file; the caller decides whether to promote it. */
export async function validateNginxConfig(
  binary: string,
  configPath: string,
  prefix: string,
  home: string,
  timeoutMs = 10_000
): Promise<{ output: string }> {
  const result = await runNginxBinary(binary, ['-t', '-p', prefix, '-c', configPath], home, timeoutMs, nginxChildEnvironment('validate', home));
  const output = `${result.stdout}${result.stderr}`;
  if (result.timedOut || result.code !== 0) {
    throw new OperationFailure('INVALID_REQUEST', 'nginx.configInvalid', false, `exit=${String(result.code)} ${output.slice(-1000)}`);
  }
  return { output: output.slice(0, 1024) };
}
