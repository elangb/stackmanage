import { z } from 'zod';
import { DEFAULT_LIMITS, ErrorSchema, IdSchema } from './contracts';
import { safeSerialize } from './ipc';
import {
  InstallRequestSchema,
  InstanceRequestSchema,
  LogTailRequestSchema,
  ServiceRequestSchema,
  SiteRemoveRequestSchema,
  SitesApplyRequestSchema,
  WorkerResultResponseSchema
} from './operations';

/**
 * Additive Phase 1 bridge extension.
 *
 * The Phase 0 `DesktopBridge`/`snapshot()` contract is unchanged and stays a valid subset
 * of `DesktopBridgeV1`. Every new method is a named, schema-validated operation: no
 * generic `invoke`, transport object, filesystem path, shell or process handle crosses
 * this boundary. Every call returns exactly one terminal response.
 */
export const DESKTOP_METHODS = Object.freeze({
  install: 'stackmanage:v1:install',
  start: 'stackmanage:v1:service-start',
  stop: 'stackmanage:v1:service-stop',
  restart: 'stackmanage:v1:service-restart',
  status: 'stackmanage:v1:service-status',
  listServices: 'stackmanage:v1:services-list',
  listInstallations: 'stackmanage:v1:installations-list',
  logsTail: 'stackmanage:v1:logs-tail',
  sitesApply: 'stackmanage:v1:sites-apply',
  sitesList: 'stackmanage:v1:sites-list',
  sitesRemove: 'stackmanage:v1:sites-remove'
} as const);

export type DesktopMethodName = keyof typeof DESKTOP_METHODS;
export const DesktopMethodNameSchema = z.enum([
  'install', 'start', 'stop', 'restart', 'status', 'listServices', 'listInstallations', 'logsTail', 'sitesApply', 'sitesList', 'sitesRemove'
]);

export const BridgeOkResponseSchema = z.object({ ok: z.literal(true), data: WorkerResultResponseSchema.shape.result }).strict();
/** Transport-level failure only. An accepted operation reports failure through its terminal result. */
export const BridgeResponseSchema = z.discriminatedUnion('ok', [
  BridgeOkResponseSchema,
  z.object({ ok: z.literal(false), error: ErrorSchema }).strict()
]);
export type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

/** Request schemas keyed by bridge method; preload and main validate the very same payload. */
export const BRIDGE_REQUEST_SCHEMAS = Object.freeze({
  install: InstallRequestSchema,
  start: ServiceRequestSchema,
  stop: ServiceRequestSchema,
  restart: ServiceRequestSchema,
  status: InstanceRequestSchema,
  listServices: z.object({}).strict(),
  listInstallations: z.object({}).strict(),
  logsTail: LogTailRequestSchema,
  sitesApply: SitesApplyRequestSchema,
  sitesList: z.object({}).strict(),
  sitesRemove: SiteRemoveRequestSchema
});
export type BridgeRequestFor<M extends DesktopMethodName> = z.infer<(typeof BRIDGE_REQUEST_SCHEMAS)[M]>;
export type BridgeResultData = z.infer<typeof WorkerResultResponseSchema>['result'];

/** Single parse point shared by preload and main so both sides enforce one wire contract. */
export function parseBridgeRequest<M extends DesktopMethodName>(method: M, input: unknown): BridgeRequestFor<M> {
  return BRIDGE_REQUEST_SCHEMAS[method].parse(input) as BridgeRequestFor<M>;
}

/** Bound + parse in one step: rejects cycles, oversized payloads and non-wire values before dispatch. */
export function parseBoundedBridgeRequest<M extends DesktopMethodName>(method: M, input: unknown, maxBytes = DEFAULT_LIMITS.maxIpcBytes): BridgeRequestFor<M> {
  const serialized = safeSerialize(input);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maxBytes) throw new Error('INVALID_REQUEST');
  return parseBridgeRequest(method, input);
}

/**
 * Renderer-side progress notification. Only monotonic counters travel to the renderer:
 * the stage text and terminal result come from the awaited call, so an untrusted event
 * cannot inject copy or complete an operation.
 */
export const BridgeEventPayloadSchema = z.object({
  operationId: IdSchema,
  sequence: z.number().int().nonnegative(),
  stageKey: IdSchema.optional(),
  fraction: z.number().min(0).max(1).optional()
}).strict();
export type BridgeEventPayload = z.infer<typeof BridgeEventPayloadSchema>;

export interface EventSubscriptionHandle { unsubscribe(): void }

/** Frozen v1 bridge plus additive Phase 1 methods. */
export interface DesktopBridgeV1 {
  snapshot(): Promise<import('./ipc').SnapshotResponse>;
  install(request: BridgeRequestFor<'install'>): Promise<BridgeResponse>;
  start(request: BridgeRequestFor<'start'>): Promise<BridgeResponse>;
  stop(request: BridgeRequestFor<'stop'>): Promise<BridgeResponse>;
  restart(request: BridgeRequestFor<'restart'>): Promise<BridgeResponse>;
  status(request: BridgeRequestFor<'status'>): Promise<BridgeResponse>;
  listServices(request: BridgeRequestFor<'listServices'>): Promise<BridgeResponse>;
  listInstallations(request: BridgeRequestFor<'listInstallations'>): Promise<BridgeResponse>;
  logsTail(request: BridgeRequestFor<'logsTail'>): Promise<BridgeResponse>;
  sitesApply(request: BridgeRequestFor<'sitesApply'>): Promise<BridgeResponse>;
  sitesList(request: BridgeRequestFor<'sitesList'>): Promise<BridgeResponse>;
  sitesRemove(request: BridgeRequestFor<'sitesRemove'>): Promise<BridgeResponse>;
  /** Progress for one operation; the caller filters stale sequences and mismatched operation IDs. */
  onOperationEvent(listener: (payload: BridgeEventPayload) => void): EventSubscriptionHandle;
}
