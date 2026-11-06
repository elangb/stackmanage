import { z } from 'zod';

/** v1 is frozen: incompatible changes require a new versioned contract. */
export const API_VERSION = 1 as const;
export const IdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const PlatformSchema = z.enum(['win32', 'linux', 'darwin']);
export const ArchitectureSchema = z.enum(['x64', 'arm64']);
export const CapabilitySchema = z.enum(['versions', 'install', 'service', 'config', 'logs', 'panel', 'project-env']);
export const AvailabilitySchema = z.object({
  platform: PlatformSchema,
  architecture: ArchitectureSchema,
  status: z.enum(['unverified', 'supported', 'unsupported']),
  evidence: z.url().optional(),
  reason: z.string().max(2000).optional()
}).strict().refine(v => v.status !== 'supported' || v.evidence !== undefined, 'Supported requires evidence');
export const ModuleDefinitionSchema = z.object({
  apiVersion: z.literal(1), id: IdSchema, nameKey: IdSchema,
  category: z.enum(['runtime', 'web', 'database', 'service', 'infrastructure', 'workflow', 'ai', 'plugin']),
  capabilities: z.array(CapabilitySchema).max(20),
  availability: z.array(AvailabilitySchema).max(6),
  dependencies: z.array(IdSchema).max(64)
}).strict();
export type ModuleDefinition = z.infer<typeof ModuleDefinitionSchema>;

export const ErrorSchema = z.object({
  code: z.enum(['INVALID_REQUEST', 'FORBIDDEN', 'NOT_IMPLEMENTED', 'UNAVAILABLE', 'TIMEOUT', 'CONFLICT', 'IO_ERROR', 'CANCELLED', 'UNKNOWN']),
  messageKey: IdSchema, retryable: z.boolean()
}).strict();
export type OperationError = z.infer<typeof ErrorSchema>;
export const ItemOutcomeSchema = z.object({
  id: IdSchema, status: z.enum(['completed', 'failed', 'skipped', 'unknown']),
  error: ErrorSchema.optional()
}).strict().refine(v => v.status === 'completed' || v.error !== undefined, 'Non-completed outcome requires a reason');
export const OperationResultSchema = z.object({
  operationId: IdSchema,
  status: z.enum(['completed', 'partial', 'failed', 'cancelled', 'unknown']),
  items: z.array(ItemOutcomeSchema), warnings: z.array(ErrorSchema)
}).strict().refine(v => v.status !== 'completed' || v.items.every(i => i.status === 'completed'), 'Completed cannot hide incomplete items');
export type OperationResult = z.infer<typeof OperationResultSchema>;
export const OperationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), operationId: IdSchema, sequence: z.number().int().nonnegative(), stageKey: IdSchema, fraction: z.number().min(0).max(1).optional() }).strict(),
  z.object({ type: z.literal('terminal'), result: OperationResultSchema }).strict()
]);
export type OperationEvent = z.infer<typeof OperationEventSchema>;
export interface OperationContext { readonly operationId: string; readonly signal: AbortSignal; emit(event: OperationEvent): void }

export const ServiceRefSchema = z.object({ moduleId: IdSchema, installationId: IdSchema, instanceId: IdSchema }).strict();
export type ServiceRef = z.infer<typeof ServiceRefSchema>;
export const ServiceStateSchema = z.object({
  ref: ServiceRefSchema, state: z.enum(['stopped', 'starting', 'running', 'stopping', 'failed', 'unknown']),
  pid: z.number().int().positive().optional(), ports: z.array(z.number().int().min(1).max(65535)), observedAt: z.iso.datetime()
}).strict();
export type ServiceState = z.infer<typeof ServiceStateSchema>;
export interface ServiceManager {
  inspect(ref: ServiceRef): Promise<ServiceState>;
  start(ref: ServiceRef, context: OperationContext): Promise<OperationResult>;
  stop(ref: ServiceRef, context: OperationContext): Promise<OperationResult>;
  restart(ref: ServiceRef, context: OperationContext): Promise<OperationResult>;
}

export const VersionRecordSchema = z.object({
  moduleId: IdSchema, version: z.string().min(1).max(100), platform: PlatformSchema, architecture: ArchitectureSchema,
  source: z.url().refine(v => new URL(v).protocol === 'https:', 'HTTPS required'), sha256: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type VersionRecord = z.infer<typeof VersionRecordSchema>;
export const InstallationSchema = z.object({ id: IdSchema, version: VersionRecordSchema, directory: z.string().min(1).max(4096) }).strict();
export type Installation = z.infer<typeof InstallationSchema>;
export interface VersionManager { available(moduleId: string, platform: z.infer<typeof PlatformSchema>, architecture: z.infer<typeof ArchitectureSchema>): Promise<VersionRecord[]>; installed(moduleId: string): Promise<Installation[]> }
export interface Installer { install(version: VersionRecord, context: OperationContext): Promise<OperationResult>; uninstall(installationId: string, context: OperationContext): Promise<OperationResult> }

export const HostnameSchema = z.string().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
export const SiteSchema = z.object({
  id: IdSchema, hostname: HostnameSchema, aliases: z.array(HostnameSchema).max(100),
  server: ServiceRefSchema, root: z.string().min(1).max(4096), port: z.number().int().min(1).max(65535),
  tls: z.boolean(), proxyTarget: z.url().refine(v => ['http:', 'https:'].includes(new URL(v).protocol)).optional(),
  /** Additive v1 field: execute PHP through the module-managed FastCGI endpoint. */
  php: z.boolean().optional()
}).strict();
export type Site = z.infer<typeof SiteSchema>;
export interface SiteManager { list(): Promise<Site[]>; apply(site: Site, context: OperationContext): Promise<OperationResult>; remove(id: string, context: OperationContext): Promise<OperationResult> }
export const HostsEntrySchema = z.object({ hostname: HostnameSchema, address: z.union([z.ipv4(), z.ipv6()]) }).strict();
export interface HostsManager { apply(entries: z.infer<typeof HostsEntrySchema>[], context: OperationContext): Promise<OperationResult> }
export const CertificateSchema = z.object({ id: IdSchema, hostnames: z.array(HostnameSchema).min(1).max(100), expiresAt: z.iso.datetime(), certificatePath: z.string().min(1), privateKeyPath: z.string().min(1) }).strict();
export interface CertManager { list(): Promise<z.infer<typeof CertificateSchema>[]>; issue(hostnames: string[], context: OperationContext): Promise<OperationResult>; trust(context: OperationContext): Promise<OperationResult> }

export const ProjectEnvSchema = z.object({
  id: IdSchema, directory: z.string().min(1).max(4096),
  runtimes: z.array(z.object({ moduleId: IdSchema, installationId: IdSchema }).strict()).max(64),
  variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(32768)),
  pathPrepend: z.array(z.string().min(1).max(4096)).max(64)
}).strict();
export type ProjectEnv = z.infer<typeof ProjectEnvSchema>;
export interface ProjectEnvManager { resolve(projectId: string): Promise<ProjectEnv>; save(env: ProjectEnv): Promise<void> }
export const StartupGroupSchema = z.object({
    id: IdSchema, name: z.string().trim().min(1).max(200),
  entries: z.array(z.object({ service: ServiceRefSchema, dependsOn: z.array(IdSchema), required: z.boolean() }).strict()).max(256),
  execution: z.literal('ordered'), onFailure: z.literal('skip-dependents')
}).strict().superRefine((group, ctx) => {
  const seen = new Set<string>();
  const serviceIds = new Set(group.entries.map(entry => entry.service.instanceId));
  for (const entry of group.entries) {
    if (seen.has(entry.service.instanceId) || entry.dependsOn.includes(entry.service.instanceId) || new Set(entry.dependsOn).size !== entry.dependsOn.length || entry.dependsOn.some(id => !serviceIds.has(id) || !seen.has(id))) ctx.addIssue({ code: 'custom', message: 'Entries must be unique and dependencies precede dependents' });
    seen.add(entry.service.instanceId);
  }
});
export type StartupGroup = z.infer<typeof StartupGroupSchema>;
export const StartupGroupListSchema = z.array(StartupGroupSchema).max(32);
export interface StartupGroupManager { run(group: StartupGroup, action: 'start' | 'stop', context: OperationContext): Promise<OperationResult> }
export const ScheduleSchema = z.object({
  id: IdSchema, cron: z.string().min(9).max(100).refine(v => v.trim().split(/\s+/).length === 5, 'Five fields required; scheduler must validate cron semantics'),
  timezone: z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }),
  groupId: IdSchema, enabled: z.boolean(), overlap: z.literal('skip'), missed: z.literal('skip')
}).strict();
export type Schedule = z.infer<typeof ScheduleSchema>;
export interface Scheduler { list(): Promise<Schedule[]>; save(schedule: Schedule): Promise<void>; remove(id: string): Promise<void> }

export const McpToolSchema = z.enum([
  'modules.list', 'versions.list', 'installations.list', 'installations.install', 'installations.remove',
  'services.list', 'services.inspect', 'services.start', 'services.stop', 'services.restart',
  'sites.list', 'sites.apply', 'sites.remove', 'hosts.apply', 'certificates.list', 'certificates.issue', 'certificates.trust',
  'projects.list', 'projects.resolve', 'projects.save', 'groups.list', 'groups.run', 'schedules.list', 'schedules.save', 'schedules.remove',
  'configs.read', 'configs.write', 'logs.read', 'operations.get', 'operations.cancel', 'plugins.list', 'plugins.install', 'plugins.remove',
  'terminal.open', 'shortcuts.run', 'system.info', 'screenshots.capture'
]);
export type McpTool = z.infer<typeof McpToolSchema>;
export const McpPermissionSchema = z.object({ principalId: IdSchema, tools: z.array(McpToolSchema), resources: z.array(IdSchema), expiresAt: z.iso.datetime() }).strict();
export type McpPermission = z.infer<typeof McpPermissionSchema>;
export interface McpAuthorizer { authorize(principalId: string, tool: McpTool, resourceId: string): Promise<boolean> }
export const PluginManifestSchema = z.object({
  apiVersion: z.literal(1), id: IdSchema, version: z.string().regex(/^\d+\.\d+\.\d+$/),
  entry: z.string().regex(/^[a-zA-Z0-9_-]+\.mjs$/), permissions: z.array(McpToolSchema), modules: z.array(ModuleDefinitionSchema).max(100)
}).strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export interface PluginHost { list(): Promise<PluginManifest[]>; enable(id: string, context: OperationContext): Promise<OperationResult>; disable(id: string, context: OperationContext): Promise<OperationResult> }

export const LimitsSchema = z.object({
  licensing: z.literal('unlimited'), telemetry: z.literal(false),
  maxIpcBytes: z.number().int().positive(), maxPendingRequests: z.number().int().positive(), requestTimeoutMs: z.number().int().positive(),
  maxConcurrentInstalls: z.number().int().positive(), maxLogBytes: z.number().int().positive()
}).strict();
export const DEFAULT_LIMITS = Object.freeze(LimitsSchema.parse({ licensing: 'unlimited', telemetry: false, maxIpcBytes: 65536, maxPendingRequests: 64, requestTimeoutMs: 5000, maxConcurrentInstalls: 2, maxLogBytes: 1048576 }));
export interface ModuleStorage { StorageGetAsync<T>(moduleId: string, key: string, schema: z.ZodType<T>): Promise<T | undefined>; StorageSetAsync<T>(moduleId: string, key: string, value: T, schema: z.ZodType<T>): Promise<void> }
