import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import type { OperationContext } from '@stackmanage/core';
import { FsModuleStorage } from '../src/modules/caddy/paths';
import { downloadVerified, fileDigest } from '../src/modules/node/download';
import { extractNodeArchive } from '../src/modules/node/extract';
import { NodeInstaller, NODE_RELEASE, parseShasums, type NodeRelease } from '../src/modules/node/installer';
import { NODE_ASSETS, NODE_SHASUMS_URL, NODE_VERSION, type NodeAsset } from '../src/modules/node/manifest';
import { nodePaths } from '../src/modules/node/paths';
import { NODE_STORAGE_KEYS, NodeInstallationsRecordSchema } from '../src/modules/node/state';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackmanage-node-test-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const TOP = `node-v${NODE_VERSION}-linux-x64`;

function context(operationId: string): OperationContext & { events: Array<{ type: string; sequence?: number }> } {
  const events: Array<{ type: string; sequence?: number }> = [];
  return { operationId, signal: new AbortController().signal, emit: event => events.push(event as { type: string; sequence?: number }), events };
}

async function makeArchive(dir: string): Promise<{ archive: string; digest: string }> {
  const payload = join(dir, 'payload');
  const topLevel = join(payload, TOP);
  await mkdir(join(topLevel, 'bin'), { recursive: true });
  await writeFile(join(topLevel, 'bin', 'node'), `#!${process.execPath}\nconsole.log('v${NODE_VERSION}');\n`, { mode: 0o755 });
  await chmod(join(topLevel, 'bin', 'node'), 0o755);
  await writeFile(join(topLevel, 'LICENSE'), 'MIT\n');
  const archive = join(dir, `${TOP}.tar.gz`);
  await tar.create({ gzip: true, file: archive, cwd: payload, portable: true }, [TOP]);
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  return { archive, digest };
}

async function fakeRelease(dir: string): Promise<NodeRelease> {
  const { digest } = await makeArchive(dir);
  const asset: NodeAsset = {
    asset: `${TOP}.tar.gz`,
    topLevelDir: TOP,
    binaryRelativePath: 'bin/node',
    sha256: digest,
    archive: 'tar.gz'
  };
  return {
    version: NODE_VERSION,
    baseUrl: 'https://nodejs.org/dist/v24.22.2/',
    shasumsUrl: NODE_SHASUMS_URL,
    assets: { ...NODE_ASSETS, 'linux-x64': asset }
  };
}

describe('node download', () => {
  it('resumes a partial file and verifies the digest', async () => {
    const body = Buffer.from('n'.repeat(4096));
    const expected = createHash('sha256').update(body).digest('hex');
    const dir = await mkdtemp(join(root, 'resume-'));
    const destination = join(dir, 'asset.bin');
    await writeFile(`${destination}.part`, body.subarray(0, 1024));
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.['range'];
      if (range === 'bytes=1024-') return new Response(body.subarray(1024), { status: 206, headers: { 'content-length': String(body.length - 1024) } });
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    };
    const result = await downloadVerified({
      url: `https://nodejs.org/dist/v${NODE_VERSION}/asset.bin`,
      destination,
      expectedDigest: expected,
      limits: { maxDownloadBytes: 1_000_000, maxRedirects: 5, idleTimeoutMs: 5_000, maxExtractedEntries: 100, maxExtractedFileBytes: 1_000_000, maxExtractedTotalBytes: 2_000_000, versionTimeoutMs: 5_000 },
      signal: new AbortController().signal,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.resumed).toBe(true);
    expect(await fileDigest(destination)).toBe(expected);
  });

  it('refuses a symlinked destination instead of writing through it', async () => {
    const dir = await mkdtemp(join(root, 'symlink-download-'));
    const target = join(dir, 'outside.bin');
    await writeFile(target, 'keep');
    await symlink(target, join(dir, 'asset.bin'));
    await expect(
      downloadVerified({
        url: 'https://nodejs.org/asset.bin',
        destination: join(dir, 'asset.bin'),
        expectedDigest: 'a'.repeat(64),
        limits: { maxDownloadBytes: 1_000_000, maxRedirects: 5, idleTimeoutMs: 5_000, maxExtractedEntries: 100, maxExtractedFileBytes: 1_000_000, maxExtractedTotalBytes: 2_000_000, versionTimeoutMs: 5_000 },
        signal: new AbortController().signal
      })
    ).rejects.toThrow('runtime.unsafeEntry');
    expect(await readFile(target, 'utf8')).toBe('keep');
  });

  it('rejects a digest mismatch, a foreign origin and an oversized body', async () => {
    const dir = await mkdtemp(join(root, 'bad-'));
    const limits = { maxDownloadBytes: 100, maxRedirects: 3, idleTimeoutMs: 5_000, maxExtractedEntries: 100, maxExtractedFileBytes: 1_000_000, maxExtractedTotalBytes: 2_000_000, versionTimeoutMs: 5_000 };
    const content = async () => new Response(Buffer.alloc(64), { status: 200 });
    await expect(
      downloadVerified({ url: `https://nodejs.org/x`, destination: join(dir, 'a'), expectedDigest: 'a'.repeat(64), limits, signal: new AbortController().signal, fetchImpl: content as unknown as typeof fetch })
    ).rejects.toThrow('runtime.digestMismatch');
    await expect(
      downloadVerified({ url: 'https://evil.test/x', destination: join(dir, 'b'), expectedDigest: 'a'.repeat(64), limits, signal: new AbortController().signal })
    ).rejects.toThrow('runtime.invalidUrl');
    const big = async () => new Response(Buffer.alloc(2048), { status: 200, headers: { 'content-length': '2048' } });
    await expect(
      downloadVerified({ url: `https://nodejs.org/big`, destination: join(dir, 'c'), expectedDigest: 'a'.repeat(64), limits, signal: new AbortController().signal, fetchImpl: big as unknown as typeof fetch })
    ).rejects.toThrow('runtime.downloadTooLarge');
  });
});

describe('node extraction', () => {
  it('preserves the top-level directory and the required regular binary', async () => {
    const dir = await mkdtemp(join(root, 'extract-'));
    const { archive } = await makeArchive(dir);
    const staging = join(dir, 'staging');
    const result = await extractNodeArchive({
      archivePath: archive,
      kind: 'tar.gz',
      stagingDir: staging,
      topLevelDir: TOP,
      binaryRelativePath: 'bin/node',
      limits: { maxDownloadBytes: 1_000_000, maxRedirects: 5, idleTimeoutMs: 5_000, maxExtractedEntries: 100, maxExtractedFileBytes: 1_000_000, maxExtractedTotalBytes: 2_000_000, versionTimeoutMs: 5_000 }
    });
    expect(result.topLevelPath).toBe(join(staging, TOP));
    expect((await stat(join(staging, TOP, 'bin', 'node'))).isFile()).toBe(true);
  });

  it('rejects a traversal entry before it can write outside staging', async () => {
    const dir = await mkdtemp(join(root, 'traverse-'));
    const archive = join(dir, 'evil.tar.gz');
    const header = Buffer.alloc(512);
    header.write(`${TOP}/../../outside/bin/node`, 0, 'utf8');
    header.write('0000644\0', 100, 'utf8');
    header.write('00000000002\0', 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header.write(`${'0'.repeat(11)}\0`, 148, 'utf8');
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    const body = Buffer.concat([header, Buffer.alloc(1024)]);
    const { gzipSync } = await import('node:zlib');
    await writeFile(archive, gzipSync(body));
    await expect(
      extractNodeArchive({
        archivePath: archive,
        kind: 'tar.gz',
        stagingDir: join(dir, 'staging'),
        topLevelDir: TOP,
        binaryRelativePath: 'bin/node',
        limits: { maxDownloadBytes: 1_000_000, maxRedirects: 5, idleTimeoutMs: 5_000, maxExtractedEntries: 100, maxExtractedFileBytes: 1_000_000, maxExtractedTotalBytes: 2_000_000, versionTimeoutMs: 5_000 }
      })
    ).rejects.toThrow(/runtime\.(unsafeEntry|binaryMissing)/);
    await expect(stat(join(dir, 'outside', 'bin', 'node'))).rejects.toThrow();
  });

  it('never materialises a symlink and refuses a linked binary', async () => {
    const dir = await mkdtemp(join(root, 'symlink-'));
    const payload = join(dir, 'payload');
    const topLevel = join(payload, TOP);
    await mkdir(join(topLevel, 'bin'), { recursive: true });
    await writeFile(join(payload, 'outside-node'), 'x');
    await symlink('../../outside-node', join(topLevel, 'bin', 'node'));
    const archive = join(dir, 'link.tar.gz');
    await tar.create({ gzip: true, file: archive, cwd: payload, portable: true }, [TOP]);
    const staging = join(dir, 'staging');
    await expect(
      extractNodeArchive({
        archivePath: archive,
        kind: 'tar.gz',
        stagingDir: staging,
        topLevelDir: TOP,
        binaryRelativePath: 'bin/node',
        limits: { maxDownloadBytes: 1_000_000, maxRedirects: 5, idleTimeoutMs: 5_000, maxExtractedEntries: 100, maxExtractedFileBytes: 1_000_000, maxExtractedTotalBytes: 2_000_000, versionTimeoutMs: 5_000 }
      })
    ).rejects.toThrow('runtime.binaryMissing');
    await expect(stat(join(staging, TOP, 'bin', 'node'))).rejects.toThrow();
  });
});

describe('node installer', () => {
  async function harness(release: NodeRelease, fetchImpl?: typeof fetch) {
    const home = await mkdtemp(join(root, 'home-'));
    const storage = new FsModuleStorage(join(home, 'state'));
    const installer = new NodeInstaller({
      storage,
      paths: nodePaths(home),
      platform: 'linux',
      architecture: 'x64',
      release,
      verifyChecksumList: false,
      ...(fetchImpl !== undefined ? { fetchImpl } : {})
    });
    return { home, storage, installer };
  }

  it('is idempotent, validates the staged version, and cleans up on uninstall', async () => {
    const releaseDir = await mkdtemp(join(root, 'release-'));
    const release = await fakeRelease(releaseDir);
    const bytes = await readFile(join(releaseDir, `${TOP}.tar.gz`));
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    };
    const { home, installer } = await harness(release, fetchImpl as unknown as typeof fetch);
    const first = await installer.install({ operationId: 'node-install-1', moduleId: 'node', version: NODE_VERSION, platform: 'linux', architecture: 'x64' }, context('node-install-1'));
    expect(first, JSON.stringify(first)).toMatchObject({ status: 'completed' });
    expect(calls).toBe(1);
    const status = await installer.status('node');
    expect(status.installed).toBe(true);
    expect(status.installation?.binaryPath).toBe(join(home, 'installations', TOP, 'bin', 'node'));
    expect(status.pathPrepend).toEqual([join(home, 'installations', TOP, 'bin')]);
    const second = await installer.install({ operationId: 'node-install-2', moduleId: 'node', version: NODE_VERSION, platform: 'linux', architecture: 'x64' }, context('node-install-2'));
    expect(second).toMatchObject({ status: 'completed' });
    expect(calls).toBe(1);
    const removed = await installer.uninstall(status.installation?.id ?? '', 'node-remove', context('node-remove'));
    expect(removed, JSON.stringify(removed)).toMatchObject({ status: 'completed' });
    await expect(stat(join(home, 'installations', TOP))).rejects.toThrow();
    expect(await installer.list('node')).toEqual({ moduleId: 'node', installations: [] });
  });

  it('returns CONFLICT for a different install while one is running', async () => {
    const releaseDir = await mkdtemp(join(root, 'release-conflict-'));
    const release = await fakeRelease(releaseDir);
    const bytes = await readFile(join(releaseDir, `${TOP}.tar.gz`));
    let releaseFetch!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseFetch = resolve;
    });
    const fetchImpl = async () => {
      await gate;
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    };
    const { installer } = await harness(release, fetchImpl as unknown as typeof fetch);
    const first = installer.install({ operationId: 'node-a', moduleId: 'node', version: NODE_VERSION, platform: 'linux', architecture: 'x64' }, context('node-a'));
    await Promise.resolve();
    const second = await installer.install({ operationId: 'node-b', moduleId: 'node', version: NODE_VERSION, platform: 'linux', architecture: 'x64' }, context('node-b'));
    expect(second.status).toBe('failed');
    expect(second.items[0]?.error?.code).toBe('CONFLICT');
    releaseFetch();
    expect(await first).toMatchObject({ status: 'completed' });
  });

  it('refuses to uninstall a record outside the managed root', async () => {
    const releaseDir = await mkdtemp(join(root, 'release-guard-'));
    const release = await fakeRelease(releaseDir);
    const { home, storage, installer } = await harness(release);
    const outside = join(home, 'outside');
    await mkdir(join(outside, 'bin'), { recursive: true });
    await writeFile(join(outside, 'bin', 'node'), 'keep');
    await storage.StorageSetAsync(
      'node',
      NODE_STORAGE_KEYS.installations,
      {
        installations: [
          {
            id: `node-${NODE_VERSION}-linux-x64`,
            moduleId: 'node',
            version: NODE_VERSION,
            target: 'linux-x64',
            directory: outside,
            binaryPath: join(outside, 'bin', 'node'),
            archivePath: join(home, 'downloads', 'x.tar.gz'),
            installedAt: new Date().toISOString(),
            versionOutput: `v${NODE_VERSION}`,
            sha256: 'a'.repeat(64)
          }
        ]
      },
      NodeInstallationsRecordSchema
    );
    const result = await installer.uninstall(`node-${NODE_VERSION}-linux-x64`, 'node-guard', context('node-guard'));
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.code).toBe('FORBIDDEN');
    expect((await stat(join(outside, 'bin', 'node'))).isFile()).toBe(true);
  });

  it('pins all four official artifacts and marks only Linux x64 as tested', async () => {
    const { installer } = await harness(NODE_RELEASE);
    const view = installer.versionsView('node');
    expect(view.pinnedVersion).toBe(NODE_VERSION);
    expect(view.versions).toHaveLength(4);
    expect(view.versions.find(version => version.platform === 'linux' && version.architecture === 'x64')?.tested).toBe(true);
    expect(view.versions.filter(version => !(version.platform === 'linux' && version.architecture === 'x64')).every(version => !version.tested)).toBe(true);
    expect(view.versions.find(version => version.platform === 'win32' && version.architecture === 'arm64')?.sha256).toBe('f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468');
  });
});

describe('checksum list parsing', () => {
  it('reads the official two-space filename format', () => {
    const parsed = parseShasums(`${'a'.repeat(64)}  node-v24.22.2-linux-x64.tar.gz\n${'b'.repeat(64)} *node-v24.22.2-win-x64.zip\n`);
    expect(parsed.get('node-v24.22.2-linux-x64.tar.gz')).toBe('a'.repeat(64));
    expect(parsed.get('node-v24.22.2-win-x64.zip')).toBe('b'.repeat(64));
  });
});
