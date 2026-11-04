import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  isSafePluginEntry,
  PluginManifestSchema,
  PluginManifestValidationError,
  PluginRpcRequestSchema,
  validatePluginManifest
} from '../src';

const base = {
  apiVersion: 1,
  id: 'demo-plugin',
  version: '1.2.3',
  entry: 'index.mjs',
  permissions: ['host.ping'],
  compatibility: { host: { min: '1.0.0', max: '2.0.0' } },
  signature: { algorithm: 'ed25519', keyId: 'test-key', file: 'plugin.sig' }
} as const;

const options = { hostVersion: '1.5.0', requireSignature: true } as const;

function reason(input: unknown, overrides: Partial<typeof options> = {}): string | undefined {
  try {
    validatePluginManifest(input, { ...options, ...overrides });
  } catch (error) {
    return error instanceof PluginManifestValidationError ? error.code : 'UNKNOWN';
  }
  return undefined;
}

describe('plugin manifest', () => {
  it('accepts a strict signed manifest and a nested entry inside the package', () => {
    expect(PluginManifestSchema.parse(base).entry).toBe('index.mjs');
    expect(PluginManifestSchema.parse({ ...base, entry: 'dist/index.mjs' }).entry).toBe('dist/index.mjs');
    expect(validatePluginManifest(base, options).id).toBe('demo-plugin');
    expect(reason(base)).toBeUndefined();
  });

  it('rejects traversal, absolute, drive-letter, backslash and non-mjs entries', () => {
    for (const entry of ['../escape.mjs', '/tmp/escape.mjs', 'C:/escape.mjs', 'C:\\escape.mjs', 'a/../../x.mjs', './index.mjs', 'dir//index.mjs', 'index.js', 'plugin.json', '']) {
      expect(isSafePluginEntry(entry)).toBe(false);
      expect(reason({ ...base, entry })).toBe('INVALID_MANIFEST');
    }
    expect(isSafePluginEntry('dist/index.mjs')).toBe(true);
  });

  it('rejects an unsupported API, invalid semver and incompatible host window', () => {
    expect(reason({ ...base, apiVersion: 2 })).toBe('UNSUPPORTED_API');
    expect(reason({ ...base, version: '1.2' })).toBe('INVALID_MANIFEST');
    expect(reason({ ...base, compatibility: { host: { min: '2.0.0', max: '1.0.0' } } })).toBe('INVALID_MANIFEST');
    expect(reason(base, { hostVersion: '2.0.1' })).toBe('INCOMPATIBLE_HOST');
    expect(reason(base, { hostVersion: '0.9.9' })).toBe('INCOMPATIBLE_HOST');
    expect(reason(base, { hostVersion: 'not-semver' })).toBe('INVALID_HOST_VERSION');
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
  });

  it('requires a signature when the host policy demands one', () => {
    const { signature, ...unsigned } = base;
    expect(signature).toBeDefined();
    expect(reason(unsigned)).toBe('SIGNATURE_REQUIRED');
    expect(validatePluginManifest(unsigned, { ...options, requireSignature: false }).id).toBe('demo-plugin');
  });

  it('rejects wildcard, duplicate and unsupported capabilities', () => {
    expect(reason({ ...base, permissions: ['*'] })).toBe('INVALID_MANIFEST');
    expect(reason({ ...base, permissions: ['host.ping', 'host.ping'] })).toBe('INVALID_MANIFEST');
    expect(reason({ ...base, permissions: ['fs.read'] })).toBe('UNSUPPORTED_PERMISSION');
    expect(reason({ ...base, permissions: ['process.spawn'] })).toBe('UNSUPPORTED_PERMISSION');
  });

  it('rejects unknown manifest fields and malformed signature metadata', () => {
    expect(reason({ ...base, extra: true })).toBe('INVALID_MANIFEST');
    expect(reason({ ...base, signature: { ...base.signature, algorithm: 'rsa' } })).toBe('INVALID_MANIFEST');
    expect(reason({ ...base, signature: { ...base.signature, file: 'other.sig' } })).toBe('INVALID_MANIFEST');
    expect(reason({ ...base, compatibility: { host: { min: '1.0.0', max: '2.0.0' }, extra: true } })).toBe('INVALID_MANIFEST');
  });
});

describe('plugin JSON-RPC surface', () => {
  it('accepts only the explicit probe and shutdown methods', () => {
    expect(PluginRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: '1', method: 'plugin.ping' }).success).toBe(true);
    expect(PluginRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'plugin.status' }).success).toBe(true);
    expect(PluginRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: '1', method: 'plugin.shutdown' }).success).toBe(true);
    for (const method of ['plugin.exec', 'plugin.fs.read', 'plugin.network', 'exec', '*']) {
      expect(PluginRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: '1', method }).success).toBe(false);
    }
  });
});
