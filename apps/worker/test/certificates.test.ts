import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CaddyCertificates } from '../src/modules/caddy/certificates';

const certutil = spawnSync('certutil', ['-H'], { stdio: 'ignore' }).error === undefined;
const fixture = new URL('./fixtures/test-ca.crt', import.meta.url).pathname;
let root: string;
let home: string;
let nssDb: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackmanage-cert-'));
  home = join(root, 'caddy');
  nssDb = join(root, 'nssdb');
  const authority = join(home, '.local', 'share', 'caddy', 'pki', 'authorities', 'local');
  await mkdir(authority, { recursive: true });
  await copyFile(fixture, join(authority, 'root.crt'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(id: string) {
  const events: unknown[] = [];
  return { operationId: id, signal: new AbortController().signal, emit: (event: unknown) => events.push(event), events };
}

describe.skipIf(!certutil)('Caddy local CA trust', () => {
  it('reports untrusted before trust and trusted after adding the CA to an isolated NSS database', async () => {
    const certificates = new CaddyCertificates({ home, nssDbPath: nssDb, userHome: root, platform: 'linux' });
    expect((await certificates.status()).browserTrust).toBe('untrusted');
    const trusted = await certificates.trust(context('trust') as never);
    expect(trusted.status, JSON.stringify(trusted)).toBe('completed');
    expect(trusted.items.every(item => item.status === 'completed')).toBe(true);
    expect((await certificates.status()).browserTrust).toBe('trusted');
  });

  it('refuses to claim browser support on unverified platforms', async () => {
    const certificates = new CaddyCertificates({ home, platform: 'win32' });
    expect((await certificates.status()).browserTrust).toBe('unsupported');
    const result = await certificates.trust(context('trust-win') as never);
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.messageKey).toBe('certificate.unsupported');
  });

  it('reports a missing CA instead of inventing success', async () => {
    const certificates = new CaddyCertificates({ home: join(root, 'missing'), nssDbPath: nssDb, userHome: root, platform: 'linux' });
    expect((await certificates.status()).exists).toBe(false);
    const result = await certificates.trust(context('trust-missing') as never);
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.messageKey).toBe('certificate.notGenerated');
  });
});
