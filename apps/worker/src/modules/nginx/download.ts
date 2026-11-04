/**
 * HTTPS download/receipt helper for the official Nginx artifacts.
 *
 * - Only `nginx.org` is accepted, at the initial URL and at every redirect hop.
 * - Redirect count, total bytes and idle time are hard-bounded.
 * - Resume uses a `.part` file; a server that ignores `Range` restarts cleanly.
 * - The archive is verified with its pinned SHA-256 before it can be promoted.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { OperationAbortedError, OperationFailure, throwIfAborted } from '../../shared/operation';
import type { NginxLimits } from './manifest';
import { nativeFetch } from './native-fetch';

export interface NginxDownloadOptions {
  url: string;
  destination: string;
  expectedDigest: string;
  limits: NginxLimits;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  onProgress?: (received: number, total: number | undefined) => void;
}

export interface NginxTextOptions {
  url: string;
  limits: NginxLimits;
  maxBytes?: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

const ALLOWED_HOST = 'nginx.org';
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_TEXT_LIMIT = 128 * 1024;

function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OperationFailure('INVALID_REQUEST', 'nginx.invalidUrl', false);
  }
  if (url.protocol !== 'https:') throw new OperationFailure('INVALID_REQUEST', 'nginx.insecureUrl', false);
  if (url.hostname.toLowerCase() !== ALLOWED_HOST) throw new OperationFailure('INVALID_REQUEST', 'nginx.invalidUrl', false);
  return url;
}

async function openStream(
  options: { url: string; limits: NginxLimits; signal: AbortSignal; fetchImpl?: typeof fetch },
  offset: number
): Promise<{ response: Response; url: string }> {
  const { limits, signal } = options;
  const doFetch = options.fetchImpl ?? nativeFetch;
  let current = assertAllowedUrl(options.url).toString();
  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    throwIfAborted(signal);
    const headers: Record<string, string> = { 'user-agent': 'StackManage/1' };
    if (offset > 0) headers['range'] = `bytes=${offset}-`;
    let response: Response;
    try {
      response = await doFetch(current, options.fetchImpl === undefined ? { method: 'GET', headers, signal } : { method: 'GET', redirect: 'manual', headers, signal });
    } catch (error) {
      if (signal.aborted) throw new OperationAbortedError();
      throw new OperationFailure('IO_ERROR', 'nginx.downloadFailed', true, error instanceof Error ? error.message : 'fetch failed');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (location === null || location === '') throw new OperationFailure('IO_ERROR', 'nginx.downloadFailed', true, 'redirect without location');
      current = assertAllowedUrl(new URL(location, current).toString()).toString();
      continue;
    }
    if (response.status === 416 && offset > 0) {
      await response.body?.cancel().catch(() => undefined);
      return openStream(options, 0);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OperationFailure('IO_ERROR', 'nginx.downloadFailed', response.status >= 500 || response.status === 429, `http=${response.status}`);
    }
    return { response, url: current };
  }
  throw new OperationFailure('IO_ERROR', 'nginx.downloadFailed', false, 'too many redirects');
}

async function consume(
  body: ReadableStream<Uint8Array>,
  options: NginxDownloadOptions,
  filePath: string,
  offset: number,
  total: number | undefined
): Promise<number> {
  const { limits, signal } = options;
  const controller = new AbortController();
  let idle: NodeJS.Timeout | undefined;
  const armIdle = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error('idle')), limits.idleTimeoutMs);
    idle.unref?.();
  };
  const onAbort = (): void => controller.abort(new OperationAbortedError());
  signal.addEventListener('abort', onAbort, { once: true });
  const handle = await open(filePath, 'r+');
  let received = offset;
  let position = offset;
  try {
    await handle.truncate(offset);
    const reader = body.getReader();
    armIdle();
    for (;;) {
      if (controller.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw controller.signal.reason instanceof Error ? controller.signal.reason : new OperationAbortedError();
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      armIdle();
      received += chunk.value.byteLength;
      if (received > limits.maxDownloadBytes || (total !== undefined && received > total)) {
        await reader.cancel().catch(() => undefined);
        throw new OperationFailure('IO_ERROR', 'nginx.downloadTooLarge', false);
      }
      await handle.write(chunk.value, 0, chunk.value.byteLength, position);
      position += chunk.value.byteLength;
      options.onProgress?.(received, total);
    }
    return received;
  } finally {
    if (idle !== undefined) clearTimeout(idle);
    signal.removeEventListener('abort', onAbort);
    await handle.close().catch(() => undefined);
  }
}

/** One bounded retry for a transient connection failure before any bytes are accepted. */
async function openWithRetry(
  options: { url: string; limits: NginxLimits; signal: AbortSignal; fetchImpl?: typeof fetch },
  offset: number
): Promise<{ response: Response; url: string }> {
  try {
    return await openStream(options, offset);
  } catch (error) {
    if (options.signal.aborted) throw new OperationAbortedError();
    if (error instanceof OperationFailure && error.retryable) {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (options.signal.aborted) throw new OperationAbortedError();
      return openStream(options, offset);
    }
    throw error;
  }
}

/** Download, resume, and verify `destination`; throws rather than leaving an unverified file. */
export async function downloadVerified(options: NginxDownloadOptions): Promise<{ bytes: number; resumed: boolean }> {
  if (!HEX_SHA256.test(options.expectedDigest)) throw new OperationFailure('INVALID_REQUEST', 'nginx.invalidDigest', false);
  const partial = `${options.destination}.part`;
  await mkdir(dirname(options.destination), { recursive: true });
  // Never follow a pre-existing link at a managed path.
  for (const candidate of [partial, options.destination]) {
    const existing = await lstat(candidate).catch(() => undefined);
    if (existing?.isSymbolicLink() === true) throw new OperationFailure('IO_ERROR', 'nginx.unsafeEntry', false, 'link');
  }
  throwIfAborted(options.signal);

  const partialSize = await stat(partial)
    .then(stats => stats.size)
    .catch(() => 0);
  const offset = partialSize > options.limits.maxDownloadBytes ? 0 : partialSize;
  if (offset === 0 && partialSize > 0) await rm(partial, { force: true });

  const opened = await openWithRetry(options, offset);
  const { response } = opened;
  const status = response.status;
  const resume = status === 206 && offset > 0;
  if (status === 206 && !resume) {
    await response.body?.cancel().catch(() => undefined);
    throw new OperationFailure('IO_ERROR', 'nginx.downloadFailed', true, 'unexpected partial response');
  }
  const lengthHeader = response.headers.get('content-length');
  const length = lengthHeader !== null && lengthHeader !== '' ? Number.parseInt(lengthHeader, 10) : Number.NaN;
  const total = Number.isFinite(length) && length > 0 ? (resume ? length + offset : length) : undefined;
  if (total !== undefined && total > options.limits.maxDownloadBytes) {
    await rm(partial, { force: true });
    throw new OperationFailure('IO_ERROR', 'nginx.downloadTooLarge', false);
  }
  if (response.body === null) throw new OperationFailure('IO_ERROR', 'nginx.downloadFailed', true, 'empty body');
  if (!resume) await writeFile(partial, '');

  const startOffset = resume ? offset : 0;
  const bytes = await consume(response.body, options, partial, startOffset, total);
  throwIfAborted(options.signal);

  const digest = await fileDigest(partial);
  if (digest === undefined || !isDigestEqual(digest, options.expectedDigest)) {
    await rm(partial, { force: true });
    options.logger?.info('nginx.digestMismatch', {
      expected: options.expectedDigest.slice(0, 12),
      actual: (digest ?? 'missing').slice(0, 12)
    });
    throw new OperationFailure('IO_ERROR', 'nginx.digestMismatch', true);
  }
  await rename(partial, options.destination);
  return { bytes, resumed: resume };
}

/** Bounded official text read (detached signature); never written to disk by this helper. */
export async function downloadText(options: NginxTextOptions): Promise<string> {
  const max = options.maxBytes ?? DEFAULT_TEXT_LIMIT;
  // Signatures are supplementary evidence; do not let a slow request stall a build indefinitely.
  const idle = AbortSignal.timeout(options.limits.idleTimeoutMs);
  const signal = AbortSignal.any([options.signal, idle]);
  const { response } = await openStream({ ...options, signal }, 0);
  if (response.body === null) throw new OperationFailure('IO_ERROR', 'nginx.downloadFailed', true, 'empty body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > max) {
      await reader.cancel().catch(() => undefined);
      throw new OperationFailure('IO_ERROR', 'nginx.downloadTooLarge', false);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isDigestEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Digest of a file, or `undefined` when it does not exist. Never throws for ENOENT. */
export async function fileDigest(path: string): Promise<string | undefined> {
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  const hash = createHash('sha256');
  const stream: Readable = createReadStream(path);
  await new Promise<void>((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
