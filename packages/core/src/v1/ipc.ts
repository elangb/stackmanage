import { z } from 'zod';
import { DEFAULT_LIMITS, ErrorSchema, IdSchema, LimitsSchema, ServiceStateSchema } from './contracts';
import { InstallationListViewSchema, LogTailViewSchema, ServiceListViewSchema, SiteListViewSchema } from './operations';

/*
 * Additive v1 extension (Phase 1) — main IPC surface.
 *
 * The Phase 0 wire shapes are unchanged: `IPC_CHANNEL`, `SnapshotRequestSchema`,
 * `WorkerRequestSchema`/`WorkerResponseSchema` and every documented snapshot field keep
 * their exact meaning. Phase 1 only adds schemas. `implementedFeatures` is widened from a
 * one-element tuple to a bounded array so later phases can report features while a Phase
 * 0 payload (`['bootstrap']`) still parses; both are JSON arrays on the wire.
 */

export const IPC_CHANNEL = 'stackmanage:v1:snapshot';
export const SnapshotRequestSchema = z.object({ apiVersion: z.literal(1) }).strict();

/** Phase 0 fork `health` exchange. Unchanged. */
export const WorkerRequestSchema = z.object({ apiVersion: z.literal(1), id: IdSchema, method: z.literal('health') }).strict();
export const WorkerResponseSchema = z.object({ apiVersion: z.literal(1), id: IdSchema, status: z.literal('ready'), pid: z.number().int().positive() }).strict();
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;

/** Phase 1 features. Phase 0 reported only `bootstrap`. */
export const FeatureSchema = z.enum(['bootstrap', 'services.install', 'services.lifecycle', 'sites', 'logs', 'config', 'runtimes', 'databases']);
export type Feature = z.infer<typeof FeatureSchema>;

export const SnapshotSchema = z.object({
  apiVersion: z.literal(1), appVersion: z.string().min(1), worker: z.literal('ready'),
  implementedFeatures: z.array(FeatureSchema).min(1).max(32), limits: LimitsSchema,
  /** Additive Phase 1 facts; older Phase 0 payloads remain valid without them. */
  platform: z.enum(['win32', 'linux', 'darwin']).optional(),
  architecture: z.enum(['x64', 'arm64']).optional(),
  /** Managed directory for local site document roots. Never a write token. */
  sitesRoot: z.string().min(1).max(4096).optional()
}).strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const SnapshotResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: SnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: ErrorSchema }).strict()
]);
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;

export interface DesktopBridge { snapshot(): Promise<SnapshotResponse> }
/** Additive Phase 1 superset; defined in `v1/bridge.ts`. Re-exported for convenience. */
export type { DesktopBridgeV1 } from './bridge';

/** Pinned vendor identity of the only installation this phase manages. */
export const CADDY_MODULE_ID = 'caddy' as const;
export const CADDY_VERSION = '2.11.8' as const;
export const CADDY_INSTALLATION_ID = 'caddy-2.11.8' as const;
export const CADDY_INSTANCE_ID = 'default' as const;
export const CADDY_DEFAULT_PORT = 18080 as const;

/**
 * Main-process channels. Every name is explicit; there is no generic invoke channel.
 * Operation channels take the request schema from `bridge.ts` and answer with
 * `BridgeResponseSchema`; read channels answer with the `apiResponse(..)` envelopes below.
 */
export const IPC_CHANNELS = Object.freeze({
  install: 'stackmanage:v1:services.install',
  start: 'stackmanage:v1:services.start',
  stop: 'stackmanage:v1:services.stop',
  restart: 'stackmanage:v1:services.restart',
  status: 'stackmanage:v1:services.status',
  listServices: 'stackmanage:v1:services.list',
  listInstallations: 'stackmanage:v1:installations.list',
  sitesList: 'stackmanage:v1:sites.list',
  sitesApply: 'stackmanage:v1:sites.apply',
  sitesRemove: 'stackmanage:v1:sites.remove',
  certificateStatus: 'stackmanage:v1:certificates.status',
  trustCertificate: 'stackmanage:v1:certificates.trust',
  logsTail: 'stackmanage:v1:logs.tail',
  /** Main → renderer only. */
  operationEvent: 'stackmanage:v1:operation.event'
} as const);

export const LogTailSchema = LogTailViewSchema;
export type LogTail = z.infer<typeof LogTailSchema>;

/** Consistent success/error envelope; never leaks internal error objects. */
export function apiResponse<T>(data: z.ZodType<T>) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }).strict(),
    z.object({ ok: z.literal(false), error: ErrorSchema }).strict()
  ]);
}
export const StatusIpcResponseSchema = apiResponse(ServiceStateSchema);
export const ServicesIpcResponseSchema = apiResponse(ServiceListViewSchema);
export const InstallationsIpcResponseSchema = apiResponse(InstallationListViewSchema);
export const SitesIpcResponseSchema = apiResponse(SiteListViewSchema);
export const LogTailIpcResponseSchema = apiResponse(LogTailSchema);

export type StatusIpcData = z.infer<typeof ServiceStateSchema>;
export type ServicesIpcData = z.infer<typeof ServiceListViewSchema>;
export type InstallationsIpcData = z.infer<typeof InstallationListViewSchema>;
export type SitesIpcData = z.infer<typeof SiteListViewSchema>;
export type LogTailData = z.infer<typeof LogTailSchema>;

/** Terminal result or typed transport failure for one renderer call. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: z.infer<typeof ErrorSchema> };

/** Reject before dispatch; JSON is the only wire format. Works in sandboxed preload too. */
export function parseBounded<T>(schema: z.ZodType<T>, input: unknown): T {
  const serialized = safeSerialize(input);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > DEFAULT_LIMITS.maxIpcBytes) throw new Error('INVALID_REQUEST');
  return schema.parse(input);
}

/** JSON serialization that rejects cycles and non-wire values instead of throwing raw errors. */
export function safeSerialize(input: unknown): string | undefined {
  try {
    return JSON.stringify(input, (_key, value: unknown) => {
      if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value instanceof Map || value instanceof Set) throw new Error('INVALID_REQUEST');
      return value;
    });
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}

/** Exact top-level document only, never URL prefix matching or child frames. */
export function isTrustedSender(sender: { url: string; isMainFrame: boolean }, expectedUrl: string): boolean {
  return sender.isMainFrame && sender.url === expectedUrl;
}
