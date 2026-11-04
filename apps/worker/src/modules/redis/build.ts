/**
 * Source build for the pinned Redis release.
 *
 * Redis has no `configure` step. The build runs from the extracted tree into
 * that tree, and only `redis-server` and `redis-cli` are copied into a staging
 * prefix. No system prefix is written and no root privilege is used.
 */
import { cpus } from 'node:os';
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationAbortedError, OperationFailure, throwIfAborted } from '../../shared/operation';
import { atomicWriteFile, isInside, pathExists } from '../../shared/files';
import type { RedisLimits } from './manifest';
import { extractRedisSource } from './extract';
import { redisBuildEnvironment, runCommand, validateRedisInstallation, type CommandResult } from './run';
import type { RedisPaths } from './paths';

export interface RedisBuildInput {
  archivePath: string;
  topLevelDir: string;
  stagingRoot: string;
  finalDir: string;
  paths: RedisPaths;
  limits: RedisLimits;
  signal: AbortSignal;
  onProgress?: (stage: string, fraction: number) => void;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

export interface RedisBuildResult {
  stagedPrefix: string;
  versionOutput: string;
  cliVersionOutput: string;
  malloc: 'system' | 'libc';
}

function assertBuildStep(result: CommandResult, failureKey: string, stage: string): void {
  if (result.aborted) throw new OperationAbortedError();
  if (result.timedOut) throw new OperationFailure('TIMEOUT', failureKey, true, `${stage} timed out`);
  if (result.code !== 0) throw new OperationFailure('IO_ERROR', failureKey, false, `${stage} exit=${String(result.code)}`);
}

export async function buildRedisFromSource(input: RedisBuildInput): Promise<RedisBuildResult> {
  const { archivePath, topLevelDir, stagingRoot, finalDir, paths, limits, signal } = input;
  if (!isInside(paths.installations, finalDir)) throw new OperationFailure('FORBIDDEN', 'redis.unsafePath', false, 'prefix');
  if (!isInside(paths.staging, stagingRoot)) throw new OperationFailure('FORBIDDEN', 'redis.unsafePath', false, 'staging');
  throwIfAborted(signal);

  const env = redisBuildEnvironment(paths.home, join(stagingRoot, 'tmp'));
  const sourceRoot = join(stagingRoot, 'source');
  const stagedPrefix = join(stagingRoot, 'prefix');
  await mkdir(join(stagingRoot, 'tmp'), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });

  input.onProgress?.('redis.extract', 0.62);
  const extracted = await extractRedisSource({ archivePath, stagingDir: sourceRoot, topLevelDir, limits });
  throwIfAborted(signal);

  const jobs = String(Math.max(1, Math.min(4, cpus().length)));
  const baseArgs = [`-j${jobs}`, 'redis-server', 'redis-cli', 'BUILD_TLS=no'];
  let buildLog = '';
  const record = (result: CommandResult): void => {
    buildLog = `${buildLog}${result.stdout}${result.stderr}`.slice(-limits.maxBuildLogBytes);
  };
  const runMake = (args: string[], stage: string): Promise<CommandResult> =>
    runCommand({
      command: 'make',
      args,
      cwd: join(extracted.topLevelPath, 'src'),
      env,
      timeoutMs: limits.buildTimeoutMs,
      signal,
      killTree: true,
      maxOutputBytes: limits.maxBuildLogBytes
    }).then(result => {
      record(result);
      assertBuildStep(result, 'redis.buildFailed', stage);
      return result;
    });

  try {
    input.onProgress?.('redis.build', 0.70);
    let malloc: 'system' | 'libc' = 'system';
    try {
      await runMake(baseArgs, 'make');
    } catch (error) {
      if (!(error instanceof OperationFailure) || error.code === 'CANCELLED' || error.code === 'TIMEOUT') throw error;
      // jemalloc can fail on constrained toolchains; retry once with the libc allocator.
      input.onProgress?.('redis.build.libc', 0.76);
      input.logger?.info('redis.buildRetryLibc', { reason: error.code });
      malloc = 'libc';
      await runMake([...baseArgs, 'MALLOC=libc'], 'make MALLOC=libc');
    }
    throwIfAborted(signal);

    const builtServer = join(extracted.topLevelPath, 'src', 'redis-server');
    const builtCli = join(extracted.topLevelPath, 'src', 'redis-cli');
    if (!(await pathExists(builtServer)) || !(await pathExists(builtCli))) {
      throw new OperationFailure('IO_ERROR', 'redis.binaryMissing', false, 'src/redis-server');
    }

    input.onProgress?.('redis.validate', 0.88);
    const versions = await validateRedisInstallation(builtServer, builtCli, stagingRoot, limits.versionTimeoutMs);

    const binDir = join(stagedPrefix, 'bin');
    await mkdir(binDir, { recursive: true });
    const stagedServer = join(binDir, 'redis-server');
    const stagedCli = join(binDir, 'redis-cli');
    await copyFile(builtServer, stagedServer);
    await copyFile(builtCli, stagedCli);
    await chmod(stagedServer, 0o755);
    await chmod(stagedCli, 0o755);
    throwIfAborted(signal);
    return { stagedPrefix, versionOutput: versions.versionOutput, cliVersionOutput: versions.cliVersionOutput, malloc };
  } catch (error) {
    if (buildLog !== '') {
      await atomicWriteFile(join(paths.logs, 'build.log'), buildLog).catch(() => undefined);
    }
    if (error instanceof OperationAbortedError) throw error;
    if (error instanceof OperationFailure) throw error;
    throw new OperationFailure('UNKNOWN', 'redis.buildFailed', false);
  } finally {
    await rm(join(stagingRoot, 'tmp'), { recursive: true, force: true }).catch(() => undefined);
  }
}
