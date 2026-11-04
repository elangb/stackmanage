/**
 * Real HTTPS + hosts evidence. Skipped unless STACKMANAGE_INTEGRATION=1 on Linux x64.
 * Uses a temporary hosts file and NSS database; never touches the real system files.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { CaddyModule } from '../src/modules/caddy';
import { FsModuleStorage } from '../src/modules/caddy/paths';

const enabled = process.env['STACKMANAGE_INTEGRATION'] === '1' && process.platform === 'linux' && process.arch === 'x64';
const REF = { moduleId: 'caddy', installationId: 'caddy-2.11.8', instanceId: 'default' };
const PORT = 19443;

let root: string;
let home: string;
let hostsPath: string;
let nssDb: string;
let module: CaddyModule | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackmanage-tls-'));
  home = join(root, 'caddy');
  hostsPath = join(root, 'hosts');
  nssDb = join(root, 'nssdb');
  await writeFile(hostsPath, '127.0.0.1 unrelated.test\n');
});

afterAll(async () => {
  await module?.shutdown().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

function context(id: string) {
  return { operationId: id, signal: new AbortController().signal, emit: () => undefined };
}

function httpsGet(ca: Buffer): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: PORT, path: '/', method: 'GET', servername: 'shop.test', ca, headers: { host: `shop.test:${PORT}` } },
      response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: body.trim() }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

it.skipIf(!enabled)(
  'applies a .test site with internal TLS, updates hosts, serves HTTPS, trusts the CA and removes the hosts entry',
  async () => {
    const storage = new FsModuleStorage(join(root, 'state'));
    module = new CaddyModule({ storage, home, platform: 'linux', architecture: 'x64', hostsPath, nssDbPath: nssDb, userHome: root });
    const installed = await module.installer.install({ operationId: 'tls-install', moduleId: 'caddy', version: '2.11.8', platform: 'linux', architecture: 'x64' } as never, context('tls-install') as never);
    expect(installed, JSON.stringify(installed)).toMatchObject({ status: 'completed' });

    const siteRoot = join(home, 'sites', 'shop');
    await mkdir(siteRoot, { recursive: true });
    await writeFile(join(siteRoot, 'index.html'), 'tls-ok');
    const applied = await module.sites.apply(
      {
        operationId: 'tls-sites',
        sites: [{ id: 'shop', hostname: 'shop.test', aliases: ['www.shop.test'], server: REF, root: siteRoot, port: PORT, tls: true }]
      } as never,
      context('tls-sites') as never
    );
    expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'completed' });
    const hosts = await readFile(hostsPath, 'utf8');
    expect(hosts).toContain('unrelated.test');
    expect(hosts).toContain('shop.test');
    expect(hosts).toContain('www.shop.test');

    const started = await module.service.start({ ref: REF, operationId: 'tls-start', timeoutMs: 20000 } as never, context('tls-start') as never);
    expect(started, JSON.stringify(started)).toMatchObject({ status: 'completed' });

    const before = await module.certificates.status();
    expect(before.exists).toBe(true);
    expect(before.browserTrust).toBe('untrusted');
    const ca = await readFile(before.authorityPath);
    expect(await httpsGet(ca)).toEqual({ status: 200, body: 'tls-ok' });

    const trusted = await module.certificates.trust(context('tls-trust') as never);
    expect(trusted.status, JSON.stringify(trusted)).toBe('completed');
    expect((await module.certificates.status()).browserTrust).toBe('trusted');

    await module.service.stop({ ref: REF, operationId: 'tls-stop' } as never, context('tls-stop') as never);
    const removed = await module.sites.remove({ operationId: 'tls-remove', siteId: 'shop' }, context('tls-remove') as never);
    expect(removed, JSON.stringify(removed)).toMatchObject({ status: 'completed' });
    const after = await readFile(hostsPath, 'utf8');
    expect(after).toContain('unrelated.test');
    expect(after).not.toContain('shop.test');
  },
  300000
);

it.skipIf(enabled)('TLS integration requires STACKMANAGE_INTEGRATION=1 on linux x64', () => {
  expect(true).toBe(true);
});
