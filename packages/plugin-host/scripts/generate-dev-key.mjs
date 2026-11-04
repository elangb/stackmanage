#!/usr/bin/env node
/**
 * Generate a throwaway Ed25519 development key pair plus a public-key pinning file.
 *
 * This never ships a key: callers must name an output directory, and existing files are
 * refused unless --force is explicit. Do not use these keys for a production registry.
 *
 * Usage:
 *   node packages/plugin-host/scripts/generate-dev-key.mjs --out .plugin-keys --key-id dev
 */
import { generateKeyPairSync } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const result = { out: undefined, keyId: 'dev', force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--out') result.out = argv[(index += 1)];
    else if (value === '--key-id') result.keyId = argv[(index += 1)];
    else if (value === '--force') result.force = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (typeof result.out !== 'string' || result.out.trim() === '') {
    throw new Error('usage: generate-dev-key.mjs --out <directory> [--key-id <id>] [--force]');
  }
  if (typeof result.keyId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(result.keyId)) {
    throw new Error('--key-id must match plugin id syntax');
  }
  return result;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const options = parseArgs(process.argv.slice(2));
const directory = resolve(options.out);
const privatePath = join(directory, 'dev-private.pem');
const publicPath = join(directory, 'dev-public.pem');
const trustedPath = join(directory, 'trusted-keys.json');

await mkdir(directory, { recursive: true });
if (!options.force) {
  for (const path of [privatePath, publicPath, trustedPath]) {
    if (await exists(path)) throw new Error(`refusing to overwrite ${path}; pass --force`);
  }
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

await writeFile(privatePath, privatePem, { encoding: 'utf8', mode: 0o600 });
await writeFile(publicPath, publicPem, { encoding: 'utf8', mode: 0o644 });
await writeFile(
  trustedPath,
  `${JSON.stringify({ schemaVersion: 1, keys: [{ keyId: options.keyId, publicKeyPem: publicPem }] }, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o644 }
);

process.stdout.write(`generated ${privatePath}\n`);
process.stdout.write(`generated ${publicPath}\n`);
process.stdout.write(`generated ${trustedPath}\n`);
