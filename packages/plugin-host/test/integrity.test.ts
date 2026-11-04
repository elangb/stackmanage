import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDetachedSignature,
  extractPluginPackage,
  PluginHost,
  registryEntryPayload,
  type RegistryEntry
} from '../src';
import { context, createPluginPackage, createTestKeys, temporaryPluginRoot, writeRegistry } from './helpers';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(run => run()));
});

async function setup() {
  const dirs = await temporaryPluginRoot();
  const keys = createTestKeys();
  const registryIndex = join(dirs.registryDir, 'index.json');
  const host = new PluginHost({
    root: dirs.root,
    registryIndex,
    trustedKeys: keys.keyring,
    hostVersion: '1.0.0',
    runtime: { handshakeTimeoutMs: 2_000, requestTimeoutMs: 1_000, heartbeatIntervalMs: 10_000 }
  });
  cleanups.push(async () => {
    await host.shutdown();
    const { rm } = await import('node:fs/promises');
    await rm(dirs.base, { recursive: true, force: true });
  });
  return { dirs, keys, registryIndex, host };
}

function signEntry(keys: ReturnType<typeof createTestKeys>, unsigned: RegistryEntry): RegistryEntry {
  return {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      keyId: keys.keyId,
      value: createDetachedSignature(registryEntryPayload(unsigned), keys.privateKeyPem)
    }
  };
}

async function createSignedPackage(
  registryIndex: string,
  keys: ReturnType<typeof createTestKeys>,
  options: {
    id?: string;
    version?: string;
    manifest?: Record<string, unknown>;
    signManifest?: boolean;
    signatureValue?: string | ((bytes: Buffer) => string);
  } = {}
) {
  return createPluginPackage({
    directory: dirname(registryIndex),
    id: options.id ?? 'demo',
    version: options.version ?? '1.0.0',
    signing: { privateKeyPem: keys.privateKeyPem, keyId: keys.keyId },
    ...(options.manifest !== undefined ? { manifest: options.manifest } : {}),
    ...(options.signManifest !== undefined ? { signManifest: options.signManifest } : {}),
    ...(options.signatureValue !== undefined ? { signatureValue: options.signatureValue } : {})
  });
}

describe('plugin package integrity', () => {
  it('rejects a package whose bytes changed after the registry pin', async () => {
    const { keys, registryIndex, host } = await setup();
    const created = await createSignedPackage(registryIndex, keys);
    await writeRegistry(registryIndex, [created.entry]);
    await appendFile(created.packagePath, 'tampered');

    const result = await host.install('demo', '1.0.0', context('install-tampered'));
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.messageKey).toBe('plugin.packageDigestMismatch');
    expect(await host.list()).toEqual([]);
  });

  it('rejects a manifest that does not match its signed digest', async () => {
    const { keys, registryIndex, host } = await setup();
    const created = await createSignedPackage(registryIndex, keys);
    const mismatched = { ...created.entry, manifestSha256: 'a'.repeat(64) };
    await writeRegistry(registryIndex, [signEntry(keys, mismatched)]);

    const result = await host.install('demo', '1.0.0', context('install-manifest-tamper'));
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.messageKey).toBe('plugin.manifestDigestMismatch');
  });

  it('rejects an invalid detached signature and an unsigned manifest when signatures are required', async () => {
    const { keys, registryIndex, host } = await setup();
    const other = createTestKeys('other-key');
    const badSignature = await createSignedPackage(registryIndex, keys, {
      id: 'bad-signature',
      signatureValue: bytes => createDetachedSignature(bytes, other.privateKeyPem)
    });
    const unsigned = await createSignedPackage(registryIndex, keys, { id: 'unsigned', signManifest: false });
    await writeRegistry(registryIndex, [badSignature.entry, unsigned.entry]);

    const invalid = await host.install('bad-signature', '1.0.0', context('install-bad-signature'));
    expect(invalid.status).toBe('failed');
    expect(invalid.items[0]?.error?.messageKey).toBe('plugin.signatureInvalid');

    const missing = await host.install('unsigned', '1.0.0', context('install-unsigned'));
    expect(missing.status).toBe('failed');
    expect(missing.items[0]?.error?.messageKey).toBe('plugin.signatureRequired');
  });

  it('rejects an unknown signing key and a tampered registry entry', async () => {
    const { keys, registryIndex, host } = await setup();
    const other = createTestKeys('unknown-key');
    const foreign = await createPluginPackage({
      directory: dirname(registryIndex),
      id: 'foreign',
      version: '1.0.0',
      signing: { privateKeyPem: other.privateKeyPem, keyId: other.keyId }
    });
    await writeRegistry(registryIndex, [foreign.entry]);
    const unknown = await host.install('foreign', '1.0.0', context('install-foreign'));
    expect(unknown.status).toBe('failed');
    expect(unknown.items[0]?.error?.messageKey).toBe('plugin.trustedKeyUnknown');

    const created = await createSignedPackage(registryIndex, keys, { id: 'tampered' });
    await writeRegistry(registryIndex, [created.entry]);
    const raw = JSON.parse(await readFile(registryIndex, 'utf8')) as { entries: RegistryEntry[] };
    raw.entries[0]!.package.sha256 = 'b'.repeat(64);
    await writeFile(registryIndex, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    const tampered = await host.install('tampered', '1.0.0', context('install-registry-tamper'));
    expect(tampered.status).toBe('failed');
    expect(tampered.items[0]?.error?.messageKey).toBe('plugin.signatureInvalid');
  });

  it('rejects duplicate registry ids, unsafe package paths and unsigned registries', async () => {
    const { dirs, keys, registryIndex, host } = await setup();
    const first = await createSignedPackage(registryIndex, keys, { id: 'duplicate', version: '1.0.0' });
    const second = await createSignedPackage(registryIndex, keys, { id: 'duplicate', version: '2.0.0' });
    await writeRegistry(registryIndex, [first.entry, second.entry]);
    const duplicate = await host.install('duplicate', '1.0.0', context('install-duplicate-registry'));
    expect(duplicate.status).toBe('failed');
    expect(duplicate.items[0]?.error?.messageKey).toBe('plugin.registryInvalid');

    const safe = await createSignedPackage(registryIndex, keys, { id: 'unsafe-path' });
    const unsafeEntry = signEntry(keys, {
      ...safe.entry,
      package: { ...safe.entry.package, file: '../escape.tgz' }
    });
    await writeRegistry(registryIndex, [unsafeEntry]);
    const unsafe = await host.install('unsafe-path', '1.0.0', context('install-unsafe-path'));
    expect(unsafe.status).toBe('failed');
    expect(unsafe.items[0]?.error?.messageKey).toBe('plugin.registryInvalid');

    const unsigned = await createPluginPackage({
      directory: dirname(registryIndex),
      id: 'unsigned-registry',
      version: '1.0.0',
      signing: { privateKeyPem: keys.privateKeyPem, keyId: keys.keyId },
      signManifest: false,
      signRegistry: false
    });
    await writeRegistry(registryIndex, [unsigned.entry]);
    const unsignedResult = await host.install('unsigned-registry', '1.0.0', context('install-unsigned-registry'));
    expect(unsignedResult.status).toBe('failed');
    expect(unsignedResult.items[0]?.error?.messageKey).toBe('plugin.registrySignatureInvalid');
    expect(dirs.root.length).toBeGreaterThan(0);
  });

  it('rejects unsupported API, incompatible host windows and unsupported capabilities', async () => {
    const { keys, registryIndex, host } = await setup();
    const api = await createSignedPackage(registryIndex, keys, { id: 'api', manifest: { apiVersion: 2 } });
    const incompatible = await createSignedPackage(registryIndex, keys, {
      id: 'incompatible',
      manifest: { compatibility: { host: { min: '2.0.0', max: '3.0.0' } } }
    });
    const permission = await createSignedPackage(registryIndex, keys, {
      id: 'permission',
      manifest: { permissions: ['process.spawn'] }
    });
    await writeRegistry(registryIndex, [api.entry, incompatible.entry, permission.entry]);

    const apiResult = await host.install('api', '1.0.0', context('install-api'));
    expect(apiResult.items[0]?.error?.messageKey).toBe('plugin.unsupportedApi');
    const hostResult = await host.install('incompatible', '1.0.0', context('install-incompatible'));
    expect(hostResult.items[0]?.error?.messageKey).toBe('plugin.incompatibleHost');
    const permissionResult = await host.install('permission', '1.0.0', context('install-permission'));
    expect(permissionResult.items[0]?.error?.messageKey).toBe('plugin.unsupportedPermission');
  });

  it('rejects an archive entry that escapes the staging directory and writes nothing outside it', async () => {
    const { dirs } = await setup();
    const source = join(dirs.base, 'malicious-source');
    const staging = join(dirs.base, 'malicious-staging');
    const archive = join(dirs.base, 'malicious.tgz');
    const { mkdir, rm } = await import('node:fs/promises');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'plugin.json'), '{"apiVersion":1}\n');
    await writeFile(join(source, 'index.mjs'), 'export const x = 1\n');
    await tar.c(
      {
        gzip: true,
        cwd: source,
        file: archive,
        portable: true,
        onWriteEntry: (entry: { path: string }) => {
          if (entry.path.replace(/^\.\//, '') === 'index.mjs') entry.path = '../escape.mjs';
        }
      },
      ['.']
    );
    await expect(extractPluginPackage({ archivePath: archive, stagingDir: staging })).rejects.toMatchObject({
      code: 'UNSAFE_PACKAGE_PATH'
    });
    await expect(lstat(join(dirs.base, 'escape.mjs'))).rejects.toThrow();
    await rm(source, { recursive: true, force: true });
  });
});
