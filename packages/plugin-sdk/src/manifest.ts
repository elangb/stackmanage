import { z } from 'zod';
import { API_VERSION, IdSchema, ModuleDefinitionSchema } from '@stackmanage/core';

/**
 * Plugin SDK manifest for the local PluginHost runtime.
 *
 * This is deliberately additive to `PluginManifestSchema` in `@stackmanage/core`: the
 * frozen v1 contract keeps its own narrow shape, while this schema documents the
 * package-boundary fields the host actually verifies (entry path, compatibility and
 * detached-signature metadata). API version 1 is the only supported version.
 */
export const PLUGIN_API_VERSION = API_VERSION;

export const SemverSchema = z
  .string()
  .min(5)
  .max(80)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'Invalid semantic version'
  );
export type Semver = z.infer<typeof SemverSchema>;

export interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** Parse only the numeric core; prerelease/build tags do not affect host compatibility. */
export function parseSemver(value: string): SemverParts | undefined {
  const parsed = SemverSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Numeric comparison of two valid semver values (prerelease/build ignored). */
export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) throw new Error('INVALID_SEMVER');
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

const ENTRY_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A plugin entry is a relative, slash-separated `.mjs` file inside the package.
 * Absolute paths, drive letters, backslashes, empty/dot segments, traversal and
 * non-`.mjs` files are rejected before any filesystem operation.
 */
export function isSafePluginEntry(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  if (value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (!value.endsWith('.mjs')) return false;
  if (value === 'plugin.json' || value === 'plugin.sig') return false;
  const segments = value.split('/');
  if (segments.length === 0) return false;
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..' && ENTRY_SEGMENT.test(segment));
}

export const PluginEntrySchema = z
  .string()
  .min(5)
  .max(256)
  .refine(isSafePluginEntry, 'Entry must be a relative .mjs file inside the package');

/**
 * Explicit requested capabilities. The host grants nothing by default; Phase 1 only
 * implements the read-only probe surface. Filesystem, network and process capabilities
 * are declared so a future host can refuse them explicitly instead of guessing.
 */
export const PluginPermissionSchema = z.enum([
  'host.ping',
  'host.status',
  'fs.read',
  'fs.write',
  'network.connect',
  'process.spawn'
]);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const SUPPORTED_PLUGIN_PERMISSIONS: readonly PluginPermission[] = Object.freeze(['host.ping', 'host.status']);

export const PluginPermissionsSchema = z
  .array(PluginPermissionSchema)
  .max(16)
  .refine(values => new Set(values).size === values.length, 'Permissions must be unique');

export const PluginCompatibilitySchema = z
  .object({
    /** Inclusive host-version window. The host version is supplied by the caller, never by the manifest. */
    host: z
      .object({ min: SemverSchema, max: SemverSchema })
      .strict()
      .refine(value => compareSemver(value.min, value.max) <= 0, 'Compatibility minimum must not exceed maximum')
  })
  .strict();
export type PluginCompatibility = z.infer<typeof PluginCompatibilitySchema>;

export const PluginSignatureMetadataSchema = z
  .object({
    algorithm: z.literal('ed25519'),
    keyId: IdSchema,
    /** Fixed detached-signature filename; the signature covers the exact plugin.json bytes. */
    file: z.literal('plugin.sig')
  })
  .strict();
export type PluginSignatureMetadata = z.infer<typeof PluginSignatureMetadataSchema>;

export const PluginManifestSchema = z
  .object({
    apiVersion: z.literal(PLUGIN_API_VERSION),
    id: IdSchema,
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(2000).optional(),
    version: SemverSchema,
    entry: PluginEntrySchema,
    permissions: PluginPermissionsSchema,
    compatibility: PluginCompatibilitySchema,
    signature: PluginSignatureMetadataSchema.optional(),
    modules: z.array(ModuleDefinitionSchema).max(100).optional()
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export type PluginManifestValidationCode =
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_API'
  | 'INCOMPATIBLE_HOST'
  | 'SIGNATURE_REQUIRED'
  | 'UNSUPPORTED_PERMISSION'
  | 'INVALID_HOST_VERSION';

/** Typed, fixed-code failure. No Zod message, path or stack trace is exposed to callers. */
export class PluginManifestValidationError extends Error {
  constructor(readonly code: PluginManifestValidationCode) {
    super(code);
    this.name = 'PluginManifestValidationError';
  }
}

export interface PluginManifestValidationOptions {
  readonly hostVersion: string;
  readonly requireSignature?: boolean;
  readonly supportedPermissions?: readonly PluginPermission[];
}

/**
 * Strict manifest validation plus host policy. Shape errors are separated from API,
 * compatibility, permission and signature-policy failures so callers can report a
 * stable reason without leaking parser details.
 */
export function validatePluginManifest(input: unknown, options: PluginManifestValidationOptions): PluginManifest {
  if (typeof input === 'object' && input !== null && 'apiVersion' in input && (input as { apiVersion?: unknown }).apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginManifestValidationError('UNSUPPORTED_API');
  }

  const parsed = PluginManifestSchema.safeParse(input);
  if (!parsed.success) throw new PluginManifestValidationError('INVALID_MANIFEST');
  const manifest = parsed.data;

  if (parseSemver(options.hostVersion) === undefined) throw new PluginManifestValidationError('INVALID_HOST_VERSION');
  const { min, max } = manifest.compatibility.host;
  if (compareSemver(options.hostVersion, min) < 0 || compareSemver(options.hostVersion, max) > 0) {
    throw new PluginManifestValidationError('INCOMPATIBLE_HOST');
  }

  if (options.requireSignature === true && manifest.signature === undefined) {
    throw new PluginManifestValidationError('SIGNATURE_REQUIRED');
  }

  const supported = new Set(options.supportedPermissions ?? SUPPORTED_PLUGIN_PERMISSIONS);
  if (manifest.permissions.some(permission => !supported.has(permission))) {
    throw new PluginManifestValidationError('UNSUPPORTED_PERMISSION');
  }

  return manifest;
}
