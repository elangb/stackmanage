import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext, OperationEvent } from '@stackmanage/core';
import { FsModuleStorage } from '../src/shared/storage';
import { PhpModule } from '../src/modules/php';
import { phpPaths } from '../src/modules/php/paths';
import { renderPhpFpmConfig, renderPhpPoolConfig, assertSafePath } from '../src/modules/php/config';
import { PHP_INSTALLATION_ID, PHP_MODULE_ID, PHP_PORT, PHP_VERSION } from '../src/modules/php/manifest';
import { PHP_STORAGE_KEYS, PhpInstallationsRecordSchema } from '../src/modules/php/state';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackmanage-php-test-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(operationId: string, events: OperationEvent[] = []): OperationContext {
  return {
    operationId,
    signal: new AbortController().signal,
    emit: event => events.push(event)
  };
}

async function harness(): Promise<{ module: PhpModule; home: string; storage: FsModuleStorage }> {
  const home = await mkdtemp(join(root, 'mod-'));
  const storage = new FsModuleStorage(join(home, 'state'));
  return { module: new PhpModule({ storage, home }), home, storage };
}

async function fakeRuntime(home: string): Promise<string> {
  const dir = join(phpPaths(home).installations, PHP_INSTALLATION_ID);
  await mkdir(join(dir, 'bin'), { recursive: true });
  for (const [name, label] of [
    ['php-fpm8.5', 'fpm-fcgi'],
    ['php', 'cli']
  ] as const) {
    const path = join(dir, 'bin', name);
    await writeFile(path, `#!${process.execPath}\nconsole.log('PHP ${PHP_VERSION} (${label}) (built: test)');\n`);
    await chmod(path, 0o755);
  }
  return dir;
}

describe('php configuration', () => {
  it('binds FastCGI to loopback and renders quoted absolute paths', () => {
    const base = join(root, 'cfg');
    const options = {
      configPath: join(base, 'php-fpm.conf'),
      poolPath: join(base, 'pool.d', 'www.conf'),
      pidPath: join(base, 'run', 'php-fpm.pid'),
      logPath: join(base, 'logs', 'php-fpm.log'),
      accessLogPath: join(base, 'logs', 'access.log'),
      errorLogPath: join(base, 'logs', 'php-error.log'),
      sessionsDir: join(base, 'sessions'),
      tmpDir: join(base, 'tmp'),
      port: PHP_PORT
    };
    expect(renderPhpFpmConfig(options)).toContain(`include = "${options.poolPath}"`);
    const pool = renderPhpPoolConfig(options);
    expect(pool).toContain('listen = 127.0.0.1:19000');
    expect(pool).toContain('listen.allowed_clients = 127.0.0.1');
    expect(pool).toContain('security.limit_extensions = .php');
    expect(() => assertSafePath('relative/path')).toThrow();
    expect(() => assertSafePath('/tmp/quote"injection')).toThrow();
  });
});

describe('php runtime lifecycle', () => {
  it('reports the pinned version and an uninstalled, stopped service initially', async () => {
    const h = await harness();
    const versions = h.module.runtime.versionsView(PHP_MODULE_ID);
    expect(versions.pinnedVersion).toBe(PHP_VERSION);
    expect(versions.supported).toBe(true);
    const status = await h.module.service.status(PHP_MODULE_ID);
    expect(status.installed).toBe(false);
    expect(status.service.state).toBe('stopped');
    expect(status.service.bind).toBe('127.0.0.1');
    expect(status.service.port).toBe(PHP_PORT);
  });

  it('refuses to register a missing runtime without writing a record', async () => {
    const h = await harness();
    const result = await h.module.runtime.install(
      { operationId: 'op-missing', moduleId: 'php', version: PHP_VERSION, platform: 'linux', architecture: 'x64' },
      context('op-missing')
    );
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.messageKey).toBe('php.runtimeMissing');
    expect(await h.module.runtime.installed()).toBeUndefined();
  });

  it('registers a validated 8.5.12 runtime, lists it, and uninstalls only the managed copy', async () => {
    const h = await harness();
    const directory = await fakeRuntime(h.home);
    const installed = await h.module.runtime.install(
      { operationId: 'op-install', moduleId: 'php', version: PHP_VERSION, platform: 'linux', architecture: 'x64' },
      context('op-install')
    );
    expect(installed.status).toBe('completed');
    const record = await h.module.runtime.installed();
    expect(record?.directory).toBe(directory);
    expect(record?.versionOutput).toContain(PHP_VERSION);

    const list = await h.module.runtime.list(PHP_MODULE_ID);
    expect(list.installations).toHaveLength(1);

    const removed = await h.module.runtime.uninstall(PHP_INSTALLATION_ID, 'op-remove', context('op-remove'));
    expect(removed.status).toBe('completed');
    expect(await h.module.runtime.installed()).toBeUndefined();
    const stored = await h.storage.StorageGetAsync(PHP_MODULE_ID, PHP_STORAGE_KEYS.installations, PhpInstallationsRecordSchema);
    expect(stored?.installations ?? []).toHaveLength(0);
  });

  it('registers an explicit development runtime override outside the managed installations tree', async () => {
    const h = await harness();
    const override = await mkdtemp(join(root, 'override-'));
    await mkdir(join(override, 'bin'), { recursive: true });
    for (const name of ['php-fpm8.5', 'php']) {
      const path = join(override, 'bin', name);
      await writeFile(path, `#!${process.execPath}\nconsole.log('PHP ${PHP_VERSION} (test)');\n`);
      await chmod(path, 0o755);
    }
    const module = new PhpModule({ storage: h.storage, home: h.home, runtimeOverride: override });
    const installed = await module.runtime.install(
      { operationId: 'op-override', moduleId: 'php', version: PHP_VERSION, platform: 'linux', architecture: 'x64' },
      context('op-override')
    );
    expect(installed.status).toBe('completed');
    expect((await module.runtime.installed())?.directory).toBe(override);
  });
});
