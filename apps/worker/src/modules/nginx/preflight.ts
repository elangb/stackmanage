/**
 * Build-dependency preflight.
 *
 * A source build is only attempted when a C compiler, make and the PCRE2, zlib
 * and OpenSSL headers are all available. Missing prerequisites return one clear
 * actionable failure instead of a half-built or silently reduced Nginx.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationFailure, throwIfAborted } from '../../shared/operation';
import { runCommand } from './run';

export interface BuildDependencyReport {
  compiler: boolean;
  make: boolean;
  pcre2: boolean;
  zlib: boolean;
  openssl: boolean;
}

export const MISSING_DEPENDENCY_KEYS = Object.freeze({
  compiler: 'nginx.compilerMissing',
  make: 'nginx.makeMissing',
  pcre2: 'nginx.headerPcre2Missing',
  zlib: 'nginx.headerZlibMissing',
  openssl: 'nginx.headerOpenSslMissing'
} as const);

export function missingDependencyKeys(report: BuildDependencyReport): string[] {
  const keys: string[] = [];
  if (!report.compiler) keys.push(MISSING_DEPENDENCY_KEYS.compiler);
  if (!report.make) keys.push(MISSING_DEPENDENCY_KEYS.make);
  if (!report.pcre2) keys.push(MISSING_DEPENDENCY_KEYS.pcre2);
  if (!report.zlib) keys.push(MISSING_DEPENDENCY_KEYS.zlib);
  if (!report.openssl) keys.push(MISSING_DEPENDENCY_KEYS.openssl);
  return keys;
}

function compilerCommand(env: NodeJS.ProcessEnv): string {
  const cc = env['CC']?.trim();
  if (cc !== undefined && cc !== '' && /^[\w./-]+$/.test(cc)) return cc;
  return 'cc';
}

const HEADER_SOURCES: Readonly<Record<'pcre2' | 'zlib' | 'openssl', string>> = Object.freeze({
  pcre2: '#define PCRE2_CODE_UNIT_WIDTH 8\n#include <pcre2.h>\nint main(void) { return 0; }\n',
  zlib: '#include <zlib.h>\nint main(void) { return 0; }\n',
  openssl: '#include <openssl/ssl.h>\nint main(void) { return 0; }\n'
});

async function probeHeader(cc: string, scratch: string, name: keyof typeof HEADER_SOURCES, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<boolean> {
  const file = join(scratch, `${name}.c`);
  await writeFile(file, HEADER_SOURCES[name], 'utf8');
  const result = await runCommand({ command: cc, args: ['-E', file], cwd: scratch, env, timeoutMs: 10_000, signal });
  return result.code === 0 && !result.timedOut && !result.aborted;
}

export interface PreflightOptions {
  scratchBase: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

export async function checkBuildDependencies(options: PreflightOptions): Promise<BuildDependencyReport> {
  const { env, signal } = options;
  await mkdir(options.scratchBase, { recursive: true });
  const scratch = await mkdtemp(join(options.scratchBase, 'preflight-'));
  const cc = compilerCommand(env);
  try {
    throwIfAborted(signal);
    const compiler = await runCommand({ command: cc, args: ['--version'], cwd: scratch, env, timeoutMs: 10_000, signal });
    const make = await runCommand({ command: 'make', args: ['--version'], cwd: scratch, env, timeoutMs: 10_000, signal });
    const report: BuildDependencyReport = {
      compiler: compiler.code === 0 && !compiler.timedOut && !compiler.aborted,
      make: make.code === 0 && !make.timedOut && !make.aborted,
      pcre2: false,
      zlib: false,
      openssl: false
    };
    if (report.compiler) {
      report.pcre2 = await probeHeader(cc, scratch, 'pcre2', env, signal);
      report.zlib = await probeHeader(cc, scratch, 'zlib', env, signal);
      report.openssl = await probeHeader(cc, scratch, 'openssl', env, signal);
    }
    if (missingDependencyKeys(report).length > 0) {
      options.logger?.info('nginx.preflightMissing', { missing: missingDependencyKeys(report) });
    }
    return report;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function assertBuildDependencies(report: BuildDependencyReport): void {
  const missing = missingDependencyKeys(report);
  if (missing.length > 0) {
    throw new OperationFailure('UNAVAILABLE', 'nginx.dependenciesMissing', false, missing.join(','));
  }
}
