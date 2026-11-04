import { z } from 'zod';
import {
  ErrorSchema,
  IdSchema,
  InstallationSchema,
  OperationEventSchema,
  OperationResultSchema,
  ServiceRefSchema,
  ServiceStateSchema,
  SiteSchema
} from './contracts';

/**
 * Additive Phase 1 extension of the frozen v1 wire surface.
 *
 * Nothing below changes an existing field, literal or response shape: every
 * documented v1 object keeps its exact schema and the bootstrap `health` method
 * keeps its exact request/response contract. Caddy version pins, digests and
 * module-specific policy live in the worker module, never in this shared package.
 */

export const OperationRequestIdSchema = IdSchema;
export const InstanceIdSchema = IdSchema;
export const SiteIdSchema = IdSchema;

/**
 * Module-agnostic install request. The owning worker module validates the
 * module/version pair against its pinned vendor manifest; callers can never
 * supply an artifact URL or digest.
 */
export const InstallRequestSchema = z
  .object({
    operationId: OperationRequestIdSchema,
    moduleId: IdSchema,
    version: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64'])
  })
  .strict();
export type InstallRequest = z.infer<typeof InstallRequestSchema>;

/**
 * Additive runtime surface (Phase 3). Runtime ownership stays in the worker: the
 * renderer names a module and pinned version, never an archive URL, digest or
 * destination path. `runtime.install` is the same mutation shape as `install`,
 * but it is a separate channel so a runtime never gains service lifecycle powers.
 */
export const RuntimeModuleRequestSchema = z.object({ moduleId: IdSchema }).strict();
export type RuntimeModuleRequest = z.infer<typeof RuntimeModuleRequestSchema>;

export const RuntimeInstallRequestSchema = InstallRequestSchema;
export type RuntimeInstallRequest = z.infer<typeof RuntimeInstallRequestSchema>;

export const RuntimeUninstallRequestSchema = z
  .object({ operationId: OperationRequestIdSchema, installationId: IdSchema })
  .strict();
export type RuntimeUninstallRequest = z.infer<typeof RuntimeUninstallRequestSchema>;

/** A pinned artifact, not a claim that it ran. `tested` is execution evidence only. */
export const RuntimeVersionViewSchema = z
  .object({
    moduleId: IdSchema,
    version: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    source: z.url().refine(v => new URL(v).protocol === 'https:', 'HTTPS required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    archive: z.enum(['tar.gz', 'zip']),
    tested: z.boolean()
  })
  .strict();
export type RuntimeVersionView = z.infer<typeof RuntimeVersionViewSchema>;

export const RuntimeVersionsViewSchema = z
  .object({
    moduleId: IdSchema,
    pinnedVersion: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    supported: z.boolean(),
    tested: z.boolean(),
    versions: z.array(RuntimeVersionViewSchema).max(20)
  })
  .strict();
export type RuntimeVersionsView = z.infer<typeof RuntimeVersionsViewSchema>;

/** Installed runtime facts. The binary path and PATH plan are read-only projections. */
export const RuntimeInstallationViewSchema = z
  .object({
    id: IdSchema,
    moduleId: IdSchema,
    version: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    directory: z.string().min(1).max(4096),
    binaryPath: z.string().min(1).max(4096),
    versionOutput: z.string().min(1).max(200),
    installedAt: z.iso.datetime(),
    pathPrepend: z.array(z.string().min(1).max(4096)).max(8)
  })
  .strict();
export type RuntimeInstallationView = z.infer<typeof RuntimeInstallationViewSchema>;

export const RuntimeStatusViewSchema = z
  .object({
    moduleId: IdSchema,
    pinnedVersion: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    supported: z.boolean(),
    tested: z.boolean(),
    installed: z.boolean(),
    installation: RuntimeInstallationViewSchema.optional(),
    pathPrepend: z.array(z.string().min(1).max(4096)).max(8)
  })
  .strict();
export type RuntimeStatusView = z.infer<typeof RuntimeStatusViewSchema>;

export const RuntimeListViewSchema = z
  .object({ moduleId: IdSchema, installations: z.array(RuntimeInstallationViewSchema).max(10) })
  .strict();
export type RuntimeListView = z.infer<typeof RuntimeListViewSchema>;

/**
 * Additive Nginx surface (Phase 4). The module owns the pinned source build and
 * the single managed service instance. Callers may name the module/version and
 * lifecycle operation, never a URL, digest, build flag, config path or shell.
 */
export const NginxModuleRequestSchema = z.object({ moduleId: z.literal('nginx') }).strict();
export type NginxModuleRequest = z.infer<typeof NginxModuleRequestSchema>;

export const NginxInstallRequestSchema = InstallRequestSchema;
export type NginxInstallRequest = z.infer<typeof NginxInstallRequestSchema>;

export const NginxUninstallRequestSchema = z
  .object({ operationId: OperationRequestIdSchema, installationId: IdSchema })
  .strict();
export type NginxUninstallRequest = z.infer<typeof NginxUninstallRequestSchema>;

export const NginxLifecycleRequestSchema = z
  .object({
    operationId: OperationRequestIdSchema,
    /** Caller-supplied readiness bound; the worker clamps it into an operational range. */
    timeoutMs: z.number().int().min(1000).max(120_000).optional()
  })
  .strict();
export type NginxLifecycleRequest = z.infer<typeof NginxLifecycleRequestSchema>;

export const NginxLogsRequestSchema = z.object({ maxBytes: z.number().int().min(256).max(1_048_576) }).strict();
export type NginxLogsRequest = z.infer<typeof NginxLogsRequestSchema>;

export const NginxConfigRequestSchema = z.object({}).strict();
export type NginxConfigRequest = z.infer<typeof NginxConfigRequestSchema>;

export const NginxVersionViewSchema = z
  .object({
    moduleId: z.literal('nginx'),
    version: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    source: z.url().refine(v => new URL(v).protocol === 'https:', 'HTTPS required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    archive: z.enum(['tar.gz', 'zip']),
    kind: z.enum(['source', 'binary']),
    tested: z.boolean(),
    supported: z.boolean()
  })
  .strict();
export type NginxVersionView = z.infer<typeof NginxVersionViewSchema>;

export const NginxVersionsViewSchema = z
  .object({
    moduleId: z.literal('nginx'),
    pinnedVersion: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    supported: z.boolean(),
    tested: z.boolean(),
    versions: z.array(NginxVersionViewSchema).max(4)
  })
  .strict();
export type NginxVersionsView = z.infer<typeof NginxVersionsViewSchema>;

export const NginxInstallationViewSchema = z
  .object({
    id: IdSchema,
    moduleId: z.literal('nginx'),
    version: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    directory: z.string().min(1).max(4096),
    binaryPath: z.string().min(1).max(4096),
    versionOutput: z.string().min(1).max(200),
    installedAt: z.iso.datetime(),
    source: z.url().refine(v => new URL(v).protocol === 'https:', 'HTTPS required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type NginxInstallationView = z.infer<typeof NginxInstallationViewSchema>;

export const NginxServiceViewSchema = z
  .object({
    state: z.enum(['stopped', 'starting', 'running', 'stopping', 'failed', 'unknown']),
    pid: z.number().int().positive().optional(),
    port: z.number().int().min(1).max(65535),
    ports: z.array(z.number().int().min(1).max(65535)).max(8),
    configPath: z.string().min(1).max(4096),
    logPath: z.string().min(1).max(4096),
    observedAt: z.iso.datetime()
  })
  .strict();
export type NginxServiceView = z.infer<typeof NginxServiceViewSchema>;

export const NginxStatusViewSchema = z
  .object({
    moduleId: z.literal('nginx'),
    pinnedVersion: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    supported: z.boolean(),
    tested: z.boolean(),
    installed: z.boolean(),
    installation: NginxInstallationViewSchema.optional(),
    service: NginxServiceViewSchema
  })
  .strict();
export type NginxStatusView = z.infer<typeof NginxStatusViewSchema>;

export const NginxListViewSchema = z.object({ moduleId: z.literal('nginx'), installations: z.array(NginxInstallationViewSchema).max(4) }).strict();
export type NginxListView = z.infer<typeof NginxListViewSchema>;

export const NginxLogsViewSchema = z
  .object({
    path: z.string().min(1).max(4096),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    text: z.string().max(1_048_576)
  })
  .strict();
export type NginxLogsView = z.infer<typeof NginxLogsViewSchema>;

/**
 * Additive Redis surface (Phase 6). Redis is built from the pinned official source
 * into a per-user prefix and runs as a single managed instance. Callers may name
 * the module/version and lifecycle operation, never a URL, digest, build flag,
 * config path, port or shell command.
 */
export const RedisModuleRequestSchema = z.object({ moduleId: z.literal('redis') }).strict();
export type RedisModuleRequest = z.infer<typeof RedisModuleRequestSchema>;

export const RedisInstallRequestSchema = InstallRequestSchema;
export type RedisInstallRequest = z.infer<typeof RedisInstallRequestSchema>;

export const RedisUninstallRequestSchema = z
  .object({ operationId: OperationRequestIdSchema, installationId: IdSchema })
  .strict();
export type RedisUninstallRequest = z.infer<typeof RedisUninstallRequestSchema>;

export const RedisLifecycleRequestSchema = z
  .object({
    operationId: OperationRequestIdSchema,
    /** Caller-supplied readiness bound; the worker clamps it into an operational range. */
    timeoutMs: z.number().int().min(1000).max(120_000).optional()
  })
  .strict();
export type RedisLifecycleRequest = z.infer<typeof RedisLifecycleRequestSchema>;

export const RedisLogsRequestSchema = z.object({ maxBytes: z.number().int().min(256).max(1_048_576) }).strict();
export type RedisLogsRequest = z.infer<typeof RedisLogsRequestSchema>;

export const RedisVersionViewSchema = z
  .object({
    moduleId: z.literal('redis'),
    version: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    source: z.url().refine(v => new URL(v).protocol === 'https:', 'HTTPS required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    archive: z.literal('tar.gz'),
    kind: z.literal('source'),
    tested: z.boolean(),
    supported: z.boolean()
  })
  .strict();
export type RedisVersionView = z.infer<typeof RedisVersionViewSchema>;

export const RedisVersionsViewSchema = z
  .object({
    moduleId: z.literal('redis'),
    pinnedVersion: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    supported: z.boolean(),
    tested: z.boolean(),
    versions: z.array(RedisVersionViewSchema).max(4)
  })
  .strict();
export type RedisVersionsView = z.infer<typeof RedisVersionsViewSchema>;

export const RedisInstallationViewSchema = z
  .object({
    id: IdSchema,
    moduleId: z.literal('redis'),
    version: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    directory: z.string().min(1).max(4096),
    serverPath: z.string().min(1).max(4096),
    cliPath: z.string().min(1).max(4096),
    versionOutput: z.string().min(1).max(200),
    cliVersionOutput: z.string().min(1).max(200),
    installedAt: z.iso.datetime(),
    source: z.url().refine(v => new URL(v).protocol === 'https:', 'HTTPS required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type RedisInstallationView = z.infer<typeof RedisInstallationViewSchema>;

export const RedisServiceViewSchema = z
  .object({
    state: z.enum(['stopped', 'starting', 'running', 'stopping', 'failed', 'unknown']),
    pid: z.number().int().positive().optional(),
    port: z.number().int().min(1).max(65535),
    bind: z.literal('127.0.0.1'),
    configPath: z.string().min(1).max(4096),
    dataDir: z.string().min(1).max(4096),
    logPath: z.string().min(1).max(4096),
    pidFile: z.string().min(1).max(4096),
    observedAt: z.iso.datetime()
  })
  .strict();
export type RedisServiceView = z.infer<typeof RedisServiceViewSchema>;

export const RedisStatusViewSchema = z
  .object({
    moduleId: z.literal('redis'),
    pinnedVersion: z.string().min(1).max(100),
    platform: z.enum(['win32', 'linux', 'darwin']),
    architecture: z.enum(['x64', 'arm64']),
    supported: z.boolean(),
    tested: z.boolean(),
    installed: z.boolean(),
    installation: RedisInstallationViewSchema.optional(),
    service: RedisServiceViewSchema
  })
  .strict();
export type RedisStatusView = z.infer<typeof RedisStatusViewSchema>;

export const RedisListViewSchema = z.object({ moduleId: z.literal('redis'), installations: z.array(RedisInstallationViewSchema).max(4) }).strict();
export type RedisListView = z.infer<typeof RedisListViewSchema>;

export const RedisLogsViewSchema = z
  .object({
    path: z.string().min(1).max(4096),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    text: z.string().max(1_048_576)
  })
  .strict();
export type RedisLogsView = z.infer<typeof RedisLogsViewSchema>;

export const ServiceRequestSchema = z.object({
  operationId: OperationRequestIdSchema,
  ref: ServiceRefSchema,
  /** Caller-supplied readiness bound; the worker clamps it into an operational range. */
  timeoutMs: z.number().int().min(1000).max(120_000).optional()
}).strict();
export type ServiceRequest = z.infer<typeof ServiceRequestSchema>;

export const InstanceRequestSchema = z.object({ instanceId: InstanceIdSchema }).strict();
export type InstanceRequest = z.infer<typeof InstanceRequestSchema>;

export const LogTailRequestSchema = z
  .object({ instanceId: InstanceIdSchema, maxBytes: z.number().int().min(256).max(1_048_576) })
  .strict();
export type LogTailRequest = z.infer<typeof LogTailRequestSchema>;

/**
 * Site is the frozen v1 shape. `server` names the owning service reference and
 * `root` must resolve inside the module's managed sites directory.
 */
export const ManagedSiteSchema = SiteSchema;
export type ManagedSite = z.infer<typeof ManagedSiteSchema>;

export const SitesApplyRequestSchema = z
  .object({
    operationId: OperationRequestIdSchema,
    sites: z.array(ManagedSiteSchema).min(1).max(100)
  })
  .strict();
export type SitesApplyRequest = z.infer<typeof SitesApplyRequestSchema>;

export const SiteRemoveRequestSchema = z.object({ operationId: OperationRequestIdSchema, siteId: SiteIdSchema }).strict();
export type SiteRemoveRequest = z.infer<typeof SiteRemoveRequestSchema>;

export const SiteListViewSchema = z.object({ sites: z.array(SiteSchema).max(100) }).strict();
export type SiteListView = z.infer<typeof SiteListViewSchema>;

export const LogTailViewSchema = z
  .object({
    instanceId: InstanceIdSchema,
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    text: z.string().max(1_048_576)
  })
  .strict();
export type LogTailView = z.infer<typeof LogTailViewSchema>;

/** Read-only view of the generated service configuration. Never writable over the wire. */
export const ConfigReadRequestSchema = z.object({ instanceId: InstanceIdSchema }).strict();
export type ConfigReadRequest = z.infer<typeof ConfigReadRequestSchema>;

export const ConfigReadViewSchema = z
  .object({
    path: z.string().min(1).max(4096),
    exists: z.boolean(),
    content: z.string().max(240_000)
  })
  .strict();
export type ConfigReadView = z.infer<typeof ConfigReadViewSchema>;

/** Startup reconciliation of a persisted service record against the live process table. */
export const ReconcileEntrySchema = z
  .object({
    instanceId: IdSchema,
    outcome: z.enum(['absent', 'adopted', 'cleared', 'unverified']),
    pid: z.number().int().positive().optional()
  })
  .strict();
export type ReconcileEntry = z.infer<typeof ReconcileEntrySchema>;

export const ReconcileReportSchema = z
  .object({
    checked: z.number().int().nonnegative(),
    adopted: z.number().int().nonnegative(),
    cleared: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
    entries: z.array(ReconcileEntrySchema).max(32)
  })
  .strict()
  .refine(v => v.checked === v.entries.length, 'checked must equal entries length');
export type ReconcileReport = z.infer<typeof ReconcileReportSchema>;

export const InstallationListViewSchema = z
  .object({
    installations: z.array(InstallationSchema).max(10),
    versionCheck: z.object({ version: z.string().min(1).max(100), valid: z.boolean(), output: z.string().max(500) }).strict().optional()
  })
  .strict();

/** Local CA status for the managed web server. Never exposes a private key. */
export const CertificateStatusViewSchema = z
  .object({
    authorityPath: z.string().min(1).max(4096),
    exists: z.boolean(),
    browserTrust: z.enum(['trusted', 'untrusted', 'unsupported', 'unknown']),
    systemTrust: z.enum(['not-modified', 'trusted', 'untrusted', 'unsupported', 'unknown']),
    detail: z.string().max(300).optional()
  })
  .strict();
export type CertificateStatusView = z.infer<typeof CertificateStatusViewSchema>;

export const TrustRequestSchema = z.object({ operationId: OperationRequestIdSchema }).strict();
export type TrustRequest = z.infer<typeof TrustRequestSchema>;
export type InstallationListView = z.infer<typeof InstallationListViewSchema>;

export const ServiceListViewSchema = z.object({ services: z.array(ServiceStateSchema).max(10) }).strict();
export type ServiceListView = z.infer<typeof ServiceListViewSchema>;

export const WorkerMethodResultSchema = z.union([
  z.object({ method: z.literal('install'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('service.start'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('service.stop'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('service.restart'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('service.status'), data: ServiceStateSchema }).strict(),
  z.object({ method: z.literal('services.list'), data: ServiceListViewSchema }).strict(),
  z.object({ method: z.literal('installations.list'), data: InstallationListViewSchema }).strict(),
  z.object({ method: z.literal('logs.tail'), data: LogTailViewSchema }).strict(),
  z.object({ method: z.literal('config.read'), data: ConfigReadViewSchema }).strict(),
  z.object({ method: z.literal('certificates.status'), data: CertificateStatusViewSchema }).strict(),
  z.object({ method: z.literal('certificates.trust'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('sites.apply'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('sites.list'), data: SiteListViewSchema }).strict(),
  z.object({ method: z.literal('sites.remove'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('runtime.versions'), data: RuntimeVersionsViewSchema }).strict(),
  z.object({ method: z.literal('runtime.install'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('runtime.status'), data: RuntimeStatusViewSchema }).strict(),
  z.object({ method: z.literal('runtime.list'), data: RuntimeListViewSchema }).strict(),
  z.object({ method: z.literal('runtime.uninstall'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('nginx.versions'), data: NginxVersionsViewSchema }).strict(),
  z.object({ method: z.literal('nginx.install'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('nginx.status'), data: NginxStatusViewSchema }).strict(),
  z.object({ method: z.literal('nginx.list'), data: NginxListViewSchema }).strict(),
  z.object({ method: z.literal('nginx.uninstall'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('nginx.start'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('nginx.stop'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('nginx.reload'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('nginx.logs'), data: NginxLogsViewSchema }).strict(),
  z.object({ method: z.literal('nginx.config'), data: ConfigReadViewSchema }).strict(),
  z.object({ method: z.literal('redis.versions'), data: RedisVersionsViewSchema }).strict(),
  z.object({ method: z.literal('redis.install'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('redis.status'), data: RedisStatusViewSchema }).strict(),
  z.object({ method: z.literal('redis.list'), data: RedisListViewSchema }).strict(),
  z.object({ method: z.literal('redis.uninstall'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('redis.start'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('redis.stop'), data: OperationResultSchema }).strict(),
  z.object({ method: z.literal('redis.logs'), data: RedisLogsViewSchema }).strict()
]);
export type WorkerMethodResult = z.infer<typeof WorkerMethodResultSchema>;
export type ErrorCode = z.infer<typeof ErrorSchema.shape.code>;
/** Management methods only; `health` keeps its own frozen exchange. */
export type WorkerManagementMethod = Exclude<WorkerMethod, 'health'>;

/** Every method the worker dispatches, including the frozen `health` probe. */
export const WORKER_METHODS = [
  'health',
  'install',
  'service.start',
  'service.stop',
  'service.restart',
  'service.status',
  'services.list',
  'installations.list',
  'logs.tail',
  'config.read',
  'certificates.status',
  'certificates.trust',
  'sites.apply',
  'sites.list',
  'sites.remove',
  'runtime.versions',
  'runtime.install',
  'runtime.status',
  'runtime.list',
  'runtime.uninstall',
  'nginx.versions',
  'nginx.install',
  'nginx.status',
  'nginx.list',
  'nginx.uninstall',
  'nginx.start',
  'nginx.stop',
  'nginx.reload',
  'nginx.logs',
  'nginx.config',
  'redis.versions',
  'redis.install',
  'redis.status',
  'redis.list',
  'redis.uninstall',
  'redis.start',
  'redis.stop',
  'redis.logs'
] as const;
export type WorkerMethod = (typeof WORKER_METHODS)[number];

const EnvelopeBase = { apiVersion: z.literal(1), id: IdSchema };
export const WorkerHealthRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('health') }).strict();
export const WorkerInstallRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('install'), params: InstallRequestSchema }).strict();
export const WorkerServiceRequestSchema = z
  .object({ ...EnvelopeBase, method: z.enum(['service.start', 'service.stop', 'service.restart']), params: ServiceRequestSchema })
  .strict();
export const WorkerServiceStatusRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('service.status'), params: InstanceRequestSchema }).strict();
export const WorkerServicesListRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('services.list') }).strict();
export const WorkerInstallationsListRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('installations.list') }).strict();
export const WorkerLogsTailRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('logs.tail'), params: LogTailRequestSchema }).strict();
export const WorkerConfigReadRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('config.read'), params: ConfigReadRequestSchema }).strict();
export const WorkerCertificateStatusRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('certificates.status') }).strict();
export const WorkerCertificateTrustRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('certificates.trust'), params: TrustRequestSchema }).strict();
export const WorkerSitesApplyRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('sites.apply'), params: SitesApplyRequestSchema }).strict();
export const WorkerSitesListRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('sites.list') }).strict();
export const WorkerSitesRemoveRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('sites.remove'), params: SiteRemoveRequestSchema }).strict();
export const WorkerRuntimeVersionsRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('runtime.versions'), params: RuntimeModuleRequestSchema }).strict();
export const WorkerRuntimeInstallRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('runtime.install'), params: RuntimeInstallRequestSchema }).strict();
export const WorkerRuntimeStatusRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('runtime.status'), params: RuntimeModuleRequestSchema }).strict();
export const WorkerRuntimeListRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('runtime.list'), params: RuntimeModuleRequestSchema }).strict();
export const WorkerRuntimeUninstallRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('runtime.uninstall'), params: RuntimeUninstallRequestSchema }).strict();
export const WorkerNginxVersionsRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('nginx.versions'), params: NginxModuleRequestSchema }).strict();
export const WorkerNginxInstallRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('nginx.install'), params: NginxInstallRequestSchema }).strict();
export const WorkerNginxStatusRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('nginx.status'), params: NginxModuleRequestSchema }).strict();
export const WorkerNginxListRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('nginx.list'), params: NginxModuleRequestSchema }).strict();
export const WorkerNginxUninstallRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('nginx.uninstall'), params: NginxUninstallRequestSchema }).strict();
export const WorkerNginxLifecycleRequestSchema = z
  .object({ ...EnvelopeBase, method: z.enum(['nginx.start', 'nginx.stop', 'nginx.reload']), params: NginxLifecycleRequestSchema })
  .strict();
export const WorkerNginxLogsRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('nginx.logs'), params: NginxLogsRequestSchema }).strict();
export const WorkerNginxConfigRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('nginx.config'), params: NginxConfigRequestSchema }).strict();
export const WorkerRedisVersionsRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('redis.versions'), params: RedisModuleRequestSchema }).strict();
export const WorkerRedisInstallRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('redis.install'), params: RedisInstallRequestSchema }).strict();
export const WorkerRedisStatusRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('redis.status'), params: RedisModuleRequestSchema }).strict();
export const WorkerRedisListRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('redis.list'), params: RedisModuleRequestSchema }).strict();
export const WorkerRedisUninstallRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('redis.uninstall'), params: RedisUninstallRequestSchema }).strict();
export const WorkerRedisLifecycleRequestSchema = z
  .object({ ...EnvelopeBase, method: z.enum(['redis.start', 'redis.stop']), params: RedisLifecycleRequestSchema })
  .strict();
export const WorkerRedisLogsRequestSchema = z.object({ ...EnvelopeBase, method: z.literal('redis.logs'), params: RedisLogsRequestSchema }).strict();

/** Discriminated by `method`: unknown methods and unknown fields are rejected before dispatch. */
export const WorkerManagementRequestSchema = z.discriminatedUnion('method', [
  WorkerHealthRequestSchema,
  WorkerInstallRequestSchema,
  WorkerServiceRequestSchema,
  WorkerServiceStatusRequestSchema,
  WorkerServicesListRequestSchema,
  WorkerInstallationsListRequestSchema,
  WorkerLogsTailRequestSchema,
  WorkerConfigReadRequestSchema,
  WorkerCertificateStatusRequestSchema,
  WorkerCertificateTrustRequestSchema,
  WorkerSitesApplyRequestSchema,
  WorkerSitesListRequestSchema,
  WorkerSitesRemoveRequestSchema,
  WorkerRuntimeVersionsRequestSchema,
  WorkerRuntimeInstallRequestSchema,
  WorkerRuntimeStatusRequestSchema,
  WorkerRuntimeListRequestSchema,
  WorkerRuntimeUninstallRequestSchema,
  WorkerNginxVersionsRequestSchema,
  WorkerNginxInstallRequestSchema,
  WorkerNginxStatusRequestSchema,
  WorkerNginxListRequestSchema,
  WorkerNginxUninstallRequestSchema,
  WorkerNginxLifecycleRequestSchema,
  WorkerNginxLogsRequestSchema,
  WorkerNginxConfigRequestSchema,
  WorkerRedisVersionsRequestSchema,
  WorkerRedisInstallRequestSchema,
  WorkerRedisStatusRequestSchema,
  WorkerRedisListRequestSchema,
  WorkerRedisUninstallRequestSchema,
  WorkerRedisLifecycleRequestSchema,
  WorkerRedisLogsRequestSchema
]);
export type WorkerManagementRequest = z.infer<typeof WorkerManagementRequestSchema>;

/** One response frame per accepted request; streamed progress precedes exactly one terminal frame. */
export const WorkerResultResponseSchema = z
  .object({ ...EnvelopeBase, status: z.literal('result'), result: WorkerMethodResultSchema })
  .strict();
export const WorkerErrorResponseSchema = z.object({ ...EnvelopeBase, status: z.literal('error'), error: ErrorSchema }).strict();
export const WorkerProgressResponseSchema = z
  .object({ ...EnvelopeBase, status: z.literal('progress'), event: OperationEventSchema })
  .strict()
  .refine(v => v.event.type === 'progress', 'Only progress events may be streamed before the terminal frame');
export const WorkerManagementResponseSchema = z.discriminatedUnion('status', [
  WorkerResultResponseSchema,
  WorkerErrorResponseSchema,
  WorkerProgressResponseSchema
]);
export type WorkerManagementResponse = z.infer<typeof WorkerManagementResponseSchema>;

export const EVENT_CHANNEL = 'stackmanage:v1:operation-event' as const;
export const SerializedOperationEventSchema = z
  .object({
    apiVersion: z.literal(1),
    operationId: OperationRequestIdSchema,
    sequence: z.number().int().nonnegative(),
    event: OperationEventSchema
  })
  .strict();
export type SerializedOperationEvent = z.infer<typeof SerializedOperationEventSchema>;

/** Operational bounds for long-running operations; reads keep the v1 5s deadline. */
export const OPERATION_TIMEOUTS = Object.freeze({
  install: 15 * 60 * 1000,
  runtimeInstall: 15 * 60 * 1000,
  service: 60 * 1000,
  sites: 30 * 1000,
  read: 5000
} as const);

export const ServiceStateViewSchema = ServiceStateSchema;
export type ServiceStateView = z.infer<typeof ServiceStateSchema>;
