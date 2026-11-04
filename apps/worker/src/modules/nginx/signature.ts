/**
 * Detached-signature verification for the pinned Nginx artifacts.
 *
 * nginx.org does not publish a SHA-256 sidecar; it publishes `.asc` signatures.
 * The upstream public key is pinned by fingerprint and embedded as public data.
 * When `gpg` is unavailable the required SHA-256 pin still applies and the
 * signature becomes a warning, never a silent success claim.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationAbortedError, OperationFailure, throwIfAborted } from '../../shared/operation';
import { downloadText } from './download';
import { NGINX_SIGNING_KEY_ARMOR, NGINX_SIGNING_KEY_FINGERPRINT, type NginxLimits } from './manifest';
import { nginxBuildEnvironment, runCommand } from './run';

export type SignatureOutcome =
  | { status: 'verified'; fingerprint: string }
  | { status: 'unavailable'; reason: 'gpg-missing' | 'signature-unavailable' | 'key-import-failed' };

export interface VerifySignatureOptions {
  archivePath: string;
  signatureUrl: string;
  stagingBase: string;
  limits: NginxLimits;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

export async function verifyNginxSignature(options: VerifySignatureOptions): Promise<SignatureOutcome> {
  const { signal, limits } = options;
  throwIfAborted(signal);
  const env = nginxBuildEnvironment(options.stagingBase, options.stagingBase);
  const gpg = await runCommand({ command: 'gpg', args: ['--version'], cwd: options.stagingBase, env, timeoutMs: 10_000, signal });
  if (gpg.code !== 0 || gpg.timedOut) return { status: 'unavailable', reason: 'gpg-missing' };

  let armored: string;
  try {
    armored = await downloadText({
      url: options.signatureUrl,
      limits,
      signal,
      maxBytes: 64 * 1024,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {})
    });
  } catch (error) {
    if (signal.aborted || error instanceof OperationAbortedError) throw new OperationAbortedError();
    return { status: 'unavailable', reason: 'signature-unavailable' };
  }
  if (!armored.includes('BEGIN PGP SIGNATURE')) return { status: 'unavailable', reason: 'signature-unavailable' };

  await mkdir(options.stagingBase, { recursive: true });
  const home = await mkdtemp(join(options.stagingBase, 'gpg-'));
  await chmod(home, 0o700).catch(() => undefined);
  try {
    const keyPath = join(home, 'nginx-signing-key.asc');
    const signaturePath = join(home, 'artifact.asc');
    await writeFile(keyPath, NGINX_SIGNING_KEY_ARMOR, { mode: 0o600 });
    await writeFile(signaturePath, armored, { mode: 0o600 });
    const imported = await runCommand({
      command: 'gpg',
      args: ['--homedir', home, '--batch', '--no-tty', '--import', keyPath],
      cwd: home,
      env,
      timeoutMs: 15_000,
      signal,
      maxOutputBytes: 64 * 1024
    });
    if (imported.code !== 0 || imported.timedOut) return { status: 'unavailable', reason: 'key-import-failed' };

    const verified = await runCommand({
      command: 'gpg',
      args: ['--homedir', home, '--batch', '--no-tty', '--status-fd=1', '--verify', signaturePath, options.archivePath],
      cwd: home,
      env,
      timeoutMs: 20_000,
      signal,
      maxOutputBytes: 64 * 1024
    });
    throwIfAborted(signal);
    const statusLines = `${verified.stdout}\n${verified.stderr}`;
    const valid = statusLines.split('\n').find(line => line.includes('[GNUPG:] VALIDSIG '));
    const fingerprint = valid?.split('[GNUPG:] VALIDSIG ')[1]?.split(' ')[0]?.toUpperCase();
    if (verified.code !== 0 || fingerprint === undefined) {
      options.logger?.info('nginx.signatureInvalid', { exit: verified.code });
      throw new OperationFailure('IO_ERROR', 'nginx.signatureInvalid', false);
    }
    if (fingerprint !== NGINX_SIGNING_KEY_FINGERPRINT) {
      options.logger?.info('nginx.signatureKeyMismatch', { actual: fingerprint.slice(0, 16) });
      throw new OperationFailure('IO_ERROR', 'nginx.signatureKeyMismatch', false);
    }
    return { status: 'verified', fingerprint };
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}
