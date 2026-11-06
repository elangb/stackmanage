import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginHost, type PluginHostOptions } from '../src';
import { context, createPluginPackage, createTestKeys, temporaryPluginRoot, writeRegistry } from './helpers';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(run => run()));
});

async function setup(overrides: Partial<PluginHostOptions> = {}) {
  const dirs = await temporaryPluginRoot();
  const keys = createTestKeys();
  const registryIndex = join(dirs.registryDir, 'index.json');
  const host = new PluginHost({
    root: dirs.root,
    registryIndex,
    trustedKeys: keys.keyring,
    hostVersion: '1.0.0',
    runtime: {
      handshakeTimeoutMs: 4_000,
      requestTimeoutMs: 1_000,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 1_000
    },
    ...overrides
  });
  cleanups.push(async () => {
    await host.shutdown();
    const { rm } = await import('node:fs/promises');
    await rm(dirs.base, { recursive: true, force: true });
  });
  return { dirs, keys, registryIndex, host };
}

async function publish(
  index: string,
  key: ReturnType<typeof createTestKeys>,
  id = 'demo',
  version = '1.0.0',
  entrySource?: string
) {
  return createPluginPackage({
    directory: dirname(index),
    id,
    version,
    signing: { privateKeyPem: key.privateKeyPem, keyId: key.keyId },
    ...(entrySource !== undefined ? { entrySource } : {})
  });
}

describe('plugin host lifecycle', () => {
  it('exposes only entries from the verified local registry', async () => {
    const { keys, registryIndex, host } = await setup();
    const created = await publish(registryIndex, keys, 'catalog-entry', '1.0.0');
    await writeRegistry(registryIndex, [created.entry]);
    await expect(host.listCatalog()).resolves.toMatchObject([{ id: 'catalog-entry', version: '1.0.0' }]);
  });

  it('installs, enables, disables, re-enables and removes without restarting the host', async () => {
    const { dirs, keys, registryIndex, host } = await setup();
    const created = await publish(registryIndex, keys, 'demo', '1.0.0');
    await writeRegistry(registryIndex, [created.entry]);

    const installed = await host.install('demo', '1.0.0', context('install-1'));
    expect(installed.status).toBe('completed');
    expect((await host.list()).map(manifest => manifest.id)).toEqual(['demo']);

    const enabled = await host.enable('demo', context('enable-1'));
    expect(enabled.status).toBe('completed');
    const running = await host.status('demo');
    expect(running.runtime.state).toBe('running');
    expect(running.runtime.pid).toBeGreaterThan(0);
    expect(await host.ping('demo')).toMatchObject({ pong: true });

    const disabled = await host.disable('demo', context('disable-1'));
    expect(disabled.status).toBe('completed');
    const stopped = await host.status('demo');
    expect(stopped.runtime.state).toBe('stopped');
    expect(stopped.enabled).toBe(false);
    await expect(host.ping('demo')).rejects.toMatchObject({ code: 'PLUGIN_NOT_RUNNING' });

    expect((await host.enable('demo', context('enable-2'))).status).toBe('completed');
    expect(await host.ping('demo')).toMatchObject({ pong: true });

    const refused = await host.remove('demo', context('remove-running'));
    expect(refused.status).toBe('failed');
    expect(refused.items[0]?.error?.code).toBe('CONFLICT');

    expect((await host.disable('demo', context('disable-2'))).status).toBe('completed');
    const removed = await host.remove('demo', context('remove-1'));
    expect(removed.status).toBe('completed');
    expect(await host.list()).toEqual([]);
    await expect(lstat(join(dirs.root, 'installed', 'demo', '1.0.0'))).rejects.toThrow();
  });

  it('rejects a duplicate id and keeps the installed plugin intact', async () => {
    const { keys, registryIndex, host } = await setup();
    const created = await publish(registryIndex, keys);
    await writeRegistry(registryIndex, [created.entry]);

    expect((await host.install('demo', '1.0.0', context('install-1'))).status).toBe('completed');
    const duplicate = await host.install('demo', '1.0.0', context('install-2'));
    expect(duplicate.status).toBe('failed');
    expect(duplicate.items[0]?.error?.code).toBe('CONFLICT');
    expect(await host.list()).toHaveLength(1);
  });

  it('installs and enables a second plugin while the first is running', async () => {
    const { keys, registryIndex, host } = await setup();
    const first = await createPluginPackage({
      directory: dirname(registryIndex),
      id: 'first',
      version: '1.0.0',
      signing: { privateKeyPem: keys.privateKeyPem, keyId: keys.keyId }
    });
    const second = await createPluginPackage({
      directory: dirname(registryIndex),
      id: 'second',
      version: '2.0.0',
      signing: { privateKeyPem: keys.privateKeyPem, keyId: keys.keyId }
    });
    await writeRegistry(registryIndex, [first.entry, second.entry]);

    expect((await host.install('first', '1.0.0', context('install-first'))).status).toBe('completed');
    expect((await host.enable('first', context('enable-first'))).status).toBe('completed');
    expect((await host.install('second', '2.0.0', context('install-second'))).status).toBe('completed');
    expect((await host.enable('second', context('enable-second'))).status).toBe('completed');

    expect(await host.ping('first')).toMatchObject({ pong: true });
    expect(await host.ping('second')).toMatchObject({ pong: true });
    expect((await host.listInstalled()).filter(item => item.runtime.state === 'running')).toHaveLength(2);
  });

  it('persists installation metadata under the plugin root, not shared application config', async () => {
    const { dirs, keys, registryIndex, host } = await setup();
    const created = await publish(registryIndex, keys);
    await writeRegistry(registryIndex, [created.entry]);
    await host.install('demo', '1.0.0', context('install-1'));
    const state = await lstat(join(dirs.root, 'state', 'plugins.json'));
    expect(state.isFile()).toBe(true);
  });
});
