import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import type { OperationContext, WorkerManagementRequest } from '@stackmanage/core';
import { FsModuleStorage } from '../src/shared/storage';
import { isInside, isWithin, safeSegment } from '../src/shared/files';
import { downloadVerified, fileDigest } from '../src/modules/redis/download';
import { extractRedisSource } from '../src/modules/redis/extract';
import { renderRedisConfig, assertSafePath } from '../src/modules/redis/config';
import { RedisInstaller } from '../src/modules/redis/installer';
import { RedisServiceManager } from '../src/modules/redis/service';
import { RedisModule } from '../src/modules/redis';
import { redisPaths } from '../src/modules/redis/paths';
import {
  DEFAULT_REDIS_LIMITS,
  REDIS_SOURCE_SHA256,
  REDIS_SOURCE_TOP_LEVEL,
  REDIS_SOURCE_URL,
  REDIS_VERSION,
  REDIS_ASSETS,
  REDIS_LICENSE,
  redisTarget
} from '../src/modules/redis/manifest';
import { missingDependencyKeys } from '../src/modules/redis/preflight';
import { REDIS_STORAGE_KEYS, RedisInstallationsRecordSchema } from '../src/modules/redis/state';

let root: string;
const servers: Server[] = [];
const PIDS: number[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackmanage-redis-test-'));
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

function context(operationId: string): OperationContext {
  return { operationId, signal: new AbortController().signal, emit: () => undefined };
}

const FAKE_SERVER = `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('Redis server v=7.2.7 sha=test malloc=libc bits=64 build=test\\n'); process.exit(0); }
const conf = fs.readFileSync(args[0], 'utf8');
const match = /^port (\\d+)$/m.exec(conf);
const server = net.createServer(socket => { socket.on('data', () => socket.write('+PONG\\r\\n')); });
server.listen(Number(match[1]), '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`;

const FAKE_CLI = `#!${process.execPath}
const net = require('node:net');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('redis-cli 7.2.7\\n'); process.exit(0); }
if (args.includes('ping')) {
  const index = args.indexOf('-p');
  const socket = net.connect(Number(args[index + 1]), '127.0.0.1');
  socket.on('connect', () => { process.stdout.write('PONG\\n'); socket.end(); process.exit(0); });
  socket.on('error', () => process.exit(1));
} else {
  process.exit(1);
}
`;

async function fakeBinaries(dir: string): Promise<{ server: string; cli: string }> {
  await mkdir(dir, { recursive: true });
  const server = join(dir, 'redis-server');
  const cli = join(dir, 'redis-cli');
  await writeFile(server, FAKE_SERVER, { mode: 0o755 });
  await writeFile(cli, FAKE_CLI, { mode: 0o755 });
  await chmod(server, 0o755);
  await chmod(cli, 0o755);
  return { server, cli };
}

function request(method: 'redis.start' | 'redis.stop' | 'redis.uninstall' | 'redis.status' | 'redis.logs', params: unknown): WorkerManagementRequest {
  return { apiVersion: 1, id: `req-${method}`, method, params } as WorkerManagementRequest;
}

describe('redis pins and provenance', () => {
  it('pins the official BSD-3-Clause source and reports Windows honestly', () => {
    expect(REDIS_VERSION).toBe('7.2.7');
    expect(REDIS_SOURCE_URL).toBe('https://download.redis.io/releases/redis-7.2.7.tar.gz');
    expect(REDIS_SOURCE_SHA256).toBe('72c081e3b8cfae7144273d26d76736f08319000af46c01515cad5d29765cead5');
    expect(REDIS_LICENSE).toBe('BSD-3-Clause');
    for (const asset of Object.values(REDIS_ASSETS)) {
      expect(asset.source).toBe(REDIS_SOURCE_URL);
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.archive).toBe('tar.gz');
      expect(asset.kind).toBe('source');
    }
    expect(REDIS_ASSETS['linux-x64']).toMatchObject({ supported: true, tested: true });
    expect(REDIS_ASSETS['linux-arm64']).toMatchObject({ supported: true, tested: false });
    expect(redisTarget('win32', 'x64')).toBeUndefined();
    expect(redisTarget('darwin', 'arm64')).toBeUndefined();
    expect(redisTarget('linux', 'x64')).toBe('linux-x64');
  });
});

describe('redis paths and download', () => {
  it('confines managed paths and sanitises operation ids', () => {
    const home = join(root, 'home');
    expect(isInside(home, join(home, 'installations', 'x'))).toBe(true);
    expect(isInside(home, home)).toBe(false);
    expect(isInside(home, join(root, 'outside'))).toBe(false);
    expect(isWithin(home, home)).toBe(true);
    expect(safeSegment('a/../../b')).toBe('a_.._.._b');
  });

  it('verifies the pinned digest, rejects a foreign origin and a mismatch', async () => {
    const body = Buffer.from('redis-source-fixture');
    const expected = createHash('sha256').update(body).digest('hex');
    const dir = await mkdtemp(join(root, 'download-'));
    const destination = join(dir, 'redis-7.2.7.tar.gz');
    const ok = await downloadVerified({
      url: REDIS_SOURCE_URL,
      destination,
      expectedDigest: expected,
      limits: DEFAULT_REDIS_LIMITS,
      signal: new AbortController().signal,
      fetchImpl: (async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })) as unknown as typeof fetch
    });
    expect(ok.resumed).toBe(false);
    expect(await fileDigest(destination)).toBe(expected);

    await expect(
      downloadVerified({
        url: 'https://evil.test/redis-7.2.7.tar.gz',
        destination: join(dir, 'evil'),
        expectedDigest: expected,
        limits: DEFAULT_REDIS_LIMITS,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('redis.invalidUrl');

    await expect(
      downloadVerified({
        url: REDIS_SOURCE_URL,
        destination: join(dir, 'bad'),
        expectedDigest: 'a'.repeat(64),
        limits: DEFAULT_REDIS_LIMITS,
        signal: new AbortController().signal,
        fetchImpl: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
      })
    ).rejects.toThrow('redis.digestMismatch');
  });

  it('refuses to follow a symlink at the managed destination', async () => {
    const dir = await mkdtemp(join(root, 'download-link-'));
    const target = join(dir, 'outside');
    await writeFile(target, 'keep');
    await symlink(target, join(dir, 'redis.tar.gz'));
    await expect(
      downloadVerified({
        url: REDIS_SOURCE_URL,
        destination: join(dir, 'redis.tar.gz'),
        expectedDigest: 'a'.repeat(64),
        limits: DEFAULT_REDIS_LIMITS,
        signal: new AbortController().signal
      })
    ).rejects.toThrow('redis.unsafeEntry');
    expect(await readFile(target, 'utf8')).toBe('keep');
  });
});

describe('redis source extraction', () => {
  async function sourceArchive(dir: string, required = true): Promise<string> {
    const payload = join(dir, 'payload');
    const top = join(payload, REDIS_SOURCE_TOP_LEVEL);
    await mkdir(join(top, 'src'), { recursive: true });
    await writeFile(join(top, 'Makefile'), 'all:\n\t@true\n');
    if (required) await writeFile(join(top, 'src', 'Makefile'), 'all:\n\t@true\n');
    const archive = join(dir, 'redis-7.2.7.tar.gz');
    await tar.create({ gzip: true, file: archive, cwd: payload, portable: true }, [REDIS_SOURCE_TOP_LEVEL]);
    return archive;
  }

  it('preserves the official top-level directory and finds the Makefiles', async () => {
    const dir = await mkdtemp(join(root, 'extract-'));
    const archive = await sourceArchive(dir);
    const result = await extractRedisSource({
      archivePath: archive,
      stagingDir: join(dir, 'staging'),
      topLevelDir: REDIS_SOURCE_TOP_LEVEL,
      limits: DEFAULT_REDIS_LIMITS
    });
    expect(result.topLevelPath).toBe(join(dir, 'staging', REDIS_SOURCE_TOP_LEVEL));
    expect((await stat(join(result.topLevelPath, 'Makefile'))).isFile()).toBe(true);
  });

  it('rejects traversal before it can write outside staging', async () => {
    const dir = await mkdtemp(join(root, 'extract-evil-'));
    const archive = join(dir, 'evil.tar.gz');
    const header = Buffer.alloc(512);
    header.write(`${REDIS_SOURCE_TOP_LEVEL}/../../outside/Makefile`, 0, 'utf8');
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
      extractRedisSource({
        archivePath: archive,
        stagingDir: join(dir, 'staging'),
        topLevelDir: REDIS_SOURCE_TOP_LEVEL,
        limits: DEFAULT_REDIS_LIMITS
      })
    ).rejects.toThrow(/redis\.(unsafeEntry|sourceMissing)/);
    await expect(stat(join(dir, 'outside', 'Makefile'))).rejects.toThrow();
  });

  it('rejects an archive without the expected source Makefiles', async () => {
    const dir = await mkdtemp(join(root, 'extract-empty-'));
    const archive = await sourceArchive(dir, false);
    await expect(
      extractRedisSource({ archivePath: archive, stagingDir: join(dir, 'staging'), topLevelDir: REDIS_SOURCE_TOP_LEVEL, limits: DEFAULT_REDIS_LIMITS })
    ).rejects.toThrow('redis.sourceMissing');
  });
});

describe('redis configuration', () => {
  it('renders a loopback-only foreground instance with private paths', () => {
    const home = join(root, 'config-home');
    const content = renderRedisConfig({
      installDir: join(home, 'installations', 'redis-7.2.7-linux-x64'),
      configPath: join(home, 'service', 'conf', 'redis.conf'),
      dataDir: join(home, 'service', 'data'),
      logPath: join(home, 'service', 'logs', 'redis.log'),
      pidFile: join(home, 'service', 'redis.pid')
    });
    expect(content).toContain('bind 127.0.0.1');
    expect(content).toContain('protected-mode yes');
    expect(content).toContain('port 16379');
    expect(content).toContain('daemonize no');
    expect(content).toContain('save ""');
    expect(content).toContain('maxmemory 67108864');
    expect(content).not.toContain('bind 0.0.0.0');
    expect(content).not.toContain('appendonly yes');
  });

  it('rejects relative paths and characters that could escape a quoted token', () => {
    expect(() => assertSafePath('relative/path')).toThrow();
    expect(() => assertSafePath('/tmp/"injected')).toThrow();
    expect(() => assertSafePath('/tmp/a\nbind 0.0.0.0')).toThrow();
    expect(() =>
      renderRedisConfig({
        installDir: '/tmp/install',
        configPath: '/tmp/redis.conf',
        dataDir: '/tmp/data',
        logPath: '/tmp/redis.log;',
        pidFile: '/tmp/redis.pid'
      })
    ).toThrow();
  });
});

describe('redis preflight and uninstall guards', () => {
  it('maps every missing build dependency to an actionable key', () => {
    expect(missingDependencyKeys({ compiler: false, make: false })).toEqual(['redis.compilerMissing', 'redis.makeMissing']);
    expect(missingDependencyKeys({ compiler: true, make: true })).toEqual([]);
  });

  it('refuses to uninstall a record outside the managed installations root', async () => {
    const home = await mkdtemp(join(root, 'uninstall-'));
    const storage = new FsModuleStorage(join(home, 'state'));
    const paths = redisPaths(home);
    const installer = new RedisInstaller({ storage, paths, platform: 'linux', architecture: 'x64' });
    const outside = join(root, 'outside-install');
    const fake = await fakeBinaries(join(outside, 'bin'));
    await storage.StorageSetAsync(
      'redis',
      REDIS_STORAGE_KEYS.installations,
      {
        installations: [
          {
            id: 'redis-7.2.7-linux-x64',
            moduleId: 'redis',
            version: '7.2.7',
            target: 'linux-x64',
            directory: outside,
            serverPath: fake.server,
            cliPath: fake.cli,
            archivePath: join(paths.downloads, 'redis-7.2.7.tar.gz'),
            source: REDIS_SOURCE_URL,
            sha256: REDIS_SOURCE_SHA256,
            installedAt: new Date().toISOString(),
            versionOutput: 'Redis server v=7.2.7 sha=test malloc=libc bits=64 build=test',
            cliVersionOutput: 'redis-cli 7.2.7'
          }
        ]
      },
      RedisInstallationsRecordSchema
    );
    const result = await installer.uninstall('redis-7.2.7-linux-x64', 'uninstall-outside', context('uninstall-outside'));
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.code).toBe('FORBIDDEN');
    expect((await stat(outside)).isDirectory()).toBe(true);
  });
});

describe('redis installer', () => {
  it('promotes a staged build, is idempotent, and uninstalls a stopped install', async () => {
    const home = await mkdtemp(join(root, 'install-'));
    const storage = new FsModuleStorage(join(home, 'state'));
    const paths = redisPaths(home);
    const fakes = await fakeBinaries(join(root, 'install-fakes'));
    let builds = 0;
    const installer = new RedisInstaller({
      storage,
      paths,
      platform: 'linux',
      architecture: 'x64',
      preflight: async () => ({ compiler: true, make: true }),
      download: async input => {
        await mkdir(dirname(input.destination), { recursive: true });
        await writeFile(input.destination, 'redis-source-fixture');
        return { bytes: 20, resumed: false };
      },
      build: async input => {
        builds += 1;
        const staged = join(input.stagingRoot, 'prefix', 'bin');
        await mkdir(staged, { recursive: true });
        await writeFile(join(staged, 'redis-server'), await readFile(fakes.server), { mode: 0o755 });
        await writeFile(join(staged, 'redis-cli'), await readFile(fakes.cli), { mode: 0o755 });
        return {
          stagedPrefix: join(input.stagingRoot, 'prefix'),
          versionOutput: 'Redis server v=7.2.7 sha=test malloc=libc bits=64 build=test',
          cliVersionOutput: 'redis-cli 7.2.7',
          malloc: 'libc'
        };
      }
    });
    const requestInput = { operationId: 'install', moduleId: 'redis', version: '7.2.7', platform: 'linux' as const, architecture: 'x64' as const };
    const first = await installer.install(requestInput, context('install'));
    expect(first.status, JSON.stringify(first)).toBe('completed');
    expect(builds).toBe(1);
    const record = await installer.installed();
    expect(record?.versionOutput).toContain('v=7.2.7');
    expect(record?.cliVersionOutput).toBe('redis-cli 7.2.7');
    expect((await installer.list('redis')).installations).toHaveLength(1);

    const second = await installer.install({ ...requestInput, operationId: 'install-again' }, context('install-again'));
    expect(second.status).toBe('completed');
    expect(builds).toBe(1);

    const uninstalled = await installer.uninstall(record!.id, 'uninstall', context('uninstall'));
    expect(uninstalled.status).toBe('completed');
    await expect(stat(record!.directory)).rejects.toThrow();
  });
});

describe('redis service lifecycle', () => {
  const PORT = 19379;
  const CONFLICT_PORT = 19380;

  async function harness(port: number) {
    const home = await mkdtemp(join(root, 'service-'));
    const storage = new FsModuleStorage(join(home, 'state'));
    const paths = redisPaths(home);
    const installDir = join(paths.installations, 'redis-7.2.7-linux-x64');
    const fakes = await fakeBinaries(join(installDir, 'bin'));
    await storage.StorageSetAsync(
      'redis',
      REDIS_STORAGE_KEYS.installations,
      {
        installations: [
          {
            id: 'redis-7.2.7-linux-x64',
            moduleId: 'redis',
            version: '7.2.7',
            target: 'linux-x64',
            directory: installDir,
            serverPath: fakes.server,
            cliPath: fakes.cli,
            archivePath: join(paths.downloads, 'redis-7.2.7.tar.gz'),
            source: REDIS_SOURCE_URL,
            sha256: REDIS_SOURCE_SHA256,
            installedAt: new Date().toISOString(),
            versionOutput: 'Redis server v=7.2.7 sha=test malloc=libc bits=64 build=test',
            cliVersionOutput: 'redis-cli 7.2.7'
          }
        ]
      },
      RedisInstallationsRecordSchema
    );
    const installer = new RedisInstaller({ storage, paths, platform: 'linux', architecture: 'x64' });
    const service = new RedisServiceManager({ storage, paths, installer, platform: 'linux', architecture: 'x64', port });
    return { home, paths, storage, installer, service };
  }

  it.skipIf(process.platform !== 'linux')('starts, answers PING, reports status and stops a real child process', async () => {
    const h = await harness(PORT);
    const started = await h.service.start({ operationId: 'start' }, context('start'));
    expect(started, JSON.stringify(started)).toMatchObject({ status: 'completed' });
    const status = await h.service.status('redis');
    PIDS.push(status.service.pid ?? 0);
    expect(status).toMatchObject({ installed: true, supported: true, tested: true });
    expect(status.service.state).toBe('running');
    expect(status.service.pid).toBeGreaterThan(0);
    expect(status.service.port).toBe(PORT);
    expect(status.service.bind).toBe('127.0.0.1');

    const idempotent = await h.service.start({ operationId: 'start-again' }, context('start-again'));
    expect(idempotent.status).toBe('completed');

    const log = await h.service.logs({ maxBytes: 4096 });
    expect(log.path).toContain('redis.log');
    expect(log.bytes).toBeGreaterThanOrEqual(0);

    const stopped = await h.service.stop({ operationId: 'stop' }, context('stop'));
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ status: 'completed' });
    expect((await h.service.status('redis')).service.state).toBe('stopped');
  });

  it.skipIf(process.platform !== 'linux')('refuses to start when the loopback port is already in use', async () => {
    const h = await harness(CONFLICT_PORT);
    const blocker = createServer();
    await new Promise<void>(resolve => blocker.listen(CONFLICT_PORT, '127.0.0.1', () => resolve()));
    servers.push(blocker);
    const started = await h.service.start({ operationId: 'start-conflict' }, context('start-conflict'));
    expect(started.status).toBe('failed');
    expect(started.items[0]?.error?.messageKey).toBe('redis.portInUse');
  });

  it.skipIf(process.platform !== 'linux')('refuses uninstall while running, then succeeds after stop', async () => {
    const port = 19381;
    const h = await harness(port);
    const module = new RedisModule({ storage: h.storage, home: h.home, platform: 'linux', architecture: 'x64' });
    const started = await module.handle(request('redis.start', { operationId: 'module-start' }), () => undefined);
    const statusResult = await module.handle(request('redis.status', { moduleId: 'redis' }), () => undefined);
    if (statusResult.method !== 'redis.status') throw new Error('unexpected result');
    PIDS.push(statusResult.data.service.pid ?? 0);
    expect(started.data, JSON.stringify(started.data)).toMatchObject({ status: 'completed' });

    const refused = await module.handle(request('redis.uninstall', { operationId: 'module-uninstall', installationId: 'redis-7.2.7-linux-x64' }), () => undefined);
    expect(refused.data).toMatchObject({ status: 'failed' });
    if (refused.method !== 'redis.uninstall') throw new Error('unexpected result');
    expect(refused.data.items[0]?.error?.messageKey).toBe('redis.serviceRunning');

    await module.handle(request('redis.stop', { operationId: 'module-stop' }), () => undefined);
    const removed = await module.handle(request('redis.uninstall', { operationId: 'module-uninstall-2', installationId: 'redis-7.2.7-linux-x64' }), () => undefined);
    if (removed.method !== 'redis.uninstall') throw new Error('unexpected result');
    expect(removed.data.status).toBe('completed');
  });
});
