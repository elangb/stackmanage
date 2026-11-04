/**
 * Source build for the pinned Nginx release.
 *
 * The configure prefix is the final per-user directory, while `make install`
 * writes through `DESTDIR` into staging. That keeps the compiled-in absolute
 * paths valid after an atomic rename and never touches a system prefix or
 * requires root.
 */
import { cpus } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationAbortedError, OperationFailure, throwIfAborted } from '../../shared/operation';
import { atomicWriteFile, isInside, pathExists } from '../../shared/files';
import { renderNginxConfig } from './config';
import { DEFAULT_HOSTNAME, DEFAULT_SITE_PORT, type NginxLimits } from './manifest';
import { extractNginxSource } from './extract';
import { nginxBuildEnvironment, runCommand, validateNginxConfig, validateNginxVersion, type CommandResult } from './run';
import type { NginxPaths } from './paths';

export interface NginxBuildInput {
  archivePath: string;
  topLevelDir: string;
  stagingRoot: string;
  finalDir: string;
  paths: NginxPaths;
  limits: NginxLimits;
  signal: AbortSignal;
  onProgress?: (stage: string, fraction: number) => void;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

export interface NginxBuildResult {
  stagedPrefix: string;
  versionOutput: string;
}

function configureArgs(finalDir: string, paths: NginxPaths): string[] {
  return [
    `--prefix=${finalDir}`,
    `--sbin-path=${finalDir}/sbin/nginx`,
    `--conf-path=${finalDir}/conf/nginx.conf`,
    `--pid-path=${paths.logs}/nginx.pid`,
    `--lock-path=${paths.logs}/nginx.lock`,
    `--error-log-path=${paths.logs}/error.log`,
    `--http-log-path=${paths.logs}/access.log`,
    `--http-client-body-temp-path=${paths.tmp}/client_body`,
    `--http-proxy-temp-path=${paths.tmp}/proxy`,
    `--http-fastcgi-temp-path=${paths.tmp}/fastcgi`,
    `--http-uwsgi-temp-path=${paths.tmp}/uwsgi`,
    `--http-scgi-temp-path=${paths.tmp}/scgi`,
    '--with-http_ssl_module',
    '--with-http_v2_module'
  ];
}

function assertBuildStep(result: CommandResult, failureKey: string, stage: string): void {
  if (result.aborted) throw new OperationAbortedError();
  if (result.timedOut) throw new OperationFailure('TIMEOUT', failureKey, true, `${stage} timed out`);
  if (result.code !== 0) throw new OperationFailure('IO_ERROR', failureKey, false, `${stage} exit=${String(result.code)}`);
}

export async function buildNginxFromSource(input: NginxBuildInput): Promise<NginxBuildResult> {
  const { archivePath, topLevelDir, stagingRoot, finalDir, paths, limits, signal } = input;
  if (!isInside(paths.installations, finalDir)) throw new OperationFailure('FORBIDDEN', 'nginx.unsafePath', false, 'prefix');
  if (!isInside(paths.staging, stagingRoot)) throw new OperationFailure('FORBIDDEN', 'nginx.unsafePath', false, 'staging');
  throwIfAborted(signal);

  const env = nginxBuildEnvironment(paths.home, join(stagingRoot, 'tmp'));
  const sourceRoot = join(stagingRoot, 'source');
  const destRoot = join(stagingRoot, 'root');
  await mkdir(join(stagingRoot, 'tmp'), { recursive: true });
  await mkdir(sourceRoot, { recursive: true });

  input.onProgress?.('nginx.extract', 0.62);
  const extracted = await extractNginxSource({ archivePath, stagingDir: sourceRoot, topLevelDir, limits });
  throwIfAborted(signal);

  let buildLog = '';
  const record = (result: CommandResult): void => {
    buildLog = `${buildLog}${result.stdout}${result.stderr}`.slice(-limits.maxBuildLogBytes);
  };

  try {
    input.onProgress?.('nginx.configure', 0.68);
    const configure = await runCommand({
      command: 'sh',
      args: [join(extracted.topLevelPath, 'configure'), ...configureArgs(finalDir, paths)],
      cwd: extracted.topLevelPath,
      env,
      timeoutMs: limits.buildTimeoutMs,
      signal,
      killTree: true,
      maxOutputBytes: limits.maxBuildLogBytes
    });
    record(configure);
    assertBuildStep(configure, 'nginx.configureFailed', 'configure');

    input.onProgress?.('nginx.build', 0.76);
    const jobs = Math.max(1, Math.min(4, cpus().length));
    const make = await runCommand({
      command: 'make',
      args: [`-j${jobs}`],
      cwd: extracted.topLevelPath,
      env,
      timeoutMs: limits.buildTimeoutMs,
      signal,
      killTree: true,
      maxOutputBytes: limits.maxBuildLogBytes
    });
    record(make);
    assertBuildStep(make, 'nginx.buildFailed', 'make');

    input.onProgress?.('nginx.install', 0.86);
    const install = await runCommand({
      command: 'make',
      args: ['install', `DESTDIR=${destRoot}`],
      cwd: extracted.topLevelPath,
      env,
      timeoutMs: limits.buildTimeoutMs,
      signal,
      killTree: true,
      maxOutputBytes: limits.maxBuildLogBytes
    });
    record(install);
    assertBuildStep(install, 'nginx.installFailed', 'make install');

    // DESTDIR is a literal prefix, including the absolute install path.
    const stagedPrefix = `${destRoot}${finalDir}`;
    const stagedBinary = join(stagedPrefix, 'sbin', 'nginx');
    if (!(await pathExists(stagedBinary))) throw new OperationFailure('IO_ERROR', 'nginx.binaryMissing', false, 'sbin/nginx');

    input.onProgress?.('nginx.validate', 0.92);
    const versionOutput = await validateNginxVersion(stagedBinary, stagingRoot, '1.30.6', limits.versionTimeoutMs);

    const stagedService = join(stagingRoot, 'service');
    const stagedConfig = join(stagedService, 'conf', 'nginx.conf');
    await mkdir(join(stagedService, 'conf'), { recursive: true });
    await mkdir(join(stagedService, 'logs'), { recursive: true });
    await mkdir(join(stagedService, 'tmp'), { recursive: true });
    await mkdir(join(stagedService, 'sites', 'default'), { recursive: true });
    await atomicWriteFile(
      stagedConfig,
      renderNginxConfig({
        installDir: stagedPrefix,
        pidPath: join(stagedService, 'logs', 'nginx.pid'),
        errorLogPath: join(stagedService, 'logs', 'error.log'),
        accessLogPath: join(stagedService, 'logs', 'access.log'),
        tempDir: join(stagedService, 'tmp'),
        root: join(stagedService, 'sites', 'default'),
        port: DEFAULT_SITE_PORT,
        hostname: DEFAULT_HOSTNAME
      })
    );
    await validateNginxConfig(stagedBinary, stagedConfig, stagedPrefix, stagingRoot, limits.configTimeoutMs);
    throwIfAborted(signal);
    return { stagedPrefix, versionOutput };
  } catch (error) {
    if (buildLog !== '') {
      await atomicWriteFile(join(paths.logs, 'build.log'), buildLog).catch(() => undefined);
    }
    if (error instanceof OperationAbortedError) throw error;
    if (error instanceof OperationFailure) throw error;
    throw new OperationFailure('UNKNOWN', 'nginx.buildFailed', false);
  } finally {
    await rm(join(stagingRoot, 'tmp'), { recursive: true, force: true }).catch(() => undefined);
  }
}
