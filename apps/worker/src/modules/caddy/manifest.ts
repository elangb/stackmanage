/**
 * Module policy for the pinned Caddy release.
 *
 * The pin lives in the worker module, not in shared contracts: `@stackmanage/core`
 * only knows the module-agnostic install request shape (`moduleId`, `version`,
 * `platform`, `architecture`). A caller cannot widen the accepted set below
 * without editing this file.
 */
import { z } from 'zod';

export const CADDY_MODULE_ID = 'caddy';
export const CADDY_VERSION = '2.11.8';
export const CADDY_RELEASE_BASE_URL = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/`;

/**
 * Single instance in Phase 1; the id is fixed so a caller cannot address another
 * instance. Matches the frozen `CADDY_INSTANCE_ID` in `@stackmanage/core`.
 */
export const DEFAULT_INSTANCE_ID = 'default';
export const LOOPBACK_ADDRESS = '127.0.0.1';
export const DEFAULT_SITE_PORT = 18080;
export const DEFAULT_HOSTNAME = 'localhost';

export const CaddyTargetSchema = z.enum(['linux-amd64', 'linux-arm64', 'windows-amd64']);
export type CaddyTarget = z.infer<typeof CaddyTargetSchema>;

export interface CaddyAsset {
  asset: string;
  /** Verified on every download; the upstream checksums file publishes SHA-512. */
  sha512: string;
  /** SHA-256 of the same artifact, computed from the official download and cross-checked with its SHA-512. */
  sha256: string;
  archive: 'tar.gz' | 'zip';
}

/**
 * Official GitHub release assets, pinned by the SHA-512 values in
 * `caddy_2.11.8_checksums.txt`. SHA-512 is the verified digest: the 64-hex
 * strings sometimes quoted for Caddy are truncations of these values and would
 * never match a real SHA-256 of the artifact.
 */
export const CADDY_ASSETS: Readonly<Record<CaddyTarget, CaddyAsset>> = Object.freeze({
  'linux-amd64': {
    asset: 'caddy_2.11.8_linux_amd64.tar.gz',
    sha256: 'f032f8805e4df2ce5e1a8a624495c91e9ff763d8ff3ceddadd4784a07c472f40',
    sha512: 'c863699eee84c6b410573de2ec67af81d07eb054f9020bb98f3c6cb256fea4be2fd1acfbd39110c649c3338282593bba3d3ed6424d91b7f5675e8b877a8999e9',
    archive: 'tar.gz'
  },
  'linux-arm64': {
    asset: 'caddy_2.11.8_linux_arm64.tar.gz',
    sha256: '6781a68e090fecda8c563b5a3b00115e18d7134084099ae804a017622471bed1',
    sha512: '6a285426268c8f987e0c459f61dc5af3c25e663955c0e4dddc6e187722b7cdd15e4233ff0e570a4ee17b3c68d59e2a61ce96d2f6be55ea58eead6a334859557c',
    archive: 'tar.gz'
  },
  'windows-amd64': {
    asset: 'caddy_2.11.8_windows_amd64.zip',
    sha256: 'eaf062366aeba9d782af7f70edb4b49097652be1af31e8141f9f2761aa25cb1f',
    sha512: 'fff45b117b9d9ea5cc3f824f3c18de89630bcb43a0b759ca5e7163b7a3c1fb39ec7dae7f3147012d602213c950a46c8b0ef8095c77109e807ebf90132deeb759',
    archive: 'zip'
  }
});

/** Exact platform/arch match only; no fallback between architectures. */
export function caddyTarget(platform: string, architecture: string): CaddyTarget | undefined {
  const normalizedPlatform = platform === 'win32' ? 'windows' : platform;
  const normalizedArch = architecture === 'x64' ? 'amd64' : architecture;
  const key = `${normalizedPlatform}-${normalizedArch}`;
  return CaddyTargetSchema.safeParse(key).success ? (key as CaddyTarget) : undefined;
}

export function caddyAssetUrl(target: CaddyTarget): string {
  return `${CADDY_RELEASE_BASE_URL}${CADDY_ASSETS[target].asset}`;
}

export function caddyBinaryName(platform: string): string {
  return platform === 'win32' || platform === 'windows' ? 'caddy.exe' : 'caddy';
}

export interface OperationalLimits {
  maxDownloadBytes: number;
  maxRedirects: number;
  idleTimeoutMs: number;
  maxExtractedEntries: number;
  maxExtractedFileBytes: number;
  maxLogBytes: number;
  readinessTimeoutMs: number;
  stopGraceMs: number;
  stopKillMs: number;
}

/** Bounded defaults; every one of these is a hard ceiling, not a hint. */
export const DEFAULT_OPERATIONAL_LIMITS: OperationalLimits = Object.freeze({
  maxDownloadBytes: 128 * 1024 * 1024,
  maxRedirects: 5,
  idleTimeoutMs: 30_000,
  maxExtractedEntries: 512,
  maxExtractedFileBytes: 256 * 1024 * 1024,
  maxLogBytes: 4 * 1024 * 1024,
  readinessTimeoutMs: 20_000,
  stopGraceMs: 5_000,
  stopKillMs: 5_000
});

export {
  OperationFailure,
  OperationAbortedError,
  throwIfAborted,
  errorOf,
  failureResult,
  OperationProgress
} from '../../shared/operation';
