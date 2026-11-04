import { createHash, createPrivateKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PluginHostError } from './errors';
import type { TrustedKeyring } from './keys';

export const DetachedSignatureSchema = z
  .string()
  .min(64)
  .max(512)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected base64 Ed25519 signature');

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

function decodeSignature(value: string): Buffer {
  if (!DetachedSignatureSchema.safeParse(value).success) throw new PluginHostError('SIGNATURE_INVALID', 'encoding');
  const signature = Buffer.from(value, 'base64');
  if (signature.byteLength !== 64) throw new PluginHostError('SIGNATURE_INVALID', 'length');
  return signature;
}

function ed25519PublicKey(key: KeyObject): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') throw new PluginHostError('SIGNATURE_INVALID', 'key-type');
  return key;
}

/** Verify an Ed25519 detached signature over exact bytes. Throws a fixed-code error. */
export function verifyDetachedSignature(input: {
  data: string | Buffer;
  signature: string;
  keyId: string;
  keyring: TrustedKeyring;
}): void {
  const key = ed25519PublicKey(input.keyring.get(input.keyId));
  const signature = decodeSignature(input.signature);
  const ok = verify(null, Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8'), key, signature);
  if (!ok) throw new PluginHostError('SIGNATURE_INVALID', 'verify');
}

/** Tooling/test helper only; the host never receives private keys. */
export function createDetachedSignature(data: string | Buffer, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new PluginHostError('SIGNATURE_INVALID', 'private-key-type');
  return sign(null, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), key).toString('base64');
}
