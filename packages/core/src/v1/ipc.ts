import { z } from 'zod';
import { DEFAULT_LIMITS, ErrorSchema, IdSchema, LimitsSchema } from './contracts';

export const IPC_CHANNEL = 'stackmanage:v1:snapshot';
export const SnapshotRequestSchema = z.object({ apiVersion: z.literal(1) }).strict();
export const WorkerRequestSchema = z.object({ apiVersion: z.literal(1), id: IdSchema, method: z.literal('health') }).strict();
export const WorkerResponseSchema = z.object({ apiVersion: z.literal(1), id: IdSchema, status: z.literal('ready'), pid: z.number().int().positive() }).strict();
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;
export const SnapshotSchema = z.object({
  apiVersion: z.literal(1), appVersion: z.string().min(1), worker: z.literal('ready'),
  implementedFeatures: z.tuple([z.literal('bootstrap')]), limits: LimitsSchema
}).strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const SnapshotResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: SnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: ErrorSchema }).strict()
]);
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
export interface DesktopBridge { snapshot(): Promise<SnapshotResponse> }

/** Reject before dispatch; JSON is the only wire format. Works in sandboxed preload too. */
export function parseBounded<T>(schema: z.ZodType<T>, input: unknown): T {
  const serialized = JSON.stringify(input);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > DEFAULT_LIMITS.maxIpcBytes) throw new Error('INVALID_REQUEST');
  return schema.parse(input);
}

/** Exact top-level document only, never URL prefix matching or child frames. */
export function isTrustedSender(sender: { url: string; isMainFrame: boolean }, expectedUrl: string): boolean {
  return sender.isMainFrame && sender.url === expectedUrl;
}
