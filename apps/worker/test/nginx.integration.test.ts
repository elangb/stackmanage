/**
 * Real-network, real-compiler evidence. Skipped unless `STACKMANAGE_INTEGRATION=1`
 * on Linux x64. It downloads the official source, verifies SHA-256 and the
 * official detached signature when gpg is available, builds Nginx into a
 * temporary per-user prefix, starts it, asserts HTTP 200, reloads, stops and
 * uninstalls it.
 */
import { afterAll, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NginxModule } from '../src/modules/nginx';
import { FsModuleStorage } from '../src/shared/storage';
import { nginxPaths } from '../src/modules/nginx/paths';

const enabled = process.env['STACKMANAGE_INTEGRATION'] === '1' && process.platform === 'linux' && process.arch === 'x64';
const PORT = 18081;
const HOME = await mkdtemp(join(tmpdir(), 'stackmanage-nginx-integration-'));
let startedPid = 0;

afterAll(async () => {
  if (startedPid > 0) {
    try {
      process.kill(-startedPid, 'SIGKILL');
    } catch {
      try {
        process.kill(startedPid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
  }
  await rm(HOME, { recursive: true, force: true });
});

function context(operationId: string) {
  const events: Array<{ type: string; stageKey?: string; sequence?: number }> = [];
  return { operationId, signal: new AbortController().signal, emit: (event: unknown) => events.push(event as { type: string }), events };
}

it.skipIf(!enabled)(
  'builds the pinned official Nginx, serves HTTP 200, reloads, stops and uninstalls',
  async () => {
    const storage = new FsModuleStorage(join(HOME, 'state'));
    const module = new NginxModule({ storage, home: HOME, platform: 'linux', architecture: 'x64', logger: { info: (event, fields) => console.log(event, fields) } });

    const installed = await module.installer.install(
      { operationId: 'integration-install', moduleId: 'nginx', version: '1.30.6', platform: 'linux', architecture: 'x64' },
      context('integration-install')
    );
    expect(installed, JSON.stringify(installed)).toMatchObject({ status: 'completed' });
    const record = await module.installer.installed();
    expect(record?.versionOutput).toContain('nginx/1.30.6');
    expect(record?.binaryPath).toContain('sbin/nginx');
    expect((await stat(record!.binaryPath)).isFile()).toBe(true);

    const before = await module.service.status('nginx');
    expect(before).toMatchObject({ installed: true, supported: true, tested: true });
    expect(before.service.state).toBe('stopped');

    const started = await module.service.start({ operationId: 'integration-start', timeoutMs: 20000 }, context('integration-start'));
    expect(started, JSON.stringify(started)).toMatchObject({ status: 'completed' });
    const running = await module.service.status('nginx');
    startedPid = running.service.pid ?? 0;
    expect(running.service.state).toBe('running');
    expect(startedPid).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('StackManage default site');

    const config = await module.service.config();
    expect(config.exists).toBe(true);
    expect(config.content).toContain(`listen 127.0.0.1:${PORT};`);

    const reloaded = await module.service.reload({ operationId: 'integration-reload', timeoutMs: 15000 }, context('integration-reload'));
    expect(reloaded, JSON.stringify(reloaded)).toMatchObject({ status: 'completed' });
    const afterReload = await fetch(`http://127.0.0.1:${PORT}/`);
    expect(afterReload.status).toBe(200);

    const logs = await module.service.logs({ maxBytes: 65536 });
    expect(logs.path).toBe(join(nginxPaths(HOME).logs, 'error.log'));
    expect(logs.bytes).toBeGreaterThanOrEqual(0);

    const stopped = await module.service.stop({ operationId: 'integration-stop' }, context('integration-stop'));
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ status: 'completed' });
    startedPid = 0;
    expect((await module.service.status('nginx')).service.state).toBe('stopped');

    const uninstalled = await module.installer.uninstall(record!.id, 'integration-uninstall', context('integration-uninstall'));
    expect(uninstalled, JSON.stringify(uninstalled)).toMatchObject({ status: 'completed' });
    await expect(stat(record!.directory)).rejects.toThrow();
    expect((await module.service.status('nginx')).installed).toBe(false);
  },
  25 * 60 * 1000
);

it.skipIf(enabled)('integration evidence requires STACKMANAGE_INTEGRATION=1 on linux x64', () => {
  expect(true).toBe(true);
});
