import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import type { OperationContext } from '@stackmanage/core';
import { FsModuleStorage } from '../src/shared/storage';
import { isInside, isWithin, safeSegment } from '../src/shared/files';
import { downloadText, downloadVerified, fileDigest } from '../src/modules/nginx/download';
import { extractNginxSource } from '../src/modules/nginx/extract';
import { renderNginxConfig, assertSafePath, defaultIndexHtml } from '../src/modules/nginx/config';
import { NginxInstaller } from '../src/modules/nginx/installer';
import { NginxServiceManager } from '../src/modules/nginx/service';
import { nginxPaths } from '../src/modules/nginx/paths';
import {
  DEFAULT_NGINX_LIMITS,
  NGINX_SOURCE_SHA256,
  NGINX_SOURCE_TOP_LEVEL,
  NGINX_VERSION,
  NGINX_WINDOWS_SHA256,
  NGINX_WINDOWS_PLAN,
  NGINX_ASSETS,
  nginxTarget
} from '../src/modules/nginx/manifest';
import { missingDependencyKeys } from '../src/modules/nginx/preflight';
import { NGINX_STORAGE_KEYS, NginxInstallationsRecordSchema } from '../src/modules/nginx/state';

let root: string;
const servers: Server[] = [];
const PIDS: number[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackmanage-nginx-test-'));
});
afterAll(async () => {
  for (const pid of PIDS) {
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

function context(operationId: string): OperationContext & { events: Array<{ type: string; sequence?: number }> } {
  const events: Array<{ type: string; sequence?: number }> = [];
  return { operationId, signal: new AbortController().signal, emit: event => events.push(event as { type: string; sequence?: number }), events };
}

describe('nginx pins and provenance', () => {
  it('pins the official source and Windows artifacts with hashes and honest evidence', () => {
    expect(NGINX_VERSION).toBe('1.30.6');
    expect(NGINX_SOURCE_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(NGINX_WINDOWS_SHA256).toMatch(/^[a-f0-9]{64}$/);
    for (const asset of Object.values(NGINX_ASSETS)) {
      expect(asset.source).toMatch(/^https:\/\/nginx\.org\/download\//);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(NGINX_ASSETS['linux-x64']).toMatchObject({ kind: 'source', supported: true, tested: true });
    expect(NGINX_ASSETS['linux-arm64']).toMatchObject({ kind: 'source', supported: true, tested: false });
    expect(NGINX_ASSETS['win-x64']).toMatchObject({ kind: 'binary', supported: false, tested: false });
    expect(nginxTarget('win32', 'arm64')).toBeUndefined();
    expect(NGINX_WINDOWS_PLAN).toMatchObject({
      archive: 'zip',
      topLevelDir: 'nginx-1.30.6',
      binaryRelativePath: 'nginx.exe',
      execution: 'unsupported'
    });
    expect(NGINX_WINDOWS_PLAN.sha256).toBe(NGINX_WINDOWS_SHA256);
  });
});

describe('nginx paths and download', () => {
  it('confines managed paths and sanitises operation ids', () => {
    const home = join(root, 'home');
    expect(isInside(home, join(home, 'installations', 'x'))).toBe(true);
    expect(isInside(home, home)).toBe(false);
    expect(isInside(home, join(root, 'outside'))).toBe(false);
    expect(isWithin(home, home)).toBe(true);
    expect(safeSegment('a/../../b')).toBe('a_.._.._b');
  });

  it('verifies the pinned digest, rejects a foreign origin and a mismatch', async () => {
    const body = Buffer.from('nginx-source-fixture');
    const expected = createHash('sha256').update(body).digest('hex');
    const dir = await mkdtemp(join(root, 'download-'));
    const destination = join(dir, 'nginx-1.30.6.tar.gz');
    const ok = await downloadVerified({
      url: 'https://nginx.org/download/nginx-1.30.6.tar.gz',
      destination,
      expectedDigest: expected,
      limits: DEFAULT_NGINX_LIMITS,
      signal: new AbortController().signal,
      fetchImpl: (async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })) as unknown as typeof fetch
    });
    expect(ok.resumed).toBe(false);
    expect(await fileDigest(destination)).toBe(expected);

    await expect(
      downloadVerified({
        url: 'https://evil.test/nginx-1.30.6.tar.gz',
        destination: join(dir, 'evil'),
        expectedDigest: expected,
        limits: DEFAULT_NGINX_LIMITS,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('nginx.invalidUrl');

    await expect(
      downloadVerified({
        url: 'https://nginx.org/download/nginx-1.30.6.tar.gz',
        destination: join(dir, 'bad'),
        expectedDigest: 'a'.repeat(64),
        limits: DEFAULT_NGINX_LIMITS,
        signal: new AbortController().signal,
        fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
      })
    ).rejects.toThrow('nginx.digestMismatch');
  });

  it('refuses to follow a symlink at the managed destination', async () => {
    const dir = await mkdtemp(join(root, 'download-link-'));
    const target = join(dir, 'outside');
    await writeFile(target, 'keep');
    await symlink(target, join(dir, 'nginx.tar.gz'));
    await expect(
      downloadVerified({
        url: 'https://nginx.org/download/nginx-1.30.6.tar.gz',
        destination: join(dir, 'nginx.tar.gz'),
        expectedDigest: 'a'.repeat(64),
        limits: DEFAULT_NGINX_LIMITS,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('nginx.unsafeEntry');
    expect(await readFile(target, 'utf8')).toBe('keep');
  });

  it('bounds the detached signature text reader to nginx.org', async () => {
    const text = await downloadText({
      url: 'https://nginx.org/download/nginx-1.30.6.tar.gz.asc',
      limits: DEFAULT_NGINX_LIMITS,
      signal: new AbortController().signal,
      fetchImpl: (async () => new Response('BEGIN PGP SIGNATURE', { status: 200 })) as unknown as typeof fetch
    });
    expect(text).toContain('BEGIN PGP SIGNATURE');
    await expect(
      downloadText({
        url: 'https://evil.test/signature.asc',
        limits: DEFAULT_NGINX_LIMITS,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('nginx.invalidUrl');
  });
});

describe('nginx source extraction', () => {
  async function sourceArchive(dir: string): Promise<string> {
    const payload = join(dir, 'payload');
    const top = join(payload, NGINX_SOURCE_TOP_LEVEL);
    await mkdir(join(top, 'src', 'core'), { recursive: true });
    await writeFile(join(top, 'configure'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(join(top, 'src', 'core', 'nginx.c'), 'int main(void) { return 0; }\n');
    const archive = join(dir, 'nginx-1.30.6.tar.gz');
    await tar.create({ gzip: true, file: archive, cwd: payload, portable: true }, [NGINX_SOURCE_TOP_LEVEL]);
    return archive;
  }

  it('preserves the official top-level directory and finds configure', async () => {
    const dir = await mkdtemp(join(root, 'extract-'));
    const archive = await sourceArchive(dir);
    const result = await extractNginxSource({
      archivePath: archive,
      stagingDir: join(dir, 'staging'),
      topLevelDir: NGINX_SOURCE_TOP_LEVEL,
      limits: DEFAULT_NGINX_LIMITS
    });
    expect(result.topLevelPath).toBe(join(dir, 'staging', NGINX_SOURCE_TOP_LEVEL));
    expect((await stat(join(result.topLevelPath, 'configure'))).isFile()).toBe(true);
  });

  it('rejects traversal before it can write outside staging', async () => {
    const dir = await mkdtemp(join(root, 'extract-evil-'));
    const archive = join(dir, 'evil.tar.gz');
    const header = Buffer.alloc(512);
    header.write(`${NGINX_SOURCE_TOP_LEVEL}/../../outside/configure`, 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('00000000002\0', 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header.write(`${'0'.repeat(11)}\0`, 148, 'utf8');
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    const { gzipSync } = await import('node:zlib');
    await writeFile(archive, gzipSync(Buffer.concat([header, Buffer.alloc(1024)])));
    await expect(
      extractNginxSource({
        archivePath: archive,
        stagingDir: join(dir, 'staging'),
        topLevelDir: NGINX_SOURCE_TOP_LEVEL,
        limits: DEFAULT_NGINX_LIMITS
      })
    ).rejects.toThrow(/nginx\.(unsafeEntry|sourceMissing)/);
    await expect(stat(join(dir, 'outside', 'configure'))).rejects.toThrow();
  });

  it('rejects an archive without the expected configure file', async () => {
    const dir = await mkdtemp(join(root, 'extract-empty-'));
    const payload = join(dir, 'payload');
    await mkdir(join(payload, NGINX_SOURCE_TOP_LEVEL), { recursive: true });
    const archive = join(dir, 'empty.tar.gz');
    await tar.create({ gzip: true, file: archive, cwd: payload, portable: true }, [NGINX_SOURCE_TOP_LEVEL]);
    await expect(
      extractNginxSource({ archivePath: archive, stagingDir: join(dir, 'staging'), topLevelDir: NGINX_SOURCE_TOP_LEVEL, limits: DEFAULT_NGINX_LIMITS })
    ).rejects.toThrow('nginx.sourceMissing');
  });
});

describe('nginx configuration', () => {
  it('renders a loopback-only, foreground default site with private paths', () => {
    const home = join(root, 'config-home');
    const content = renderNginxConfig({
      installDir: join(home, 'installations', 'nginx-1.30.6-linux-x64'),
      pidPath: join(home, 'service', 'logs', 'nginx.pid'),
      errorLogPath: join(home, 'service', 'logs', 'error.log'),
      accessLogPath: join(home, 'service', 'logs', 'access.log'),
      tempDir: join(home, 'service', 'tmp'),
      root: join(home, 'sites', 'default')
    });
    expect(content).toContain('daemon off;');
    expect(content).toContain('listen 127.0.0.1:18081;');
    expect(content).toContain(`root "${join(home, 'sites', 'default')}";`);
    expect(content).toContain('client_body_temp_path');
    expect(content).toContain('include ');
    expect(content).not.toContain('listen 0.0.0.0');
    expect(defaultIndexHtml()).toContain('StackManage default site');
  });

  it('rejects relative paths and characters that could escape a quoted token', () => {
    expect(() => assertSafePath('relative/path')).toThrow();
    expect(() => assertSafePath('/tmp/"injected')).toThrow();
    expect(() => assertSafePath('/tmp/a;b')).toThrow();
    expect(() =>
      renderNginxConfig({
        installDir: '/tmp/install',
        pidPath: '/tmp/nginx.pid;',
        errorLogPath: '/tmp/error.log',
        accessLogPath: '/tmp/access.log',
        tempDir: '/tmp/temp',
        root: '/tmp/root'
      })
    ).toThrow();
  });
});

describe('nginx preflight and uninstall guards', () => {
  it('maps every missing build dependency to an actionable key', () => {
    expect(missingDependencyKeys({ compiler: false, make: false, pcre2: false, zlib: false, openssl: false })).toEqual([
      'nginx.compilerMissing',
      'nginx.makeMissing',
      'nginx.headerPcre2Missing',
      'nginx.headerZlibMissing',
      'nginx.headerOpenSslMissing'
    ]);
    expect(missingDependencyKeys({ compiler: true, make: true, pcre2: true, zlib: true, openssl: true })).toEqual([]);
  });

  it('refuses to uninstall a record outside the managed installations root', async () => {
    const home = await mkdtemp(join(root, 'uninstall-'));
    const storage = new FsModuleStorage(join(home, 'state'));
    const paths = nginxPaths(home);
    const installer = new NginxInstaller({ storage, paths, platform: 'linux', architecture: 'x64', verifySignatures: false });
    const outside = join(root, 'outside-install');
    await mkdir(join(outside, 'sbin'), { recursive: true });
    await writeFile(join(outside, 'sbin', 'nginx'), 'x');
    await storage.StorageSetAsync(
      'nginx',
      NGINX_STORAGE_KEYS.installations,
      {
        installations: [
          {
            id: 'nginx-1.30.6-linux-x64',
            moduleId: 'nginx',
            version: '1.30.6',
            target: 'linux-x64',
            directory: outside,
            binaryPath: join(outside, 'sbin', 'nginx'),
            archivePath: join(paths.downloads, 'nginx-1.30.6.tar.gz'),
            source: 'https://nginx.org/download/nginx-1.30.6.tar.gz',
            sha256: NGINX_SOURCE_SHA256,
            installedAt: new Date().toISOString(),
            versionOutput: 'nginx version: nginx/1.30.6'
          }
        ]
      },
      NginxInstallationsRecordSchema
    );
    const result = await installer.uninstall('nginx-1.30.6-linux-x64', 'uninstall-outside', context('uninstall-outside'));
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.code).toBe('FORBIDDEN');
    expect((await stat(outside)).isDirectory()).toBe(true);
  });
});

describe('nginx service lifecycle', () => {
  const PORT = 19181;
  const CONFLICT_PORT = 19182;

  async function fakeNginx(port: number): Promise<string> {
    const dir = await mkdtemp(join(root, 'fake-nginx-'));
    const binary = join(dir, 'nginx');
    await writeFile(
      binary,
      `#!${process.execPath}
const http = require('node:http');
const args = process.argv.slice(2);
if (args.includes('-v')) { process.stderr.write('nginx version: nginx/1.30.6\\n'); process.exit(0); }
if (args.includes('-t')) { process.exit(0); }
const server = http.createServer((_req, res) => res.end('nginx-ok')).listen(${port}, '127.0.0.1', () => process.stdout.write('started\\n'));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', () => {});
`,
      { mode: 0o755 }
    );
    await chmod(binary, 0o755);
    return binary;
  }

  async function harness(port: number) {
    const home = await mkdtemp(join(root, 'service-'));
    const storage = new FsModuleStorage(join(home, 'state'));
    const paths = nginxPaths(home);
    const installDir = join(paths.installations, 'nginx-1.30.6-linux-x64');
    await mkdir(join(installDir, 'sbin'), { recursive: true });
    await mkdir(join(installDir, 'conf'), { recursive: true });
    await writeFile(join(installDir, 'conf', 'mime.types'), 'types { text/html html; }\n');
    const source = await fakeNginx(port);
    await copyFile(source, join(installDir, 'sbin', 'nginx'));
    await chmod(join(installDir, 'sbin', 'nginx'), 0o755);
    const installer = new NginxInstaller({ storage, paths, platform: 'linux', architecture: 'x64', verifySignatures: false });
    await storage.StorageSetAsync(
      'nginx',
      NGINX_STORAGE_KEYS.installations,
      {
        installations: [
          {
            id: 'nginx-1.30.6-linux-x64',
            moduleId: 'nginx',
            version: '1.30.6',
            target: 'linux-x64',
            directory: installDir,
            binaryPath: join(installDir, 'sbin', 'nginx'),
            archivePath: join(paths.downloads, 'nginx-1.30.6.tar.gz'),
            source: 'https://nginx.org/download/nginx-1.30.6.tar.gz',
            sha256: NGINX_SOURCE_SHA256,
            installedAt: new Date().toISOString(),
            versionOutput: 'nginx version: nginx/1.30.6'
          }
        ]
      },
      NginxInstallationsRecordSchema
    );
    const service = new NginxServiceManager({ storage, paths, installer, platform: 'linux', architecture: 'x64', port });
    return { home, paths, storage, installer, service };
  }

  it.skipIf(process.platform !== 'linux')('starts, serves HTTP 200, reloads and stops a real child process', async () => {
    const h = await harness(PORT);
    const started = await h.service.start({ operationId: 'start' }, context('start'));
    expect(started, JSON.stringify(started)).toMatchObject({ status: 'completed' });
    const status = await h.service.status('nginx');
    PIDS.push(status.service.pid ?? 0);
    expect(status).toMatchObject({ installed: true, supported: true, tested: true });
    expect(status.service.state).toBe('running');
    expect(status.service.pid).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('nginx-ok');

    const reloaded = await h.service.reload({ operationId: 'reload', timeoutMs: 5000 }, context('reload'));
    expect(reloaded, JSON.stringify(reloaded)).toMatchObject({ status: 'completed' });

    const config = await h.service.config();
    expect(config.exists).toBe(true);
    expect(config.content).toContain(`listen 127.0.0.1:${PORT};`);

    const log = await h.service.logs({ maxBytes: 4096 });
    expect(log.path).toContain('error.log');
    expect(log.bytes).toBeGreaterThanOrEqual(0);

    const stopped = await h.service.stop({ operationId: 'stop' }, context('stop'));
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ status: 'completed' });
    const after = await h.service.status('nginx');
    expect(after.service.state).toBe('stopped');
  });

  it.skipIf(process.platform !== 'linux')('refuses to start when the loopback port is already in use', async () => {
    const h = await harness(CONFLICT_PORT);
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(CONFLICT_PORT, '127.0.0.1', () => resolve()));
    servers.push(blocker);
    const started = await h.service.start({ operationId: 'start-conflict' }, context('start-conflict'));
    expect(started.status).toBe('failed');
    expect(started.items[0]?.error?.messageKey).toBe('nginx.portInUse');
  });
});
