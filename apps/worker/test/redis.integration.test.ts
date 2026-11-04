/**
 * Real-network, real-compiler evidence. Skipped unless `STACKMANAGE_INTEGRATION=1`
 * on Linux x64. It downloads the official source through the shared proxy-aware
 * HTTPS path, verifies SHA-256, builds Redis into a temporary per-user prefix,
 * starts it, asserts PING/PONG and SET/GET through the managed redis-cli, stops
 * and uninstalls it.
 */
import { afterAll, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RedisModule } from '../src/modules/redis';
import { FsModuleStorage } from '../src/shared/storage';
import { redisPaths } from '../src/modules/redis/paths';
import { redisChildEnvironment, runRedisBinary } from '../src/modules/redis/run';

const enabled = process.env['STACKMANAGE_INTEGRATION'] === '1' && process.platform === 'linux' && process.arch === 'x64';
const HOME = await mkdtemp(join(tmpdir(), 'stackmanage-redis-integration-'));
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
  'builds the pinned official Redis, answers PING, SET/GET, stops and uninstalls',
  async () => {
    const storage = new FsModuleStorage(join(HOME, 'state'));
    const module = new RedisModule({ storage, home: HOME, platform: 'linux', architecture: 'x64', logger: { info: (event, fields) => console.log(event, fields) } });

    const installed = await module.installer.install(
      { operationId: 'integration-install', moduleId: 'redis', version: '7.2.7', platform: 'linux', architecture: 'x64' },
      context('integration-install')
    );
    expect(installed, JSON.stringify(installed)).toMatchObject({ status: 'completed' });
    const record = await module.installer.installed();
    expect(record?.versionOutput).toContain('v=7.2.7');
    expect(record?.cliVersionOutput).toBe('redis-cli 7.2.7');
    console.log('redis.integration.artifacts', record?.versionOutput, record?.cliVersionOutput);
    expect(record?.serverPath).toContain('bin/redis-server');
    expect((await stat(record!.serverPath)).isFile()).toBe(true);
    expect((await stat(record!.cliPath)).isFile()).toBe(true);

    const before = await module.service.status('redis');
    expect(before).toMatchObject({ installed: true, supported: true, tested: true });
    expect(before.service.state).toBe('stopped');

    const started = await module.service.start({ operationId: 'integration-start', timeoutMs: 20000 }, context('integration-start'));
    expect(started, JSON.stringify(started)).toMatchObject({ status: 'completed' });
    const running = await module.service.status('redis');
    startedPid = running.service.pid ?? 0;
    expect(running.service.state).toBe('running');
    expect(startedPid).toBeGreaterThan(0);
    expect(running.service.port).toBe(16379);
    expect(running.service.bind).toBe('127.0.0.1');

    const env = redisChildEnvironment('integration', HOME);
    const ping = await runRedisBinary(record!.cliPath, ['-h', '127.0.0.1', '-p', '16379', 'ping'], HOME, 5000, env);
    expect(ping.stdout.trim()).toBe('PONG');
    const set = await runRedisBinary(record!.cliPath, ['-h', '127.0.0.1', '-p', '16379', 'set', 'stackmanage:phase6', 'ok'], HOME, 5000, env);
    expect(set.stdout.trim()).toBe('OK');
    const get = await runRedisBinary(record!.cliPath, ['-h', '127.0.0.1', '-p', '16379', 'get', 'stackmanage:phase6'], HOME, 5000, env);
    expect(get.stdout.trim()).toBe('ok');

    const logs = await module.service.logs({ maxBytes: 65536 });
    expect(logs.path).toBe(join(redisPaths(HOME).logs, 'redis.log'));
    expect(logs.bytes).toBeGreaterThan(0);

    const stopped = await module.service.stop({ operationId: 'integration-stop' }, context('integration-stop'));
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ status: 'completed' });
    startedPid = 0;
    expect((await module.service.status('redis')).service.state).toBe('stopped');

    const uninstalled = await module.installer.uninstall(record!.id, 'integration-uninstall', context('integration-uninstall'));
    expect(uninstalled, JSON.stringify(uninstalled)).toMatchObject({ status: 'completed' });
    await expect(stat(record!.directory)).rejects.toThrow();
    expect((await module.service.status('redis')).installed).toBe(false);
  },
  25 * 60 * 1000
);

it.skipIf(enabled)('integration evidence requires STACKMANAGE_INTEGRATION=1 on linux x64', () => {
  expect(true).toBe(true);
});
