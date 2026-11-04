/**
 * Deterministic Nginx configuration for the managed default site.
 *
 * - `daemon off` keeps the master in the foreground so the worker owns its PID.
 * - `listen 127.0.0.1:<port>` never publishes on a wildcard interface.
 * - Every path is absolute, inside the managed tree and free of characters that
 *   could terminate a quoted Nginx token.
 * - The file is validated with the installed binary before it replaces the live
 *   configuration.
 */
import { isAbsolute } from 'node:path';
import { DEFAULT_HOSTNAME, DEFAULT_SITE_PORT, LOOPBACK_ADDRESS, type NginxLimits } from './manifest';

export interface NginxConfigPaths {
  installDir: string;
  pidPath: string;
  errorLogPath: string;
  accessLogPath: string;
  tempDir: string;
  root: string;
}

export interface NginxConfigOptions extends NginxConfigPaths {
  port?: number;
  hostname?: string;
}

const UNSAFE_PATH = /["'`{}$\\\r\n\0;#]/;

export function assertSafePath(path: string): void {
  if (!isAbsolute(path)) throw new Error('path must be absolute');
  if (UNSAFE_PATH.test(path)) throw new Error('path contains unsafe characters');
}

export function assertRenderableHostname(hostname: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hostname)) {
    throw new Error('invalid hostname');
  }
}

export function assertRenderablePort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid port');
}

export function renderNginxConfig(options: NginxConfigOptions): string {
  const port = options.port ?? DEFAULT_SITE_PORT;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  assertRenderablePort(port);
  assertRenderableHostname(hostname);
  for (const path of [options.installDir, options.pidPath, options.errorLogPath, options.accessLogPath, options.tempDir, options.root]) {
    assertSafePath(path);
  }
  const mime = `${options.installDir}/conf/mime.types`;
  assertSafePath(mime);
  const lines = [
    'daemon off;',
    'worker_processes 1;',
    `pid "${options.pidPath}";`,
    `error_log "${options.errorLogPath}" warn;`,
    '',
    'events {',
    '    worker_connections 256;',
    '}',
    '',
    'http {',
    `    include "${mime}";`,
    '    default_type application/octet-stream;',
    `    access_log "${options.accessLogPath}";`,
    '    sendfile on;',
    '    keepalive_timeout 30;',
    `    client_body_temp_path "${options.tempDir}/client_body";`,
    `    proxy_temp_path "${options.tempDir}/proxy";`,
    `    fastcgi_temp_path "${options.tempDir}/fastcgi";`,
    `    uwsgi_temp_path "${options.tempDir}/uwsgi";`,
    `    scgi_temp_path "${options.tempDir}/scgi";`,
    '',
    '    server {',
    `        listen ${LOOPBACK_ADDRESS}:${port};`,
    `        server_name ${hostname};`,
    `        root "${options.root}";`,
    '        index index.html index.htm;',
    '        location / {',
    '            try_files $uri $uri/ =404;',
    '        }',
    '    }',
    '}',
    ''
  ];
  return `${lines.join('\n')}\n`;
}

export function defaultIndexHtml(): string {
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>StackManage Nginx</title></head><body><h1>StackManage default site</h1><p>Served by the managed Nginx instance.</p></body></html>\n';
}

/** Hard validation before a start/reload; also used by the integration test. */
export function assertConfigWithinHome(home: string, paths: readonly string[], isWithin: (parent: string, child: string) => boolean): void {
  for (const path of paths) {
    assertSafePath(path);
    if (!isWithin(home, path)) throw new Error('path outside managed home');
  }
}

export type { NginxLimits };
