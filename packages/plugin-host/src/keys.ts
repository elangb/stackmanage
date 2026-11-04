import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { IdSchema } from '@stackmanage/core';
import { PluginHostError } from './errors';

export const TrustedKeySchema = z
  .object({
    keyId: IdSchema,
    /** SPKI public key in PEM form. Private key material is never accepted. */
    publicKeyPem: z
      .string()
      .min(64)
      .max(4096)
      .regex(/^-----BEGIN PUBLIC KEY-----/, 'Expected an SPKI public key PEM')
      .refine(value => !value.includes('PRIVATE KEY'), 'Private key material is not a trusted public key')
  })
  .strict();
export type TrustedKey = z.infer<typeof TrustedKeySchema>;

export const TrustedKeysFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    keys: z
      .array(TrustedKeySchema)
      .max(64)
      .refine(values => new Set(values.map(value => value.keyId)).size === values.length, 'Trusted key IDs must be unique')
  })
  .strict();
export type TrustedKeysFile = z.infer<typeof TrustedKeysFileSchema>;

function importEd25519(key: TrustedKey): KeyObject {
  let keyObject: KeyObject;
  try {
    keyObject = createPublicKey(key.publicKeyPem);
  } catch {
    throw new PluginHostError('REGISTRY_INVALID', 'trusted-key');
  }
  if (keyObject.asymmetricKeyType !== 'ed25519') throw new PluginHostError('REGISTRY_INVALID', 'trusted-key-type');
  return keyObject;
}

/** Public-key pinning configuration. Only keys listed here can verify packages or registry entries. */
export class TrustedKeyring {
  private readonly keys = new Map<string, KeyObject>();

  private constructor(entries: readonly TrustedKey[]) {
    for (const entry of entries) this.keys.set(entry.keyId, importEd25519(entry));
  }

  static fromConfig(input: unknown): TrustedKeyring {
    const parsed = TrustedKeysFileSchema.safeParse(input);
    if (!parsed.success) throw new PluginHostError('REGISTRY_INVALID', 'trusted-keys');
    return new TrustedKeyring(parsed.data.keys);
  }

  static async fromFile(path: string): Promise<TrustedKeyring> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new PluginHostError('REGISTRY_INVALID', 'trusted-keys-read');
    }
    return TrustedKeyring.fromConfig(raw);
  }

  has(keyId: string): boolean {
    return this.keys.has(keyId);
  }

  keyIds(): string[] {
    return [...this.keys.keys()];
  }

  get(keyId: string): KeyObject {
    const key = this.keys.get(keyId);
    if (key === undefined) throw new PluginHostError('TRUSTED_KEY_UNKNOWN', keyId);
    return key;
  }
}
