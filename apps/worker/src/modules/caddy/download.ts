/**
 * Streaming HTTPS download with resume, hard caps, and digest verification.
 *
 * - Redirects are followed manually so the hop count is bounded.
 * - The byte count is capped by `limits.maxDownloadBytes`; oversize aborts.
 * - An idle timeout aborts a stalled stream instead of hanging the operation.
 * - `Range` resume is attempted from a `.part` file; a `200` answer to our
 *   `Range` request means the server ignored it, so the file restarts cleanly.
 * - SHA256 is verified before the archive is promoted into place.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm, stat, truncate } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { OperationAbortedError, OperationFailure, throwIfAborted, type OperationalLimits } from './manifest';

export interface DownloadOptions {
  url: string;
  destination: string;
  expectedSha256: string;
  limits: OperationalLimits;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  onProgress?: (received: number, total: number | undefined) => void;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const ALLOWED_HOST = 'github.com';
const ALLOWED_REDIRECT_SUFFIX = '.githubusercontent.com';

function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OperationFailure('INVALID_REQUEST', 'install.invalidUrl', false);
  }
  if (url.protocol !== 'https:') throw new OperationFailure('INVALID_REQUEST', 'install.insecureUrl', false);
  const host = url.hostname.toLowerCase();
  if (host !== ALLOWED_HOST && host !== 'objects.githubusercontent.com' && !host.endsWith(ALLOWED_REDIRECT_SUFFIX)) {
    throw new OperationFailure('INVALID_REQUEST', 'install.invalidUrl', false);
  }
  return url;
}

/** Follow redirects manually, bounded by `maxRedirects`, HTTPS-only at every hop. */
async function openStream(options: DownloadOptions, offset: number): Promise<{ response: Response; url: string }> {
  const { limits, signal } = options;
  const doFetch = options.fetchImpl ?? fetch;
  let current = assertAllowedUrl(options.url).toString();
  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    throwIfAborted(signal);
    const headers: Record<string, string> = { 'user-agent': 'StackManage/1' };
    if (offset > 0) headers['range'] = `bytes=${offset}-`;
    const response = await doFetch(current, { method: 'GET', redirect: 'manual', headers, signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (location === null || location === '') throw new OperationFailure('IO_ERROR', 'install.downloadFailed', true, 'redirect without location');
      current = assertAllowedUrl(new URL(location, current).toString()).toString();
      continue;
    }
    if (response.status === 416 && offset > 0) {
      // Stale partial file: drop it and retry from zero once.
      await response.body?.cancel().catch(() => undefined);
      return openStream({ ...options, url: current }, 0);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OperationFailure('IO_ERROR', 'install.downloadFailed', response.status >= 500 || response.status === 429, `http=${response.status}`);
    }
    return { response, url: current };
  }
  throw new OperationFailure('IO_ERROR', 'install.downloadFailed', false, 'too many redirects');
}

async function consume(
  body: ReadableStream<Uint8Array>,
  options: DownloadOptions,
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
        throw new OperationFailure('IO_ERROR', 'install.downloadTooLarge', false);
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

/** Download, resume, and verify `destination`; throws rather than leaving an unverified file. */
export async function downloadVerified(options: DownloadOptions): Promise<{ bytes: number; resumed: boolean }> {
  if (!SHA256_HEX.test(options.expectedSha256)) throw new OperationFailure('INVALID_REQUEST', 'install.invalidDigest', false);
  const partial = `${options.destination}.part`;
  await mkdir(dirname(options.destination), { recursive: true });
  throwIfAborted(options.signal);

  let offset = 0;
  try {
    offset = (await stat(partial)).size;
  } catch {
    offset = 0;
  }
  if (offset > options.limits.maxDownloadBytes) {
    await rm(partial, { force: true });
    offset = 0;
  }

  const { response } = await openStream(options, offset);
  const status = response.status;
  // A 206 continues the partial file; anything else rewrites it from zero.
  const resume = status === 206 && offset > 0;
  if (status === 206 && !resume) {
    await response.body?.cancel().catch(() => undefined);
    throw new OperationFailure('IO_ERROR', 'install.downloadFailed', true, 'unexpected partial response');
  }
  const lengthHeader = response.headers.get('content-length');
  const length = lengthHeader !== null && lengthHeader !== '' ? Number.parseInt(lengthHeader, 10) : Number.NaN;
  const total = Number.isFinite(length) && length > 0 ? (resume ? length + offset : length) : undefined;
  if (total !== undefined && total > options.limits.maxDownloadBytes) {
    await rm(partial, { force: true });
    throw new OperationFailure('IO_ERROR', 'install.downloadTooLarge', false);
  }
  if (response.body === null) throw new OperationFailure('IO_ERROR', 'install.downloadFailed', true, 'empty body');
  if (!resume) await truncate(partial, 0).catch(async () => rm(partial, { force: true }));

  const startOffset = resume ? offset : 0;
  const bytes = await consume(response.body, options, partial, startOffset, total);
  throwIfAborted(options.signal);

  const digest = await fileDigest(partial);
  if (digest === undefined || !isDigestEqual(digest, options.expectedSha256)) {
    await rm(partial, { force: true });
    options.logger?.info('install.digestMismatch', {
      expected: options.expectedSha256.slice(0, 12),
      actual: (digest ?? 'missing').slice(0, 12)
    });
    throw new OperationFailure('IO_ERROR', 'install.digestMismatch', true);
  }
  await rename(partial, options.destination);
  return { bytes, resumed: resume };
}

function isDigestEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** SHA256 of a file, or `undefined` when it does not exist. Never throws for ENOENT. */
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
