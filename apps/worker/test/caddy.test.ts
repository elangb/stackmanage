import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import type { ModuleStorage, Site } from '@stackmanage/core';
import { CaddyModule } from '../src/modules/caddy';
import { FsModuleStorage, caddyPaths } from '../src/modules/caddy/paths';
import { downloadVerified, fileDigest } from '../src/modules/caddy/download';
import { extractBinary } from '../src/modules/caddy/extract';
import { renderCaddyfile } from '../src/modules/caddy/caddyfile';
import { DEFAULT_INSTANCE_ID, DEFAULT_OPERATIONAL_LIMITS } from '../src/modules/caddy/manifest';
import { CaddyInstallationRecordSchema, CaddyServiceRecordSchema, STORAGE_KEYS } from '../src/modules/caddy/state';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackmanage-caddy-test-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const REF = { moduleId: 'caddy', installationId: 'caddy-2.11.8', instanceId: DEFAULT_INSTANCE_ID };
const SHA = 'f032f8805e4df2ce5e1a8a624495c91e9ff763d8ff3ceddadd4784a07c472f40';

interface Harness {
  module: CaddyModule;
  storage: ModuleStorage;
  home: string;
  sitesRoot: string;
}

async function harness(platform = 'linux', architecture = 'x64'): Promise<Harness> {
  const home = await mkdtemp(join(root, 'mod-'));
  const storage = new FsModuleStorage(join(home, 'state'));
  const module = new CaddyModule({ storage, home, platform, architecture });
  return { module, storage, home, sitesRoot: caddyPaths(home).siteRoots };
}

function site(port: number, overrides: Partial<Site> = {}): Site {
  return { id: 'default', hostname: 'localhost', aliases: [], server: REF, root: '', port, tls: false, ...overrides };
}

function siteFor(sitesRoot: string, port: number): Site {
  return site(port, { root: join(sitesRoot, 'default') });
}

function context(operationId: string) {
  const events: { type: string; sequence?: number }[] = [];
  return { operationId, signal: new AbortController().signal, emit: (event: { type: string; sequence?: number }) => events.push(event), events };
}

/** Fake caddy: answers `version`, serves HTTP on the port, exits on SIGTERM. */
async function fakeCaddy(port: number): Promise<string> {
  const dir = await mkdtemp(join(root, 'fake-'));
  const binary = join(dir, 'caddy');
  await writeFile(
    binary,
    `#!${process.execPath}
const http = require('node:http');
const args = process.argv.slice(2);
if (args[0] === 'version') { console.log('v2.11.8'); process.exit(0); }
if (args[0] === 'validate') process.exit(0);
const server = http.createServer((_req, res) => res.end('ok')).listen(${port}, '127.0.0.1', () => process.stdout.write('serving\\n'));
const off = () => server.close(() => process.exit(0));
process.on('SIGTERM', off);
process.on('SIGINT', off);
`,
    { mode: 0o755 }
  );
  await chmod(binary, 0o755);
  return binary;
}

/** Plant the install record the downloader would have written, pointing at the fake binary. */
async function installFake(h: Harness, sourceBinary: string): Promise<string> {
  const installationDir = join(caddyPaths(h.home).installations, 'caddy-2.11.8');
  await mkdir(installationDir, { recursive: true });
  // The module derives the binary from the installation directory, not the record.
  const binaryPath = join(installationDir, 'caddy');
  await copyFile(sourceBinary, binaryPath);
  await chmod(binaryPath, 0o755);
  await h.storage.StorageSetAsync(
    'caddy',
    STORAGE_KEYS.installation,
    {
      installation: {
        id: 'caddy-2.11.8',
        version: {
          moduleId: 'caddy',
          version: '2.11.8',
          platform: 'linux',
          architecture: 'x64',
          source: 'https://github.com/caddyserver/caddy/releases/download/v2.11.8/caddy_2.11.8_linux_amd64.tar.gz',
          sha256: SHA
        },
        directory: installationDir
      },
      target: 'linux-amd64',
      binaryPath,
      archivePath: join(caddyPaths(h.home).downloads, 'caddy_2.11.8_linux_amd64.tar.gz'),
      installedAt: new Date().toISOString(),
      versionOutput: 'v2.11.8'
    },
    CaddyInstallationRecordSchema
  );
  return binaryPath;
}

async function seedSite(h: Harness, port: number): Promise<void> {
  const root_ = join(h.sitesRoot, 'default');
  await mkdir(root_, { recursive: true });
  await writeFile(join(root_, 'index.html'), 'ok');
  const applied = await h.module.sites.apply({ operationId: 'seed', sites: [siteFor(h.sitesRoot, port)] }, context('seed') as never);
  expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'completed' });
}

/** Wait for process-table reaping; a stopped child may linger briefly as a zombie. */
async function gone(pid: number, waited = 0): Promise<boolean> {
  try {
    const info = await stat(`/proc/${pid}`);
    void info;
    if (waited < 3000) {
      await new Promise(resolve => setTimeout(resolve, 50));
      return gone(pid, waited + 50);
    }
    return false;
  } catch {
    return true;
  }
}

describe('download', () => {
  it('resumes a partial file when the server honours Range', async () => {
    const body = Buffer.from('x'.repeat(4096));
    const expected = createHash('sha256').update(body).digest('hex');
    const dir = await mkdtemp(join(root, 'resume-'));
    const destination = join(dir, 'asset.bin');
    await writeFile(`${destination}.part`, body.subarray(0, 1024));
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.['range'];
      if (range === 'bytes=1024-') {
        return new Response(body.subarray(1024), { status: 206, headers: { 'content-length': String(body.length - 1024) } });
      }
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    };
    const result = await downloadVerified({
      url: 'https://github.com/caddyserver/caddy/releases/download/v2.11.8/asset.bin',
      destination,
      expectedDigest: expected,
      algorithm: 'sha256',
      limits: DEFAULT_OPERATIONAL_LIMITS,
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.resumed).toBe(true);
    expect(await fileDigest(destination)).toBe(expected);
  });

  it('restarts from zero when the server ignores Range', async () => {
    const body = Buffer.from('y'.repeat(2048));
    const expected = createHash('sha256').update(body).digest('hex');
    const dir = await mkdtemp(join(root, 'ignore-'));
    const destination = join(dir, 'asset.bin');
    await writeFile(`${destination}.part`, Buffer.from('stale'));
    const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    const result = await downloadVerified({
      url: 'https://github.com/caddyserver/caddy/releases/download/v2.11.8/asset.bin',
      destination,
      expectedDigest: expected,
      algorithm: 'sha256',
      limits: DEFAULT_OPERATIONAL_LIMITS,
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.resumed).toBe(false);
    expect(await fileDigest(destination)).toBe(expected);
  });

  it('rejects a digest mismatch and leaves no file behind', async () => {
    const dir = await mkdtemp(join(root, 'mismatch-'));
    const destination = join(dir, 'asset.bin');
    const fetchImpl = async () => new Response(Buffer.from('content'), { status: 200, headers: { 'content-length': '7' } });
    await expect(
      downloadVerified({
        url: 'https://github.com/caddyserver/caddy/releases/download/v2.11.8/asset.bin',
        destination,
        expectedDigest: 'a'.repeat(64),
        algorithm: 'sha256',
        limits: DEFAULT_OPERATIONAL_LIMITS,
        signal: new AbortController().signal,
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow('install.digestMismatch');
    expect(await fileDigest(destination)).toBeUndefined();
  });

  it('caps the body size and the redirect chain', async () => {
    const dir = await mkdtemp(join(root, 'caps-'));
    const big = async () => new Response(Buffer.alloc(2048), { status: 200, headers: { 'content-length': '2048' } });
    await expect(
      downloadVerified({
        url: 'https://github.com/caddyserver/caddy/releases/download/v2.11.8/asset.bin',
        destination: join(dir, 'a.bin'),
        expectedDigest: 'a'.repeat(64),
        algorithm: 'sha256',
        limits: { ...DEFAULT_OPERATIONAL_LIMITS, maxDownloadBytes: 1024 },
        signal: new AbortController().signal,
        fetchImpl: big as unknown as typeof fetch
      })
    ).rejects.toThrow('install.downloadTooLarge');

    const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://github.com/loop' } });
    await expect(
      downloadVerified({
        url: 'https://github.com/caddyserver/caddy/releases/download/v2.11.8/asset.bin',
        destination: join(dir, 'b.bin'),
        expectedDigest: 'a'.repeat(64),
        algorithm: 'sha256',
        limits: { ...DEFAULT_OPERATIONAL_LIMITS, maxRedirects: 3 },
        signal: new AbortController().signal,
        fetchImpl: redirect as unknown as typeof fetch
      })
    ).rejects.toThrow('install.downloadFailed');
  });

  it('rejects a non-HTTPS or foreign origin', async () => {
    await expect(
      downloadVerified({
        url: 'http://evil.test/caddy.tar.gz',
        destination: join(root, 'x.bin'),
        expectedDigest: 'a'.repeat(64),
        algorithm: 'sha256',
        limits: DEFAULT_OPERATIONAL_LIMITS,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('install.insecureUrl');
  });
});

describe('extraction', () => {
  it('drops traversal entries and keeps only allow-listed files', async () => {
    const dir = await mkdtemp(join(root, 'extract-'));
    await writeFile(join(dir, 'caddy'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(dir, 'README.md'), 'docs');
    const archive = join(dir, 'good.tar.gz');
    await tar.create({ gzip: true, file: archive, cwd: dir, portable: true }, ['caddy', 'README.md']);
    const staging = join(dir, 'out');
    const result = await extractBinary({
      archivePath: archive,
      kind: 'tar.gz',
      stagingDir: staging,
      limits: DEFAULT_OPERATIONAL_LIMITS,
      requiredFiles: ['caddy']
    });
    expect(result.extracted).toEqual(['caddy']);
    expect((await stat(join(staging, 'caddy'))).isFile()).toBe(true);
    await expect(stat(join(staging, 'README.md'))).rejects.toThrow();
  });

  it('refuses an archive entry that escapes the staging directory', async () => {
    const dir = await mkdtemp(join(root, 'traverse-'));
    const outside = join(dir, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'caddy'), 'escaped');
    const archive = join(dir, 'evil.tar.gz');
    // `tar` refuses to store `..` members, so build the header by hand.
    const header = Buffer.alloc(512);
    header.write('../outside/caddy', 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('00000000000\0', 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header.write(`${'0'.repeat(11)}\0`, 148, 'utf8');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148 - 148, 'utf8');
    // Recompute over the checksum field as spaces, per tar spec.
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    const body = Buffer.concat([header, Buffer.alloc(1024)]);
    const { gzipSync } = await import('node:zlib');
    await writeFile(archive, gzipSync(body));

    const staging = join(dir, 'out');
    await expect(
      extractBinary({
        archivePath: archive,
        kind: 'tar.gz',
        stagingDir: staging,
        limits: DEFAULT_OPERATIONAL_LIMITS,
        requiredFiles: ['caddy']
      })
    ).rejects.toThrow(/install\.(unsafeEntry|binaryMissing)/);
    await expect(stat(join(dir, 'outside', 'caddy'))).resolves.toBeDefined();
  });

  it('refuses a symlinked binary', async () => {
    const dir = await mkdtemp(join(root, 'symlink-'));
    await writeFile(join(dir, 'target'), 'x');
    await (await import('node:fs/promises')).symlink('target', join(dir, 'caddy'));
    const archive = join(dir, 'link.tar.gz');
    await tar.create({ gzip: true, file: archive, cwd: dir, portable: true }, ['caddy', 'target']);
    const staging = join(dir, 'out');
    await expect(
      extractBinary({
        archivePath: archive,
        kind: 'tar.gz',
        stagingDir: staging,
        limits: DEFAULT_OPERATIONAL_LIMITS,
        requiredFiles: ['caddy']
      })
    ).rejects.toThrow('install.unsafeEntry');
  });
});

describe('caddyfile', () => {
  it('renders admin-off loopback config and rejects an out-of-root site', () => {
    const sitesRoot = join(root, 'cf-sites');
    const rendered = renderCaddyfile([siteFor(sitesRoot, 18080)], sitesRoot);
    expect(rendered.content).toContain('admin off');
    expect(rendered.content).toContain('auto_https disable_redirects');
    expect(rendered.content).toContain('http://localhost:18080');
    expect(rendered.content).toContain('bind 127.0.0.1');
    expect(() => renderCaddyfile([site(18081, { root: '/etc' })], sitesRoot)).toThrow();
  });

  it('renders internal TLS for a custom domain and its aliases', () => {
    const sitesRoot = join(root, 'cf-tls-sites');
    const rendered = renderCaddyfile([site(18443, { id: 'shop', hostname: 'shop.test', aliases: ['www.shop.test'], tls: true, root: join(sitesRoot, 'shop') })], sitesRoot);
    expect(rendered.content).toContain('https://shop.test:18443, https://www.shop.test:18443');
    expect(rendered.content).toContain('tls internal');
    expect(rendered.content).not.toContain('auto_https off');
  });
});

describe('service lifecycle', () => {
  it('starts, serves HTTP 200, stops truthfully and reaps the child', async () => {
    const port = 18991;
    const h = await harness();
    await installFake(h, await fakeCaddy(port));
    await seedSite(h, port);

    const ctx = context('op-start');
    const started = await h.module.service.start({ ref: REF, operationId: 'op-start', timeoutMs: 8000 }, ctx as never);
    expect(started, JSON.stringify(started)).toMatchObject({ status: 'completed' });
    expect(ctx.events.length).toBeGreaterThan(0);
    expect(ctx.events.every(event => event.type === 'progress')).toBe(true);

    const running = await h.module.service.status({ instanceId: DEFAULT_INSTANCE_ID });
    expect(running.state).toBe('running');
    const pid = running.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);

    const stopped = await h.module.service.stop({ ref: REF, operationId: 'op-stop' }, context('op-stop') as never);
    expect(stopped.status).toBe('completed');
    expect(await gone(pid)).toBe(true);
    expect((await h.module.service.status({ instanceId: DEFAULT_INSTANCE_ID })).state).toBe('stopped');
    await h.module.shutdown();
  }, 60000);

  it('never kills a process whose identity does not match', async () => {
    const port = 18992;
    const h = await harness();
    await installFake(h, await fakeCaddy(port));
    await seedSite(h, port);
    expect((await h.module.service.start({ ref: REF, operationId: 'op-s', timeoutMs: 8000 }, context('op-s') as never)).status).toBe('completed');
    const record = await h.module.persistedService();
    const pid = record?.process?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    // Simulated PID recycling: same pid, different start token.
    await h.storage.StorageSetAsync(
      'caddy',
      STORAGE_KEYS.service(DEFAULT_INSTANCE_ID),
      { ...record, process: { ...record?.process, startToken: 'stale-token' } },
      CaddyServiceRecordSchema
    );
    const stopped = await h.module.service.stop({ ref: REF, operationId: 'op-stop' }, context('op-stop') as never);
    expect(stopped.status).toBe('failed');
    expect(stopped.items[0]?.error?.messageKey).toBe('service.identityMismatch');
    expect(await gone(pid)).toBe(false);
    expect((await h.module.service.status({ instanceId: DEFAULT_INSTANCE_ID })).state).toBe('unknown');

    process.kill(pid, 'SIGKILL');
    await h.module.shutdown();
  }, 60000);

  it('reconciles a stale persisted pid on worker start', async () => {
    const port = 18997;
    const h = await harness();
    await installFake(h, await fakeCaddy(port));
    await seedSite(h, port);
    await h.module.service.start({ ref: REF, operationId: 'op-s', timeoutMs: 8000 }, context('op-s') as never);
    const pid = (await h.module.persistedService())?.process?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    // Simulate the worker dying: the record survives, a fresh module takes over.
    const restarted = await harness();
    await h.storage.StorageSetAsync(
      'caddy',
      STORAGE_KEYS.installation,
      await h.storage.StorageGetAsync('caddy', STORAGE_KEYS.installation, CaddyInstallationRecordSchema),
      CaddyInstallationRecordSchema
    );
    const shared = new CaddyModule({ storage: h.storage, home: h.home, platform: 'linux', architecture: 'x64' });
    const reconciled = await shared.reconcileOnStartup();
    expect(reconciled.action).toBe('stopped');
    expect(await gone(pid)).toBe(true);
    await shared.shutdown();
    await restarted.module.shutdown();
  }, 60000);

  it('records an unverifiable pid as unknown instead of killing it', async () => {
    const port = 18998;
    const h = await harness();
    await installFake(h, await fakeCaddy(port));
    await seedSite(h, port);
    await h.module.service.start({ ref: REF, operationId: 'op-s', timeoutMs: 8000 }, context('op-s') as never);
    const pid = (await h.module.persistedService())?.process?.pid ?? 0;

    // Same PID, wrong environment token: identity cannot be proven.
    await h.storage.StorageSetAsync(
      'caddy',
      STORAGE_KEYS.service(DEFAULT_INSTANCE_ID),
      { ...(await h.module.persistedService()), process: { ...(await h.module.persistedService())?.process, procToken: 'f'.repeat(32) } },
      CaddyServiceRecordSchema
    );
    const shared = new CaddyModule({ storage: h.storage, home: h.home, platform: 'linux', architecture: 'x64' });
    expect((await shared.reconcileOnStartup()).action).toBe('unknown');
    expect(await gone(pid)).toBe(false);
    process.kill(pid, 'SIGKILL');
    await shared.shutdown();
    await h.module.shutdown();
  }, 60000);

  it('survives 50 start/stop cycles without leaking children', async () => {
    const port = 18993;
    const h = await harness();
    await installFake(h, await fakeCaddy(port));
    await seedSite(h, port);
    const pids = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const started = await h.module.service.start({ ref: REF, operationId: `op-${i}`, timeoutMs: 8000 }, context(`op-${i}`) as never);
      expect(started.status).toBe('completed');
      pids.add((await h.module.persistedService())?.process?.pid ?? 0);
      const stopped = await h.module.service.stop({ ref: REF, operationId: `op-s-${i}` }, context(`op-s-${i}`) as never);
      expect(stopped.status).toBe('completed');
    }
    expect(pids.size).toBe(50);
    for (const pid of pids) expect(await gone(pid)).toBe(true);
    await h.module.shutdown();
  }, 240000);

  it('reports a port conflict instead of starting a second instance', async () => {
    const port = 18994;
    const h = await harness();
    await installFake(h, await fakeCaddy(port));
    await seedSite(h, port);
    const net = await import('node:net');
    const blocker = net.createServer().listen(port, '127.0.0.1');
    await new Promise(resolve => blocker.once('listening', resolve));
    try {
      const started = await h.module.service.start({ ref: REF, operationId: 'op-conflict', timeoutMs: 3000 }, context('op-conflict') as never);
      expect(started.status).toBe('failed');
      expect(started.items[0]?.error?.messageKey).toBe('service.portInUse');
    } finally {
      blocker.close();
      await h.module.shutdown();
    }
  }, 60000);

  it('force-kills a child that ignores SIGTERM instead of claiming a clean stop', async () => {
    const { spawn } = await import('node:child_process');
    const { captureIdentity, terminateTree } = await import('../src/modules/caddy/process');
    const dir = await mkdtemp(join(root, 'stubborn-'));
    const script = join(dir, 'stubborn.mjs');
    await writeFile(script, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, STACKMANAGE_PROC_TOKEN: 'c'.repeat(32) }
    });
    const pid = child.pid ?? 0;
    // Wait until the handler is installed, otherwise SIGTERM wins the race.
    await new Promise(resolve => setTimeout(resolve, 300));
    const identity = await captureIdentity(pid, 'c'.repeat(32));
    expect(identity).toBeDefined();
    const outcome = await terminateTree(pid, { graceMs: 500, killMs: 3000, expected: identity!, exitObserved: () => false });
    expect(outcome.exited).toBe(true);
    expect(outcome.forced).toBe(true);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 20000);

  it('reports not-installed rather than spawning anything', async () => {
    const h = await harness();
    const started = await h.module.service.start({ ref: REF, operationId: 'op-ni', timeoutMs: 1000 }, context('op-ni') as never);
    expect(started.status).toBe('failed');
    expect(started.items[0]?.error?.code).toBe('UNAVAILABLE');
    await h.module.shutdown();
  });
});

describe('install preflight', () => {
  it('rejects a platform mismatch and an unpinned version before any download', async () => {
    const h = await harness();
    const wrongPlatform = await h.module.installer.install(
      { operationId: 'i1', moduleId: 'caddy', version: '2.11.8', platform: 'win32', architecture: 'x64' } as never,
      context('i1') as never
    );
    expect(wrongPlatform.status).toBe('failed');
    expect(wrongPlatform.items[0]?.error?.code).toBe('INVALID_REQUEST');

    const wrongVersion = await h.module.installer.install(
      { operationId: 'i2', moduleId: 'caddy', version: '2.10.0', platform: 'linux', architecture: 'x64' } as never,
      context('i2') as never
    );
    expect(wrongVersion.status).toBe('failed');
    expect(wrongVersion.items[0]?.error?.code).toBe('NOT_IMPLEMENTED');
  });

  it('pins exactly the published assets for the managed platforms', async () => {
    const h = await harness();
    const version = h.module.installer.availableVersion();
    expect(version?.sha256).toBe(SHA);
    expect(version?.source).toBe('https://github.com/caddyserver/caddy/releases/download/v2.11.8/caddy_2.11.8_linux_amd64.tar.gz');
    const arm = await harness('linux', 'arm64');
    // arm64 publishes only the SHA-512; the record carries a derived SHA-256.
    expect(arm.module.installer.availableVersion()?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(arm.module.installer.availableVersion()?.source).toContain('caddy_2.11.8_linux_arm64.tar.gz');
    const darwin = await harness('darwin', 'arm64');
    expect(darwin.module.installer.availableVersion()).toBeUndefined();
  });
});
