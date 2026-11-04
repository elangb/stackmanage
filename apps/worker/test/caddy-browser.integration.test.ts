/**
 * Real-browser certificate acceptance on Linux.
 *
 * Runs only with STACKMANAGE_BROWSER_E2E=1 and an installed Google Chrome.
 * Uses isolated HOME/NSS/profile directories and an internal Caddy CA;
 * no `--ignore-certificate-errors`, no system trust-store modification.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CaddyModule } from '../src/modules/caddy';
import { FsModuleStorage } from '../src/modules/caddy/paths';

const CHROME = '/usr/bin/google-chrome';
const enabled =
  process.env['STACKMANAGE_BROWSER_E2E'] === '1' &&
  process.platform === 'linux' &&
  process.arch === 'x64';

let root = '';
let module: CaddyModule | undefined;

async function chromeAvailable(): Promise<boolean> {
  try {
    await access(CHROME, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (!enabled) return;
  root = await mkdtemp(join(tmpdir(), 'stackmanage-browser-'));
});

afterAll(async () => {
  await module?.shutdown().catch(() => undefined);
  if (root !== '') await rm(root, { recursive: true, force: true });
});

function context(id: string) {
  return { operationId: id, signal: new AbortController().signal, emit: () => undefined };
}

function runChrome(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 40000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(CHROME, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      if (stdout.length < 2_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 200_000) stderr += chunk.toString('utf8');
    });
    child.on('error', error => {
      stderr += `\nspawn error: ${error.message}`;
      finish(null);
    });
    child.on('close', code => finish(code));
  });
}

it.skipIf(!enabled)(
  'Chrome accepts https://shop.test with the Caddy internal CA and no bypass flag',
  async () => {
    if (!(await chromeAvailable())) throw new Error('Google Chrome is not installed at /usr/bin/google-chrome');
    const home = join(root, 'caddy');
    const userHome = join(root, 'user');
    const nssDb = join(userHome, '.pki', 'nssdb');
    const hostsPath = join(root, 'hosts');
    await mkdir(userHome, { recursive: true });
    await writeFile(hostsPath, '127.0.0.1 unrelated.test\n');

    module = new CaddyModule({ storage: new FsModuleStorage(join(root, 'state')), home, platform: 'linux', architecture: 'x64', hostsPath, nssDbPath: nssDb, userHome });
    const installed = await module.installer.install({ operationId: 'browser-install', moduleId: 'caddy', version: '2.11.8', platform: 'linux', architecture: 'x64' } as never, context('browser-install') as never);
    expect(installed, JSON.stringify(installed)).toMatchObject({ status: 'completed' });

    const siteRoot = join(home, 'sites', 'shop');
    await mkdir(siteRoot, { recursive: true });
    await writeFile(join(siteRoot, 'index.html'), '<!doctype html><html><body><h1>browser-tls-ok</h1></body></html>');
    const port = 19446;
    const ref = { moduleId: 'caddy', installationId: 'caddy-2.11.8', instanceId: 'default' };
    const applied = await module.sites.apply({ operationId: 'browser-sites', sites: [{ id: 'shop', hostname: 'shop.test', aliases: [], server: ref, root: siteRoot, port, tls: true }] } as never, context('browser-sites') as never);
    expect(applied, JSON.stringify(applied)).toMatchObject({ status: 'completed' });
    const started = await module.service.start({ ref, operationId: 'browser-start', timeoutMs: 20000 } as never, context('browser-start') as never);
    expect(started, JSON.stringify(started)).toMatchObject({ status: 'completed' });

    const trusted = await module.certificates.trust(context('browser-trust') as never);
    expect(trusted.status, JSON.stringify(trusted)).toBe('completed');
    expect((await module.certificates.status()).browserTrust).toBe('trusted');
    const caPem = await readFile(module.certificates.authorityPath, 'utf8');
    expect(caPem).toContain('BEGIN CERTIFICATE');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
      XDG_CONFIG_HOME: join(userHome, '.config'),
      XDG_CACHE_HOME: join(userHome, '.cache'),
      XDG_DATA_HOME: join(userHome, '.local', 'share'),
      NSS_DEFAULT_DB_TYPE: 'sql',
      NO_PROXY: 'shop.test,localhost,127.0.0.1',
      no_proxy: 'shop.test,localhost,127.0.0.1'
    };
    const browser = await runChrome(
      [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${join(userHome, 'chrome-profile')}`,
        '--host-resolver-rules=MAP shop.test 127.0.0.1',
        '--virtual-time-budget=6000',
        '--dump-dom',
        `https://shop.test:${port}/`
      ],
      env
    );
    const evidence = `${browser.stdout}\n${browser.stderr}`;
    expect(browser.code, evidence.slice(0, 2000)).toBe(0);
    expect(browser.stdout).toContain('browser-tls-ok');
    expect(evidence).not.toMatch(/not private|ERR_CERT|NET::ERR_CERT|certificate.*invalid/i);
  },
  300000
);

it.skipIf(enabled)('browser certificate acceptance requires STACKMANAGE_BROWSER_E2E=1 and Google Chrome', () => {
  expect(true).toBe(true);
});
