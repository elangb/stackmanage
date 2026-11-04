/**
 * Pinned Redis policy.
 *
 * Redis 7.2.7 is the last BSD-3-Clause line: Redis 7.4 changed the default
 * licence to RSALv2/SSPLv1 and Redis 8 added an AGPLv3 option. The digest below
 * was computed locally from the official artifact on 2026-11-04; the vendor does
 * not publish a SHA-256 sidecar for release tarballs.
 *
 * Callers may name the pinned version and their own platform/architecture, but
 * never an artifact URL, digest, build flag, port, config path or destination.
 */
import { z } from 'zod';

export const REDIS_MODULE_ID = 'redis';
export const REDIS_VERSION = '7.2.7';
export const REDIS_DOWNLOAD_BASE_URL = 'https://download.redis.io/releases/';
export const REDIS_SOURCE_ASSET = `redis-${REDIS_VERSION}.tar.gz`;
export const REDIS_SOURCE_URL = `${REDIS_DOWNLOAD_BASE_URL}${REDIS_SOURCE_ASSET}`;
export const REDIS_SOURCE_SHA256 = '72c081e3b8cfae7144273d26d76736f08319000af46c01515cad5d29765cead5';
export const REDIS_SOURCE_TOP_LEVEL = `redis-${REDIS_VERSION}`;
export const REDIS_SOURCE_BYTES = 3_394_075;
export const REDIS_LICENSE = 'BSD-3-Clause';
export const REDIS_LICENSE_URL = 'https://github.com/redis/redis/blob/7.2.7/COPYING';

/** Recorded from the official artifact on 2026-11-04. */
export const REDIS_PROVENANCE = Object.freeze({
  observedAt: '2026-11-04',
  computedFrom: 'https://download.redis.io/releases/redis-7.2.7.tar.gz',
  bytes: REDIS_SOURCE_BYTES,
  licence: REDIS_LICENSE,
  licenceEvidence: REDIS_LICENSE_URL,
  checksumSource: 'local SHA-256 of the official tarball (vendor publishes no sidecar)'
} as const);

export const LOOPBACK_ADDRESS = '127.0.0.1';
export const DEFAULT_REDIS_PORT = 16379;
export const DEFAULT_INSTANCE_ID = 'default';
/**
 * Small hard cap for a local development instance. It is deliberately low so a
 * runaway client cannot exhaust the host; it is not a licence or product quota.
 */
export const DEFAULT_MAXMEMORY_BYTES = 64 * 1024 * 1024;

/** Redis ships no supported native Windows build; no unofficial fork is used. */
export const REDIS_WINDOWS_NOTE = Object.freeze({
  status: 'unsupported' as const,
  reason: 'Redis upstream provides no supported native Windows build. StackManage does not substitute unofficial forks.'
});

export const RedisTargetSchema = z.enum(['linux-x64', 'linux-arm64']);
export type RedisTarget = z.infer<typeof RedisTargetSchema>;

export interface RedisAsset {
  target: RedisTarget;
  asset: string;
  source: string;
  sha256: string;
  archive: 'tar.gz';
  kind: 'source';
  topLevelDir: string;
  supported: boolean;
  tested: boolean;
}

export const REDIS_ASSETS: Readonly<Record<RedisTarget, RedisAsset>> = Object.freeze({
  'linux-x64': {
    target: 'linux-x64',
    asset: REDIS_SOURCE_ASSET,
    source: REDIS_SOURCE_URL,
    sha256: REDIS_SOURCE_SHA256,
    archive: 'tar.gz',
    kind: 'source',
    topLevelDir: REDIS_SOURCE_TOP_LEVEL,
    supported: true,
    tested: true
  },
  'linux-arm64': {
    target: 'linux-arm64',
    asset: REDIS_SOURCE_ASSET,
    source: REDIS_SOURCE_URL,
    sha256: REDIS_SOURCE_SHA256,
    archive: 'tar.gz',
    kind: 'source',
    topLevelDir: REDIS_SOURCE_TOP_LEVEL,
    supported: true,
    tested: false
  }
});

/** Exact platform/arch match only; Windows is deliberately absent. */
export function redisTarget(platform: string, architecture: string): RedisTarget | undefined {
  if (platform !== 'linux') return undefined;
  if (architecture !== 'x64' && architecture !== 'arm64') return undefined;
  const key = `linux-${architecture}`;
  return RedisTargetSchema.safeParse(key).success ? (key as RedisTarget) : undefined;
}

export function redisPlatform(): 'linux' {
  return 'linux';
}

export function redisArchitecture(target: RedisTarget): 'x64' | 'arm64' {
  return target.endsWith('-arm64') ? 'arm64' : 'x64';
}

export function installationId(target: RedisTarget, version: string = REDIS_VERSION): string {
  return `redis-${version}-${target}`;
}

export interface RedisLimits {
  maxDownloadBytes: number;
  maxRedirects: number;
  idleTimeoutMs: number;
  maxExtractedEntries: number;
  maxExtractedFileBytes: number;
  maxExtractedTotalBytes: number;
  versionTimeoutMs: number;
  buildTimeoutMs: number;
  readinessTimeoutMs: number;
  stopGraceMs: number;
  stopKillMs: number;
  maxLogBytes: number;
  maxBuildLogBytes: number;
}

/** Hard ceilings for the official source build. */
export const DEFAULT_REDIS_LIMITS: RedisLimits = Object.freeze({
  maxDownloadBytes: 64 * 1024 * 1024,
  maxRedirects: 5,
  idleTimeoutMs: 30_000,
  maxExtractedEntries: 8_000,
  maxExtractedFileBytes: 32 * 1024 * 1024,
  maxExtractedTotalBytes: 256 * 1024 * 1024,
  versionTimeoutMs: 10_000,
  buildTimeoutMs: 20 * 60 * 1000,
  readinessTimeoutMs: 20_000,
  stopGraceMs: 5_000,
  stopKillMs: 5_000,
  maxLogBytes: 4 * 1024 * 1024,
  maxBuildLogBytes: 1024 * 1024
});
