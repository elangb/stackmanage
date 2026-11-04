import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { IdSchema } from '@stackmanage/core';
import { SemverSchema } from '@stackmanage/plugin-sdk';
import { canonicalJson } from './canonical';
import { PluginHostError } from './errors';
import type { TrustedKeyring } from './keys';
import { SafeRelativePathSchema } from './paths';
import { DetachedSignatureSchema, sha256File, verifyDetachedSignature } from './signature';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const RegistrySignatureSchema = z
  .object({
    algorithm: z.literal('ed25519'),
    keyId: IdSchema,
    value: DetachedSignatureSchema
  })
  .strict();
export type RegistrySignature = z.infer<typeof RegistrySignatureSchema>;

export const RegistryEntrySchema = z
  .object({
    id: IdSchema,
    version: SemverSchema,
    /** SHA-256 of the exact plugin.json bytes inside the package. */
    manifestSha256: Sha256Schema,
    package: z.object({ file: SafeRelativePathSchema, sha256: Sha256Schema }).strict(),
    signature: RegistrySignatureSchema.optional()
  })
  .strict();
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistryIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z
      .array(RegistryEntrySchema)
      .max(256)
      .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Plugin IDs must be unique in the registry')
  })
  .strict();
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;

/** Signature payload: every entry field except the detached signature itself. */
export function registryEntryPayload(entry: RegistryEntry): string {
  const unsigned: RegistryEntry = { ...entry };
  delete unsigned.signature;
  return canonicalJson(unsigned);
}

export interface LoadedRegistry {
  readonly index: RegistryIndex;
  readonly directory: string;
  readonly indexPath: string;
}

export interface RegistryLoadOptions {
  readonly keyring: TrustedKeyring;
  /** Local registries are fail-closed by default. */
  readonly requireSigned?: boolean;
}

/** Read, strictly validate and (by default) verify every entry signature before use. */
export async function loadRegistry(indexPath: string, options: RegistryLoadOptions): Promise<LoadedRegistry> {
  let raw: string;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch {
    throw new PluginHostError('REGISTRY_INVALID', 'read');
  }
  if (Buffer.byteLength(raw, 'utf8') > 1_048_576) throw new PluginHostError('REGISTRY_INVALID', 'size');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new PluginHostError('REGISTRY_INVALID', 'json');
  }
  const parsed = RegistryIndexSchema.safeParse(parsedJson);
  if (!parsed.success) throw new PluginHostError('REGISTRY_INVALID', 'schema');

  const requireSigned = options.requireSigned !== false;
  for (const entry of parsed.data.entries) {
    if (entry.signature === undefined) {
      if (requireSigned) throw new PluginHostError('REGISTRY_SIGNATURE_INVALID', 'unsigned');
      continue;
    }
    verifyDetachedSignature({
      data: registryEntryPayload(entry),
      signature: entry.signature.value,
      keyId: entry.signature.keyId,
      keyring: options.keyring
    });
  }

  return { index: parsed.data, directory: dirname(indexPath), indexPath };
}

export function findRegistryEntry(registry: LoadedRegistry, id: string, version: string): RegistryEntry {
  const entry = registry.index.entries.find(item => item.id === id && item.version === version);
  if (entry === undefined) throw new PluginHostError('PLUGIN_NOT_FOUND', `${id}@${version}`);
  return entry;
}

/** Verify the package digest before extraction; the package path is confined to the registry directory. */
export async function verifyPackageDigest(packagePath: string, expectedSha256: string): Promise<void> {
  const actual = await sha256File(packagePath);
  if (actual !== expectedSha256) throw new PluginHostError('PACKAGE_DIGEST_MISMATCH');
}
