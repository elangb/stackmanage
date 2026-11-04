import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerClient } from '../src/client';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stackmanage-worker-test-'));
  await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], outfile: join(directory, 'worker.cjs'), bundle: true, platform: 'node', format: 'cjs' });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
it('round-trips concurrent requests through a real fork and confirms shutdown', async () => {
  const client = new WorkerClient({ entry: join(directory, 'worker.cjs') });
  try {
    const replies = await Promise.all([client.health(), client.health(), client.health()]);
    expect(new Set(replies.map(reply => reply.id)).size).toBe(3);
    expect(replies.every(reply => reply.pid !== process.pid && reply.status === 'ready')).toBe(true);
    await client.close();
    await expect(client.health()).rejects.toThrow('UNAVAILABLE');
    await client.close();
  } finally { await client.close(); }
});
it('times out malformed/uncorrelated responses and settles pending requests on close', async () => {
  await writeFile(join(directory, 'silent.cjs'), `const send = message => { if (!process.connected) return; try { process.send(message, () => undefined); } catch { /* host already gone */ } }; process.on('message', () => { send({apiVersion:1,id:'unsolicited',status:'ready',pid:123}); send({apiVersion:1,id:'bad',status:'ready',pid:-1}); }); process.on('disconnect', () => process.exit(0));`);
  const client = new WorkerClient({ entry: join(directory, 'silent.cjs'), requestTimeoutMs: 300 });
  try {
    await expect(client.health()).rejects.toThrow('TIMEOUT');
    const pending = expect(client.health()).rejects.toThrow('UNAVAILABLE');
    await client.close();
    await pending;
  } finally { await client.close(); }
});

it('dispatches typed runtime reads through the real fork worker', async () => {
  const client = new WorkerClient({ entry: join(directory, 'worker.cjs') });
  try {
    const versions = await client.runtimeVersions({ moduleId: 'node' });
    expect(versions.ok).toBe(true);
    if (!versions.ok) throw new Error('runtime versions failed');
    expect(versions.result.method).toBe('runtime.versions');
    if (versions.result.method !== 'runtime.versions') throw new Error('unexpected result');
    expect(versions.result.data.pinnedVersion).toBe('24.22.2');
    expect(versions.result.data.versions).toHaveLength(4);
    const status = await client.runtimeStatus({ moduleId: 'node' });
    expect(status.ok).toBe(true);
    if (!status.ok || status.result.method !== 'runtime.status') throw new Error('runtime status failed');
    expect(status.result.data.installed).toBe(false);
    const rejected = await client.runtimeUninstall({ operationId: 'missing', installationId: 'node-missing' });
    expect(rejected.ok).toBe(true);
    if (rejected.ok && rejected.result.method === 'runtime.uninstall') expect(rejected.result.data.status).toBe('failed');
  } finally {
    await client.close();
  }
}, 30000);
