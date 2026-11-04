import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginHost } from '../src';
import { context, createPluginPackage, createTestKeys, temporaryPluginRoot, writeRegistry } from './helpers';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(run => run()));
});

async function setup(runtime: Record<string, number> = {}, logger?: { info(event: string, fields?: Record<string, unknown>): void }) {
  const dirs = await temporaryPluginRoot();
  const keys = createTestKeys();
  const registryIndex = join(dirs.registryDir, 'index.json');
  const host = new PluginHost({
    root: dirs.root,
    registryIndex,
    trustedKeys: keys.keyring,
    hostVersion: '1.0.0',
    ...(logger !== undefined ? { logger } : {}),
    runtime: {
      handshakeTimeoutMs: 4_000,
      requestTimeoutMs: 1_000,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 1_000,
      ...runtime
    }
  });
  cleanups.push(async () => {
    await host.shutdown();
    const { rm } = await import('node:fs/promises');
    await rm(dirs.base, { recursive: true, force: true });
  });
  return { dirs, keys, registryIndex, host };
}

async function publish(
  registryIndex: string,
  keys: ReturnType<typeof createTestKeys>,
  id: string,
  version: string,
  entrySource: string
) {
  const created = await createPluginPackage({
    directory: dirname(registryIndex),
    id,
    version,
    entrySource,
    signing: { privateKeyPem: keys.privateKeyPem, keyId: keys.keyId }
  });
  const { readFile } = await import('node:fs/promises');
  let existing: Array<typeof created.entry> = [];
  try {
    existing = JSON.parse(await readFile(registryIndex, 'utf8')).entries as Array<typeof created.entry>;
  } catch {
    // No registry index exists yet; keep the empty list.
  }
  await writeRegistry(registryIndex, [...existing, created.entry]);
  return created;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('waitFor timeout');
}

describe('plugin child runtime', () => {
  it('runs with a small environment, cwd inside the installed plugin and a function-free context', async () => {
    const { dirs, keys, registryIndex, host } = await setup();
    const previous = process.env['STACKMANAGE_TEST_SECRET'];
    process.env['STACKMANAGE_TEST_SECRET'] = 'must-not-leak';
    try {
      await publish(
        registryIndex,
        keys,
        'environment',
        '1.0.0',
        `export async function activate(ctx) {
  globalThis.__keys = Object.keys(ctx);
  globalThis.__cwd = process.cwd();
  globalThis.__env = Object.keys(process.env);
  globalThis.__hasHost = typeof ctx.host;
}
export async function ping() {
  return { pong: true, keys: globalThis.__keys, cwd: globalThis.__cwd, env: globalThis.__env, hasHost: globalThis.__hasHost };
}
`
      );
      expect((await host.install('environment', '1.0.0', context('install-env'))).status).toBe('completed');
      expect((await host.enable('environment', context('enable-env'))).status).toBe('completed');
      const reply = (await host.ping('environment')) as {
        pong: boolean;
        keys: string[];
        cwd: string;
        env: string[];
        hasHost: string;
      };
      expect(reply.pong).toBe(true);
      expect(reply.keys.sort()).toEqual(['apiVersion', 'pluginId']);
      expect(reply.hasHost).toBe('undefined');
      expect(reply.cwd).toBe(join(dirs.root, 'installed', 'environment', '1.0.0'));
      expect(reply.env).toContain('STACKMANAGE_PLUGIN_ID');
      expect(reply.env).not.toContain('STACKMANAGE_TEST_SECRET');
    } finally {
      if (previous === undefined) delete process.env['STACKMANAGE_TEST_SECRET'];
      else process.env['STACKMANAGE_TEST_SECRET'] = previous;
    }
  });

  it('isolates a crashing plugin from other enabled plugins', async () => {
    const { keys, registryIndex, host } = await setup();
    await publish(registryIndex, keys, 'crasher', '1.0.0', `export async function ping() { process.exit(3) }\n`);
    await publish(registryIndex, keys, 'stable', '1.0.0', `export async function ping() { return { pong: true } }\n`);

    expect((await host.install('crasher', '1.0.0', context('install-crash'))).status).toBe('completed');
    expect((await host.install('stable', '1.0.0', context('install-stable'))).status).toBe('completed');
    expect((await host.enable('crasher', context('enable-crash'))).status).toBe('completed');
    expect((await host.enable('stable', context('enable-stable'))).status).toBe('completed');

    await expect(host.ping('crasher')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await waitFor(async () => (await host.status('crasher')).runtime.state === 'failed');
    expect((await host.status('crasher')).runtime.failureReason).toBe('exit');
    expect((await host.status('stable')).runtime.state).toBe('running');
    expect(await host.ping('stable')).toMatchObject({ pong: true });
  });

  it('fails a plugin that never completes the handshake and kills its child', async () => {
    const { keys, registryIndex, host } = await setup({ handshakeTimeoutMs: 250 });
    await publish(registryIndex, keys, 'silent', '1.0.0', `await new Promise(() => {})\n`);
    expect((await host.install('silent', '1.0.0', context('install-silent'))).status).toBe('completed');
    const enabled = await host.enable('silent', context('enable-silent'));
    expect(enabled.status).toBe('failed');
    expect(enabled.items[0]?.error?.code).toBe('TIMEOUT');
    const status = await host.status('silent');
    expect(status.runtime.state).toBe('failed');
    expect(status.runtime.failureReason).toBe('handshake-timeout');
  });

  it('bounds request timeouts and rejects oversized RPC results', async () => {
    const { keys, registryIndex, host } = await setup({ requestTimeoutMs: 250, heartbeatIntervalMs: 60_000 });
    await publish(
      registryIndex,
      keys,
      'slow',
      '1.0.0',
      `export async function ping() { await new Promise(() => {}) }
export async function status() { return { data: 'x'.repeat(100000) } }
`
    );
    expect((await host.install('slow', '1.0.0', context('install-slow'))).status).toBe('completed');
    expect((await host.enable('slow', context('enable-slow'))).status).toBe('completed');

    await expect(host.ping('slow')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(host.probeStatus('slow')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await waitFor(async () => (await host.status('slow')).runtime.state === 'failed');
    await host.disable('slow', context('disable-slow'));
  });

  it('fails a plugin that stops answering heartbeats', async () => {
    const { keys, registryIndex, host } = await setup({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 100 });
    await publish(registryIndex, keys, 'heartbeat', '1.0.0', `export async function ping() { await new Promise(() => {}) }\n`);
    expect((await host.install('heartbeat', '1.0.0', context('install-heartbeat'))).status).toBe('completed');
    expect((await host.enable('heartbeat', context('enable-heartbeat'))).status).toBe('completed');
    await waitFor(async () => (await host.status('heartbeat')).runtime.state === 'failed');
    expect((await host.status('heartbeat')).runtime.failureReason).toBe('heartbeat-timeout');
  });

  it('caps and logs child stdout/stderr instead of forwarding it', async () => {
    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const { keys, registryIndex, host } = await setup(
      { maxOutputBytes: 128 },
      {
        info(event, fields) {
          events.push({ event, ...(fields !== undefined ? { fields } : {}) });
        }
      }
    );
    await publish(
      registryIndex,
      keys,
      'noisy',
      '1.0.0',
      `export async function activate() { process.stdout.write('x'.repeat(4096)); process.stderr.write('y'.repeat(4096)) }
export async function ping() { return { pong: true } }
`
    );
    expect((await host.install('noisy', '1.0.0', context('install-noisy'))).status).toBe('completed');
    expect((await host.enable('noisy', context('enable-noisy'))).status).toBe('completed');
    await waitFor(async () => events.some(item => item.event === 'plugin.output.truncated'));

    const output = events.filter(item => item.event === 'plugin.output');
    expect(output.length).toBeGreaterThan(0);
    for (const item of output) expect(String(item.fields?.['text'] ?? '').length).toBeLessThanOrEqual(128);
    expect(output.some(item => item.fields?.['stream'] === 'stdout')).toBe(true);
    expect(output.some(item => item.fields?.['stream'] === 'stderr')).toBe(true);
  });
});
