/**
 * Real-network evidence for the pinned Node.js runtime. Skipped unless
 * `STACKMANAGE_INTEGRATION=1` on Linux x64.
 *
 * Downloads the official `nodejs.org` archive and SHASUMS256.txt, verifies the
 * pinned SHA-256, runs the installed binary, proves a second install is
 * idempotent, then uninstalls and asserts that the managed directory is gone.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '@stackmanage/core';
import { FsModuleStorage } from '../src/modules/caddy/paths';
import { downloadText } from '../src/modules/node/download';
import { NodeInstaller, NODE_RELEASE, parseShasums } from '../src/modules/node/installer';
import { DEFAULT_NODE_LIMITS, NODE_ASSETS, NODE_SHASUMS_URL, NODE_VERSION, NODE_RELEASE_BASE_URL } from '../src/modules/node/manifest';
import { nodePaths } from '../src/modules/node/paths';
import { runNodeBinary } from '../src/modules/node/run';

const enabled = process.env['STACKMANAGE_INTEGRATION'] === '1' && process.platform === 'linux' && process.arch === 'x64';

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'stackmanage-node-integration-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

function context(operationId: string): OperationContext & { events: unknown[] } {
  const events: unknown[] = [];
  return { operationId, signal: new AbortController().signal, emit: event => events.push(event), events };
}

it.skipIf(!enabled)(
  'installs the pinned Node.js v24.22.2 from nodejs.org, verifies SHA-256, runs --version, and cleans up',
  async () => {
    const signal = new AbortController().signal;
    const shasums = parseShasums(
      await downloadText({ url: NODE_SHASUMS_URL, limits: DEFAULT_NODE_LIMITS, signal })
    );
    const expectedAsset = NODE_ASSETS['linux-x64'];
    expect(shasums.get(expectedAsset.asset)).toBe(expectedAsset.sha256);
    expect(expectedAsset.sha256).toBe('361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9');

    let fetches = 0;
    const countingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetches += 1;
      return fetch(input, init);
    }) as typeof fetch;
    const storage = new FsModuleStorage(join(home, 'state'));
    const installer = new NodeInstaller({
      storage,
      paths: nodePaths(home),
      platform: 'linux',
      architecture: 'x64',
      fetchImpl: countingFetch
    });
    expect(installer.versionsView('node').pinnedVersion).toBe(NODE_VERSION);
    expect(installer.versionsView('node').tested).toBe(true);

    const first = await installer.install(
      { operationId: 'integration-node-install', moduleId: 'node', version: NODE_VERSION, platform: 'linux', architecture: 'x64' },
      context('integration-node-install')
    );
    expect(first, JSON.stringify(first)).toMatchObject({ status: 'completed' });
    expect(first.warnings, JSON.stringify(first.warnings)).toEqual([]);

    const status = await installer.status('node');
    expect(status.installed).toBe(true);
    const installation = status.installation;
    expect(installation).toBeDefined();
    expect(installation?.versionOutput).toBe(`v${NODE_VERSION}`);
    expect(installation?.binaryPath).toBe(join(home, 'installations', expectedAsset.topLevelDir, 'bin', 'node'));
    expect(status.pathPrepend).toEqual([join(home, 'installations', expectedAsset.topLevelDir, 'bin')]);

    const probe = await runNodeBinary(installation?.binaryPath ?? '', ['--version'], home, 10_000, { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home });
    expect(probe.code).toBe(0);
    expect(probe.stdout.trim()).toBe(`v${NODE_VERSION}`);
    expect((await stat(installation?.binaryPath ?? '')).isFile()).toBe(true);

    const fetchesAfterFirst = fetches;
    const second = await installer.install(
      { operationId: 'integration-node-install-2', moduleId: 'node', version: NODE_VERSION, platform: 'linux', architecture: 'x64' },
      context('integration-node-install-2')
    );
    expect(second).toMatchObject({ status: 'completed' });
    expect(fetches).toBe(fetchesAfterFirst);

    const removed = await installer.uninstall(installation?.id ?? '', 'integration-node-remove', context('integration-node-remove'));
    expect(removed, JSON.stringify(removed)).toMatchObject({ status: 'completed' });
    await expect(stat(join(home, 'installations', expectedAsset.topLevelDir))).rejects.toThrow();
    expect(await installer.list('node')).toEqual({ moduleId: 'node', installations: [] });
    expect(NODE_RELEASE_BASE_URL).toContain('nodejs.org');
    expect(NODE_RELEASE.version).toBe(NODE_VERSION);
  },
  600_000
);

it.skipIf(enabled)('integration evidence requires STACKMANAGE_INTEGRATION=1 on linux x64', () => {
  expect(true).toBe(true);
});
