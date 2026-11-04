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
export function redisChildEnvironment(procToken: string, home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: process.env['TMPDIR'] ?? home,
    LANG: 'C',
    LC_ALL: 'C',
    STACKMANAGE_PROC_TOKEN: procToken
  };
}

/** Build environment: PATH for cc/make and no vendor credentials. */
export function redisBuildEnvironment(home: string, tempDir: string): NodeJS.ProcessEnv {
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

export function runRedisBinary(
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return runCommand({ command: binary, args, cwd, env, timeoutMs });
}

const SERVER_VERSION_PATTERN = /\bv=7\.2\.7\b/;
const CLI_VERSION_PATTERN = /^redis-cli 7\.2\.7(?:\s|$)/;

/** The real binary must report the pinned version before an install can be promoted. */
export async function validateRedisServerVersion(binary: string, home: string, timeoutMs = 10_000): Promise<string> {
  const result = await runRedisBinary(binary, ['--version'], home, timeoutMs, redisChildEnvironment('validate', home));
  const output = (result.stdout.trim() !== '' ? result.stdout : result.stderr).split('\n')[0]?.trim() ?? '';
  if (result.timedOut || result.code !== 0 || !SERVER_VERSION_PATTERN.test(output)) {
    throw new OperationFailure('IO_ERROR', 'redis.versionMismatch', false, `exit=${String(result.code)} timedOut=${result.timedOut}`);
  }
  return output.slice(0, 200);
}

export async function validateRedisCliVersion(binary: string, home: string, timeoutMs = 10_000): Promise<string> {
  const result = await runRedisBinary(binary, ['--version'], home, timeoutMs, redisChildEnvironment('validate', home));
  const output = (result.stdout.trim() !== '' ? result.stdout : result.stderr).split('\n')[0]?.trim() ?? '';
  if (result.timedOut || result.code !== 0 || !CLI_VERSION_PATTERN.test(output)) {
    throw new OperationFailure('IO_ERROR', 'redis.versionMismatch', false, `exit=${String(result.code)} timedOut=${result.timedOut}`);
  }
  return output.slice(0, 200);
}

export async function validateRedisInstallation(
  server: string,
  cli: string,
  home: string,
  timeoutMs = 10_000
): Promise<{ versionOutput: string; cliVersionOutput: string }> {
  const versionOutput = await validateRedisServerVersion(server, home, timeoutMs);
  const cliVersionOutput = await validateRedisCliVersion(cli, home, timeoutMs);
  return { versionOutput, cliVersionOutput };
}

/**
 * Readiness probe. It uses the managed `redis-cli`, not a raw socket, and only a
 * literal `PONG` reply counts as ready.
 */
export async function redisPing(
  cli: string,
  host: string,
  port: number,
  home: string,
  timeoutMs = 3000
): Promise<boolean> {
  const result = await runRedisBinary(cli, ['-h', host, '-p', String(port), 'ping'], home, timeoutMs, redisChildEnvironment('probe', home));
  return !result.timedOut && !result.aborted && result.code === 0 && result.stdout.trim() === 'PONG';
}
