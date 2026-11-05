/**
 * Real PHP-FPM integration test. It is skipped unless the developer supplies a
 * validated runtime (for example the per-user runtime from the setup notes):
 *
 *   STACKMANAGE_PHP_RUNTIME="$HOME/.local/share/StackManage/runtimes/php/8.5.12" \
 *     pnpm exec vitest run apps/worker/test/php.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '@stackmanage/core';
import { FsModuleStorage } from '../src/shared/storage';
import { PhpModule } from '../src/modules/php';
import { PHP_INSTALLATION_ID, PHP_MODULE_ID, PHP_PORT, PHP_VERSION } from '../src/modules/php/manifest';

const runtime = process.env['STACKMANAGE_PHP_RUNTIME'];
const suite = runtime === undefined || runtime.trim() === '' ? describe.skip : describe;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'stackmanage-php-integration-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(operationId: string): OperationContext {
  return { operationId, signal: new AbortController().signal, emit: () => undefined };
}

suite('real PHP-FPM runtime', () => {
  it('registers the runtime, starts FPM on loopback, reports running and stops cleanly', async () => {
    const home = await mkdtemp(join(root, 'mod-'));
    const storage = new FsModuleStorage(join(home, 'state'));
    const module = new PhpModule({ storage, home, runtimeOverride: runtime });

    const installed = await module.runtime.install(
      { operationId: 'it-install', moduleId: PHP_MODULE_ID, version: PHP_VERSION, platform: 'linux', architecture: 'x64' },
      context('it-install')
    );
    expect(installed.status).toBe('completed');
    const record = await module.runtime.installed();
    expect(record?.id).toBe(PHP_INSTALLATION_ID);
    expect(record?.versionOutput).toContain(PHP_VERSION);

    const started = await module.service.start({ operationId: 'it-start' }, context('it-start'));
    expect(started.status).toBe('completed');

    const running = await module.service.status(PHP_MODULE_ID);
    expect(running.service.state).toBe('running');
    expect(running.service.port).toBe(PHP_PORT);
    expect(running.service.bind).toBe('127.0.0.1');

    const logs = await module.service.logs({ maxBytes: 4096 });
    expect(logs.path).toContain('php-fpm.log');

    const stopped = await module.service.stop({ operationId: 'it-stop' }, context('it-stop'));
    expect(stopped.status).toBe('completed');
    expect((await module.service.status(PHP_MODULE_ID)).service.state).toBe('stopped');

    await module.shutdown();
  }, 30_000);
});
