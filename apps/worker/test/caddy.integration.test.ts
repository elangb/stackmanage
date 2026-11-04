/**
 * Real-network evidence. Skipped unless `STACKMANAGE_INTEGRATION=1`.
 *
 * Downloads the pinned Caddy release, verifies it, starts it, asserts HTTP 200,
 * then kills the worker-facing module without a graceful stop to prove that the
 * next worker reconciles the orphaned PID instead of leaving it running.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaddyModule } from '../src/modules/caddy';
import { FsModuleStorage, caddyPaths } from '../src/modules/caddy/paths';
import { DEFAULT_INSTANCE_ID } from '../src/modules/caddy/manifest';

const enabled = process.env['STACKMANAGE_INTEGRATION'] === '1' && process.platform === 'linux' && process.arch === 'x64';
const REF = { moduleId: 'caddy', installationId: 'caddy-2.11.8', instanceId: DEFAULT_INSTANCE_ID };
const PORT = 19080;

let home: string;
let startedPid = 0;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'stackmanage-integration-'));
});
afterAll(async () => {
  // Never leak the real child when an assertion fails mid-test.
  if (startedPid > 0) {
    try {
      process.kill(startedPid, 'SIGKILL');
    } catch {
      /* already stopped by the reconcile step */
    }
  }
  await rm(home, { recursive: true, force: true });
});

function context(operationId: string) {
  const events: unknown[] = [];
  return { operationId, signal: new AbortController().signal, emit: (event: unknown) => events.push(event), events };
}

it.skipIf(!enabled)(
  'installs the pinned Caddy, serves HTTP 200, and reconciles a stale PID after an ungraceful worker death',
  async () => {
    const storage = new FsModuleStorage(join(home, 'state'));
    const module = new CaddyModule({ storage, home, platform: 'linux', architecture: 'x64' });

    const installed = await module.installer.install(
      { operationId: 'integration-install', moduleId: 'caddy', version: '2.11.8', platform: 'linux', architecture: 'x64' } as never,
      context('integration-install') as never
    );
    expect(installed, JSON.stringify(installed)).toMatchObject({ status: 'completed' });
    const record = await module.installer.installed();
    expect(record?.versionOutput).toContain('v2.11.8');

    const sitesRoot = caddyPaths(home).siteRoots;
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(sitesRoot, 'default'), { recursive: true });
    await writeFile(join(sitesRoot, 'default', 'index.html'), 'stackmanage');
    const applied = await module.sites.apply(
      {
        operationId: 'integration-sites',
        sites: [
          {
            id: 'default',
            hostname: 'localhost',
            aliases: [],
            server: REF,
            root: join(sitesRoot, 'default'),
            port: PORT,
            tls: false
          }
        ]
      } as never,
      context('integration-sites') as never
    );
    expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'completed' });

    const started = await module.service.start({ ref: REF, operationId: 'integration-start', timeoutMs: 20000 } as never, context('integration-start') as never);
    expect(started, JSON.stringify(started)).toMatchObject({ status: 'completed' });
    const pid = (await module.persistedService())?.process?.pid ?? 0;
    startedPid = pid;
    expect(pid).toBeGreaterThan(0);

    // `fetch` refuses to override `host`, so request the site by its real hostname.
    const response = await fetch(`http://localhost:${PORT}/`);
    const body = await response.text();
    expect({ status: response.status, body: body.trim() }).toEqual({ status: 200, body: 'stackmanage' });

    // Simulate an abrupt worker death: no stop(), no shutdown().
    const reborn = new CaddyModule({ storage, home, platform: 'linux', architecture: 'x64' });
    const reconciled = await reborn.reconcileOnStartup();
    expect(reconciled).toMatchObject({ action: 'stopped' });
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    await reborn.shutdown();
  },
  300000
);

it.skipIf(enabled)('integration evidence requires STACKMANAGE_INTEGRATION=1 on linux x64', () => {
  expect(true).toBe(true);
});
