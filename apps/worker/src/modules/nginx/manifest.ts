/**
 * Pinned Nginx policy.
 *
 * Nginx publishes source tarballs and Windows binary zips on nginx.org but does
 * not publish a SHA-256 sidecar. The digests below were computed locally from the
 * official artifacts on 2026-11-04 and cross-checked by verifying the detached
 * `.asc` signatures with the upstream author key. Provenance is intentionally
 * explicit because the pin is not quoted from an upstream checksum file.
 *
 * Callers may name the pinned version and their own platform/architecture, but
 * never an artifact URL, digest, archive kind or destination.
 */
import { z } from 'zod';

export const NGINX_MODULE_ID = 'nginx';
export const NGINX_VERSION = '1.30.6';
export const NGINX_DOWNLOAD_BASE_URL = 'https://nginx.org/download/';
export const NGINX_SOURCE_ASSET = `nginx-${NGINX_VERSION}.tar.gz`;
export const NGINX_WINDOWS_ASSET = `nginx-${NGINX_VERSION}.zip`;
export const NGINX_SOURCE_URL = `${NGINX_DOWNLOAD_BASE_URL}${NGINX_SOURCE_ASSET}`;
export const NGINX_WINDOWS_URL = `${NGINX_DOWNLOAD_BASE_URL}${NGINX_WINDOWS_ASSET}`;
export const NGINX_SOURCE_SHA256 = '3cf46f5ed7504d460125866b7bea99fb357f31d887e2e63b35503310e9b8b6c8';
export const NGINX_WINDOWS_SHA256 = 'c6ee35edb0a861063323f709192ae50d1eefaf2ea7d00678bd2b22d8542dc61e';
export const NGINX_SOURCE_TOP_LEVEL = `nginx-${NGINX_VERSION}`;
export const NGINX_WINDOWS_TOP_LEVEL = `nginx-${NGINX_VERSION}`;

/** Recorded from the official download page and HTTP metadata on 2026-11-04. */
export const NGINX_PROVENANCE = Object.freeze({
  observedAt: '2026-11-04',
  sourceLastModified: '2026-10-02T14:38:30Z',
  windowsLastModified: '2026-10-05T16:05:31Z',
  signingKeyUrl: 'https://nginx.org/keys/pluknet.key',
  signatureSource: 'https://nginx.org/download/nginx-1.30.6.tar.gz.asc',
  windowsSignatureSource: 'https://nginx.org/download/nginx-1.30.6.zip.asc',
  verifiedWith: 'gpg detached signature, fingerprint D6786CE303D9A9022998DC6CC8464D549AF75C0A'
} as const);

/** Nginx author key (Sergey Kandaurov) used for the 1.30.6 release signatures. */
export const NGINX_SIGNING_KEY_FINGERPRINT = 'D6786CE303D9A9022998DC6CC8464D549AF75C0A';

/**
 * Public key exported from the pinned fingerprint above. It is public data and is
 * only used with `gpg --status-fd` to confirm `VALIDSIG`; no trust is inferred
 * from web-of-trust certification.
 */
export const NGINX_SIGNING_KEY_ARMOR = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGKE4psBEADpHSM/IxFD1nXBmnODYXzcl2A+6b6m9m1m2Y4Dlr0ed+y5Lxne
QidE9I74A2KSm6+eHW2yh4i1ZwZbmwpmQqM+j5BMt7axoXOdKSyN+fYtUakzNbBN
EDRKT79q/zIzkgTJradHkCQkwF1W3go+qPXjR2ZEnLma9dZED9VNI6PmOpeYaASo
IkEfbKbwa/vPrvnDSSYY6Y02RXSRk5U1NvQgVUTJP9WGK7NlPUcTBDELLQv6fFPU
kjBOel6MecsQ+v8iq4RJF2cbVF0hNjbAiNldjLV74Xd7yWVRlCbdb2agyvQjMNrD
jHSvbEMiNB3R8yBHVW2Zldv8q0XjcwoDfdiZYFJe3lRUYmv6I2p+/DptD4r/3ILI
peGZtSeOdQEw+vvODL/Ehq03anTrzcpZ6sDLfLrYJhYcrltj0/LMUnLDAjciwRUq
XI46EfxwqsdLeqoZFQeO3LOFsh0kJKR2xOrUHIVy84NJ4Gmro6WmUkb1NfdjyHzF
z8Lfbo46NKoTcwFsFF0q74jVVIVNUyIS91DusiMqLCsP8jqDOz/kyP4bOJQ+aUXf
BANn4Ll1TFWsJ417moxz+Pi5sTaI0na8z2XB1N9WPsSml3FS75hJPJshN2T3VIea
zB7GFWqk33ynSDt+cAisG5nsK9fFdcH+t5wm59oobyFbFhKxwX6ROuxlZwARAQAB
tCRTZXJnZXkgS2FuZGF1cm92IDxwbHVrbmV0QG5naW54LmNvbT6JAk4EEwEKADgW
IQTWeGzjA9mpAimY3GzIRk1UmvdcCgUCYoTimwIbAwULCQgHAwUVCgkICwUWAwIB
AAIeAQIXgAAKCRDIRk1UmvdcCqbOD/9Htgk3mWvUFmrApkWQTIDNmLACZ1Sw1PXj
Uqte8StYB0bYY+nmAXs7O5eC2h1ViParl7En1joEEMQQmH0qSnw4X1CM/hA8TAYW
mBPITTNWo/R52WoyWeWGFnFNIperQmuIZc+pXm0VEFVPiX/2DXbCIu+jaXySvlCN
LekmOD4VC7dJS8/ohoaXOR2T8ufS+1CsyPXomEb+COhqRZ3EVBa+k7pnElkFft3Y
a1fR0AgatZFQpy+ukePhK7s/M5RGhDJWHgSAZFkf+X2jVV4NRJ+XsY80gU5DD2ZX
QT6Je6Knxqk7FnWNSxkhReH6Ss5flZSoGDCmJ2AsPtGeUhus2fGqeN+waGKTZC35
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
x0VGHDmuaYQ=
=HmVo
-----END PGP PUBLIC KEY BLOCK-----`;

export const DEFAULT_INSTANCE_ID = 'default';
export const LOOPBACK_ADDRESS = '127.0.0.1';
export const DEFAULT_SITE_PORT = 18081;
export const DEFAULT_HOSTNAME = 'localhost';

export const NginxTargetSchema = z.enum(['linux-x64', 'linux-arm64', 'win-x64']);
export type NginxTarget = z.infer<typeof NginxTargetSchema>;

export interface NginxAsset {
  target: NginxTarget;
  /** Official artifact file name. */
  asset: string;
  source: string;
  sha256: string;
  archive: 'tar.gz' | 'zip';
  /** Source builds versus a vendor binary distribution. */
  kind: 'source' | 'binary';
  topLevelDir: string;
  /** The official Windows zip is pinned but not executable in this build. */
  supported: boolean;
  tested: boolean;
}

export const NGINX_ASSETS: Readonly<Record<NginxTarget, NginxAsset>> = Object.freeze({
  'linux-x64': {
    target: 'linux-x64',
    asset: NGINX_SOURCE_ASSET,
    source: NGINX_SOURCE_URL,
    sha256: NGINX_SOURCE_SHA256,
    archive: 'tar.gz',
    kind: 'source',
    topLevelDir: NGINX_SOURCE_TOP_LEVEL,
    supported: true,
    tested: true
  },
  'linux-arm64': {
    target: 'linux-arm64',
    asset: NGINX_SOURCE_ASSET,
    source: NGINX_SOURCE_URL,
    sha256: NGINX_SOURCE_SHA256,
    archive: 'tar.gz',
    kind: 'source',
    topLevelDir: NGINX_SOURCE_TOP_LEVEL,
    supported: true,
    tested: false
  },
  'win-x64': {
    target: 'win-x64',
    asset: NGINX_WINDOWS_ASSET,
    source: NGINX_WINDOWS_URL,
    sha256: NGINX_WINDOWS_SHA256,
    archive: 'zip',
    kind: 'binary',
    topLevelDir: NGINX_WINDOWS_TOP_LEVEL,
    supported: false,
    tested: false
  }
});

/**
 * Windows extraction plan. It is pinned but deliberately not executed: the
 * official zip contains the vendor binary distribution, not source. A future
 * Windows implementation must still add service lifecycle, identity and
 * execution evidence before this plan can be marked supported.
 */
export const NGINX_WINDOWS_PLAN = Object.freeze({
  asset: NGINX_WINDOWS_ASSET,
  source: NGINX_WINDOWS_URL,
  sha256: NGINX_WINDOWS_SHA256,
  archive: 'zip' as const,
  topLevelDir: NGINX_WINDOWS_TOP_LEVEL,
  binaryRelativePath: 'nginx.exe',
  requiredEntries: ['conf/nginx.conf', 'html/index.html', 'logs/'] as const,
  execution: 'unsupported' as const
});

/** Exact platform/arch match only; no fallback between architectures. */
export function nginxTarget(platform: string, architecture: string): NginxTarget | undefined {
  const family = platform === 'win32' || platform === 'windows' ? 'win' : platform;
  if (family !== 'linux' && family !== 'win') return undefined;
  if (architecture !== 'x64' && architecture !== 'arm64') return undefined;
  if (family === 'win' && architecture !== 'x64') return undefined;
  const key = `${family}-${architecture}`;
  return NginxTargetSchema.safeParse(key).success ? (key as NginxTarget) : undefined;
}

export function nginxPlatform(target: NginxTarget): 'win32' | 'linux' {
  return target.startsWith('win-') ? 'win32' : 'linux';
}

export function nginxArchitecture(target: NginxTarget): 'x64' | 'arm64' {
  return target.endsWith('-arm64') ? 'arm64' : 'x64';
}

export function nginxBinaryRelativePath(target: NginxTarget): string {
  return target.startsWith('win-') ? 'nginx.exe' : 'sbin/nginx';
}

export function installationId(target: NginxTarget, version: string = NGINX_VERSION): string {
  return `nginx-${version}-${target}`;
}

export interface NginxLimits {
  maxDownloadBytes: number;
  maxRedirects: number;
  idleTimeoutMs: number;
  maxExtractedEntries: number;
  maxExtractedFileBytes: number;
  maxExtractedTotalBytes: number;
  versionTimeoutMs: number;
  configTimeoutMs: number;
  buildTimeoutMs: number;
  readinessTimeoutMs: number;
  stopGraceMs: number;
  stopKillMs: number;
  maxLogBytes: number;
  maxBuildLogBytes: number;
}

/** Hard ceilings for the official source build and the Windows binary plan. */
export const DEFAULT_NGINX_LIMITS: NginxLimits = Object.freeze({
  maxDownloadBytes: 32 * 1024 * 1024,
  maxRedirects: 5,
  idleTimeoutMs: 30_000,
  maxExtractedEntries: 4_000,
  maxExtractedFileBytes: 64 * 1024 * 1024,
  maxExtractedTotalBytes: 192 * 1024 * 1024,
  versionTimeoutMs: 10_000,
  configTimeoutMs: 10_000,
  buildTimeoutMs: 20 * 60 * 1000,
  readinessTimeoutMs: 20_000,
  stopGraceMs: 5_000,
  stopKillMs: 5_000,
  maxLogBytes: 4 * 1024 * 1024,
  maxBuildLogBytes: 1024 * 1024
});
