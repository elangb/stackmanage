/**
 * Small URL/headers subset of fetch backed by node:https.
 *
 * Node's built-in fetch ignores HTTP(S)_PROXY in this runtime, and undici's
 * proxy dispatcher is not compatible with the bundled fetch. `https-proxy-agent`
 * works with the native agent API and is used only for the pinned HTTPS
 * vendor host. Tests still inject a fetch implementation.
 */
import { request, type Agent } from 'node:https';
import { Readable } from 'node:stream';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface NativeRequestInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function bypassProxy(hostname: string): boolean {
  const raw = process.env['NO_PROXY'] ?? process.env['no_proxy'] ?? '';
  if (raw.trim() === '') return false;
  const host = hostname.toLowerCase();
  return raw
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
    .some(entry => {
      if (entry === '*') return true;
      const candidate = entry.replace(/^\./, '');
      return host === candidate || host.endsWith(`.${candidate}`);
    });
}

function proxyAgent(): Agent | undefined {
  const proxy = process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ?? process.env['HTTP_PROXY'] ?? process.env['http_proxy'];
  if (proxy === undefined || proxy.trim() === '') return undefined;
  return new HttpsProxyAgent(proxy);
}

/** Native HTTPS request mapped onto the Response shape the downloader already consumes. */
export function nativeFetch(rawUrl: string, init: NativeRequestInit = {}): Promise<Response> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') return Promise.reject(new Error('HTTPS required'));
  const agent = bypassProxy(url.hostname) ? undefined : proxyAgent();
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(init.signal !== undefined ? { signal: init.signal } : {}),
        ...(agent !== undefined ? { agent } : {})
      },
      response => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else if (value !== undefined) headers.set(key, value);
        }
        const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status: response.statusCode ?? 0, headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}
