import { spawn } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { caddyService, createHarness, parseToolResult, stateFile, writeJson, type Harness } from './helpers.js';

const harnesses: Harness[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

async function harness(): Promise<Harness> {
  const created = await createHarness();
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await Promise.all(harnesses.splice(0).map(item => item.close()));
});

function startListener(): Promise<{ child: ReturnType<typeof spawn>; port: number; token: string }> {
  const token = 'f'.repeat(32);
  const script = "const net=require('node:net');const s=net.createServer(()=>{});s.listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)+'\\n'));";
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, STACKMANAGE_PROC_TOKEN: token },
    stdio: ['ignore', 'pipe', 'ignore']
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('listener did not start')), 5_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const line = output.split('\n')[0];
      if (line === undefined || line === '') return;
      clearTimeout(timer);
      resolve({ child, port: Number(line), token });
    });
    child.once('error', reject);
  });
}

async function processFacts(pid: number): Promise<{ executable: string; startToken: string }> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  const startToken = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/)[19];
  const executable = (await readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '');
  if (startToken === undefined) throw new Error('missing start token');
  return { executable, startToken };
}

describe('services.status with a real verified process', () => {
  it.skipIf(process.platform !== 'linux')('claims running only when PID identity, token and loopback readiness match', async () => {
    const h = await harness();
    const listener = await startListener();
    const facts = await processFacts(listener.child.pid as number);
    const record = caddyService(h.roots, {
      pid: listener.child.pid,
      executable: facts.executable,
      startToken: facts.startToken,
      procToken: listener.token,
      port: listener.port
    });
    await writeJson(stateFile(h.roots, 'caddy', 'service-default'), record);
    const result = parseToolResult(await h.client.callTool({ name: 'services.status', arguments: { moduleId: 'caddy' } })) as {
      modules: Array<{ services: Array<{ state: string; identity: string; portListening: boolean }> }>;
    };
    const service = result.modules[0]?.services[0];
    expect(service?.identity).toBe('verified');
    expect(service?.portListening).toBe(true);
    expect(service?.state).toBe('running');
  });

  it.skipIf(process.platform !== 'linux')('does not claim running when the process token differs', async () => {
    const h = await harness();
    const listener = await startListener();
    const facts = await processFacts(listener.child.pid as number);
    await writeJson(
      stateFile(h.roots, 'caddy', 'service-default'),
      caddyService(h.roots, {
        pid: listener.child.pid,
        executable: facts.executable,
        startToken: facts.startToken,
        procToken: '0'.repeat(32),
        port: listener.port
      })
    );
    const result = parseToolResult(await h.client.callTool({ name: 'services.status', arguments: { moduleId: 'caddy' } })) as {
      modules: Array<{ services: Array<{ state: string; identity: string; identityReason: string }> }>;
    };
    const service = result.modules[0]?.services[0];
    expect(service?.identity).toBe('mismatch');
    expect(service?.identityReason).toBe('proc-token');
    expect(service?.state).toBe('unknown');
  });
});
