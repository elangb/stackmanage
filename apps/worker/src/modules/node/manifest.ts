/**
 * Pinned Node.js runtime policy.
 *
 * The official distribution is the only accepted source. Callers may name the
 * pinned version and their own platform/architecture, but never an artifact URL,
 * digest, archive kind or destination. The SHA-256 values below are the official
 * SHASUMS256.txt entries for the pinned release; `linux-x64` is the only target
 * with execution evidence in this build.
 */
import { z } from 'zod';

export const NODE_MODULE_ID = 'node';
export const NODE_VERSION = '24.22.2';
export const NODE_RELEASE_BASE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/`;
export const NODE_SHASUMS_URL = `${NODE_RELEASE_BASE_URL}SHASUMS256.txt`;

export const NodeTargetSchema = z.enum(['linux-x64', 'linux-arm64', 'win-x64', 'win-arm64']);
export type NodeTarget = z.infer<typeof NodeTargetSchema>;

export interface NodeAsset {
  /** Official archive file name. */
  asset: string;
  /** Exact top-level directory inside the official archive. */
  topLevelDir: string;
  /** Executable path relative to `topLevelDir`, using POSIX separators. */
  binaryRelativePath: string;
  /** Official SHA-256 from SHASUMS256.txt for the pinned release. */
  sha256: string;
  archive: 'tar.gz' | 'zip';
}

export const NODE_ASSETS: Readonly<Record<NodeTarget, NodeAsset>> = Object.freeze({
  'linux-x64': {
    asset: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    topLevelDir: `node-v${NODE_VERSION}-linux-x64`,
    binaryRelativePath: 'bin/node',
    sha256: '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
    archive: 'tar.gz'
  },
  'linux-arm64': {
    asset: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    topLevelDir: `node-v${NODE_VERSION}-linux-arm64`,
    binaryRelativePath: 'bin/node',
    sha256: '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2',
    archive: 'tar.gz'
  },
  'win-x64': {
    asset: `node-v${NODE_VERSION}-win-x64.zip`,
    topLevelDir: `node-v${NODE_VERSION}-win-x64`,
    binaryRelativePath: 'node.exe',
    sha256: 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2',
    archive: 'zip'
  },
  'win-arm64': {
    asset: `node-v${NODE_VERSION}-win-arm64.zip`,
    topLevelDir: `node-v${NODE_VERSION}-win-arm64`,
    binaryRelativePath: 'node.exe',
    sha256: 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468',
    archive: 'zip'
  }
});

/** Exact platform/arch match only; macOS is not part of the pinned release set. */
export function nodeTarget(platform: string, architecture: string): NodeTarget | undefined {
  const family = platform === 'win32' || platform === 'windows' ? 'win' : platform;
  if (family !== 'linux' && family !== 'win') return undefined;
  if (architecture !== 'x64' && architecture !== 'arm64') return undefined;
  const key = `${family}-${architecture}`;
  return NodeTargetSchema.safeParse(key).success ? (key as NodeTarget) : undefined;
}

export function nodeAssetUrl(target: NodeTarget): string {
  return `${NODE_RELEASE_BASE_URL}${NODE_ASSETS[target].asset}`;
}

/** Only Linux x64 actually ran the vendor binary in this build. */
export function nodeTargetTested(target: NodeTarget): boolean {
  return target === 'linux-x64';
}

export function nodePlatform(target: NodeTarget): 'win32' | 'linux' {
  return target.startsWith('win-') ? 'win32' : 'linux';
}

export function nodeArchitecture(target: NodeTarget): 'x64' | 'arm64' {
  return target.endsWith('-x64') ? 'x64' : 'arm64';
}

/** PATH prepend plan; explicit, never applied to a shell or global profile here. */
export function nodePathPrepend(directory: string, target: NodeTarget): string[] {
  return target.startsWith('win-') ? [directory] : [`${directory}/bin`];
}

export interface NodeLimits {
  maxDownloadBytes: number;
  maxRedirects: number;
  idleTimeoutMs: number;
  maxExtractedEntries: number;
  maxExtractedFileBytes: number;
  maxExtractedTotalBytes: number;
  versionTimeoutMs: number;
}

/** Hard ceilings for the official archive, not hints. */
export const DEFAULT_NODE_LIMITS: NodeLimits = Object.freeze({
  maxDownloadBytes: 128 * 1024 * 1024,
  maxRedirects: 5,
  idleTimeoutMs: 30_000,
  maxExtractedEntries: 6_000,
  maxExtractedFileBytes: 256 * 1024 * 1024,
  maxExtractedTotalBytes: 512 * 1024 * 1024,
  versionTimeoutMs: 10_000
});
