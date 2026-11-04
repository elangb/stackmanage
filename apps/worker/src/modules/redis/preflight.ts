/**
 * Build-dependency preflight.
 *
 * A source build is only attempted when a C compiler and `make` are available.
 * Missing prerequisites return one clear actionable failure instead of a
 * half-built or silently reduced Redis.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationFailure, throwIfAborted } from '../../shared/operation';
import { runCommand } from './run';

export interface BuildDependencyReport {
  compiler: boolean;
  make: boolean;
}

export const MISSING_DEPENDENCY_KEYS = Object.freeze({
  compiler: 'redis.compilerMissing',
  make: 'redis.makeMissing'
} as const);

export function missingDependencyKeys(report: BuildDependencyReport): string[] {
  const keys: string[] = [];
  if (!report.compiler) keys.push(MISSING_DEPENDENCY_KEYS.compiler);
  if (!report.make) keys.push(MISSING_DEPENDENCY_KEYS.make);
  return keys;
}

function compilerCommand(env: NodeJS.ProcessEnv): string {
  const cc = env['CC']?.trim();
  if (cc !== undefined && cc !== '' && /^[\w./-]+$/.test(cc)) return cc;
  return 'cc';
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
      make: make.code === 0 && !make.timedOut && !make.aborted
    };
    if (missingDependencyKeys(report).length > 0) {
      options.logger?.info('redis.preflightMissing', { missing: missingDependencyKeys(report) });
    }
    return report;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function assertBuildDependencies(report: BuildDependencyReport): void {
  const missing = missingDependencyKeys(report);
  if (missing.length > 0) {
    throw new OperationFailure('UNAVAILABLE', 'redis.dependenciesMissing', false, missing.join(','));
  }
}
