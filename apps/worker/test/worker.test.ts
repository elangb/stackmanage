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
  const client = new WorkerClient(join(directory, 'worker.cjs'));
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
  await writeFile(join(directory, 'silent.cjs'), `process.on('message', () => { process.send({apiVersion:1,id:'unsolicited',status:'ready',pid:123}); process.send({apiVersion:1,id:'bad',status:'ready',pid:-1}); }); process.on('disconnect', () => process.exit(0));`);
  const client = new WorkerClient(join(directory, 'silent.cjs'), 300);
  try {
    await expect(client.health()).rejects.toThrow('TIMEOUT');
    const pending = expect(client.health()).rejects.toThrow('UNAVAILABLE');
    await client.close();
    await pending;
  } finally { await client.close(); }
});
