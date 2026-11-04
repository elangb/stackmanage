import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import type { OperationContext } from '@stackmanage/core';
import {
  createDetachedSignature,
  registryEntryPayload,
  sha256Hex,
  TrustedKeyring,
  type RegistryEntry
} from '../src';

export interface TestKeys {
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly keyring: TrustedKeyring;
}

export function createTestKeys(keyId = 'test-key'): TestKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId,
    privateKeyPem,
    publicKeyPem,
    keyring: TrustedKeyring.fromConfig({ schemaVersion: 1, keys: [{ keyId, publicKeyPem }] })
  };
}

export function context(operationId = 'plugin-op'): OperationContext {
  return {
    operationId,
    signal: new AbortController().signal,
    emit() {
      // The local host does not stream progress in Phase 1; one terminal result is returned.
    }
  };
}

export interface CreatePackageOptions {
  readonly directory: string;
  readonly id: string;
  readonly version: string;
  readonly entrySource?: string;
  readonly manifest?: Record<string, unknown>;
  readonly signing?: { privateKeyPem: string; keyId: string };
  readonly signManifest?: boolean;
  readonly signRegistry?: boolean;
  readonly signatureValue?: string | ((manifestBytes: Buffer) => string);
  readonly archiveEntryOverride?: { from: string; to: string };
  readonly packageFile?: string;
}

export interface CreatedPackage {
  readonly entry: RegistryEntry;
  readonly manifest: Record<string, unknown>;
  readonly manifestBytes: Buffer;
  readonly manifestSha256: string;
  readonly packagePath: string;
  readonly packageSha256: string;
}

export const DEFAULT_ENTRY_SOURCE = `export async function ping() { return { pong: true } }
export async function status() { return { healthy: true } }
export async function activate(context) { globalThis.__stackmanageContextKeys = Object.keys(context) }
`;

export async function createPluginPackage(options: CreatePackageOptions): Promise<CreatedPackage> {
  const signManifest = options.signing !== undefined && options.signManifest !== false;
  const signRegistry = options.signing !== undefined && options.signRegistry !== false;
  const work = join(options.directory, '.work', `${options.id}-${options.version}-${randomUUID()}`);
  const staging = join(work, 'staging');
  await mkdir(staging, { recursive: true });
  const manifest: Record<string, unknown> = {
    apiVersion: 1,
    id: options.id,
    version: options.version,
    entry: 'index.mjs',
    permissions: ['host.ping', 'host.status'],
    compatibility: { host: { min: '0.1.0', max: '9.9.9' } },
    ...(signManifest && options.signing !== undefined
      ? { signature: { algorithm: 'ed25519', keyId: options.signing.keyId, file: 'plugin.sig' } }
      : {}),
    ...options.manifest
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(staging, 'plugin.json'), manifestBytes);
  const entryRelative = String(manifest['entry']);
  const entryPath = join(staging, ...entryRelative.split('/'));
  await mkdir(dirname(entryPath), { recursive: true });
  await writeFile(entryPath, options.entrySource ?? DEFAULT_ENTRY_SOURCE, 'utf8');

  if (signManifest) {
    const signature =
      typeof options.signatureValue === 'function'
        ? options.signatureValue(manifestBytes)
        : (options.signatureValue ?? createDetachedSignature(manifestBytes, options.signing?.privateKeyPem ?? ''));
    await writeFile(join(staging, 'plugin.sig'), `${signature}\n`, 'utf8');
  }

  const packageRelative = options.packageFile ?? `packages/${options.id}-${options.version}-${randomUUID()}.tgz`;
  const packagePath = join(options.directory, ...packageRelative.split('/'));
  await mkdir(dirname(packagePath), { recursive: true });
  await tar.c(
    {
      gzip: true,
      cwd: staging,
      file: packagePath,
      portable: true,
      ...(options.archiveEntryOverride !== undefined
        ? {
            onWriteEntry: (entry: { path: string }) => {
              if (entry.path.replace(/^\.\//, '') === options.archiveEntryOverride?.from) {
                entry.path = options.archiveEntryOverride.to;
              }
            }
          }
        : {})
    },
    ['.']
  );
  await rm(work, { recursive: true, force: true });

  const packageBytes = await readFile(packagePath);
  const unsigned: RegistryEntry = {
    id: options.id,
    version: options.version,
    manifestSha256: sha256Hex(manifestBytes),
    package: { file: packageRelative, sha256: sha256Hex(packageBytes) }
  };
  const entry: RegistryEntry =
    signRegistry && options.signing !== undefined
      ? {
          ...unsigned,
          signature: {
            algorithm: 'ed25519',
            keyId: options.signing.keyId,
            value: createDetachedSignature(registryEntryPayload(unsigned), options.signing.privateKeyPem)
          }
        }
      : unsigned;

  return {
    entry,
    manifest,
    manifestBytes,
    manifestSha256: unsigned.manifestSha256,
    packagePath,
    packageSha256: unsigned.package.sha256
  };
}

export async function writeRegistry(indexPath: string, entries: RegistryEntry[]): Promise<void> {
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, 'utf8');
}

export async function temporaryPluginRoot(prefix = 'stackmanage-plugin-test-'): Promise<{ base: string; root: string; registryDir: string }> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  const root = join(base, 'plugins');
  const registryDir = join(root, 'registry');
  return { base, root, registryDir };
}
