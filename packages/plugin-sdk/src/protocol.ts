import { z } from 'zod';
import { IdSchema } from '@stackmanage/core';

/**
 * Host ↔ plugin JSON-RPC 2.0 frames carried over the child process IPC channel.
 * Messages are JSON only, capped by the host, and never contain functions or host
 * object references. stdout/stderr are diagnostics, never protocol transport.
 */
export const PLUGIN_MAX_MESSAGE_BYTES = 65_536;

export const PLUGIN_PROBE_METHODS = Object.freeze(['plugin.ping', 'plugin.status'] as const);
export const PLUGIN_LIFECYCLE_METHODS = Object.freeze(['plugin.shutdown'] as const);
export const PLUGIN_REQUEST_METHODS = Object.freeze([...PLUGIN_PROBE_METHODS, ...PLUGIN_LIFECYCLE_METHODS] as const);
export type PluginProbeMethod = (typeof PLUGIN_PROBE_METHODS)[number];
export type PluginLifecycleMethod = (typeof PLUGIN_LIFECYCLE_METHODS)[number];
export type PluginRequestMethod = PluginProbeMethod | PluginLifecycleMethod;

export const PluginRpcIdSchema = z.union([z.string().min(1).max(64), z.number().int().nonnegative()]);
export type PluginRpcId = z.infer<typeof PluginRpcIdSchema>;

export const PluginRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: PluginRpcIdSchema,
    method: z.enum(PLUGIN_REQUEST_METHODS),
    params: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export type PluginRpcRequest = z.infer<typeof PluginRpcRequestSchema>;

export const PluginRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: PluginRpcIdSchema,
    result: z.unknown()
  })
  .strict();
export const PluginRpcFailureSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: PluginRpcIdSchema,
    error: z
      .object({
        code: z.number().int().min(-32_768).max(32_767),
        message: z.string().min(1).max(200)
      })
      .strict()
  })
  .strict();
export const PluginRpcResponseSchema = z.union([PluginRpcSuccessSchema, PluginRpcFailureSchema]);
export type PluginRpcResponse = z.infer<typeof PluginRpcResponseSchema>;

export const PluginReadyNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('plugin.ready'),
    params: z
      .object({
        pluginId: IdSchema,
        apiVersion: z.literal(1),
        pid: z.number().int().positive()
      })
      .strict()
  })
  .strict();
export type PluginReadyNotification = z.infer<typeof PluginReadyNotificationSchema>;

export const PluginFatalReasonSchema = z.enum(['activation-failed', 'uncaught', 'protocol', 'shutdown-failed']);
export type PluginFatalReason = z.infer<typeof PluginFatalReasonSchema>;

export const PluginFatalNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('plugin.fatal'),
    params: z.object({ reason: PluginFatalReasonSchema }).strict()
  })
  .strict();
export type PluginFatalNotification = z.infer<typeof PluginFatalNotificationSchema>;

export const PluginNotificationSchema = z.union([PluginReadyNotificationSchema, PluginFatalNotificationSchema]);
export type PluginNotification = z.infer<typeof PluginNotificationSchema>;

/** Immutable JSON context passed to `activate`; it intentionally contains no functions. */
export interface PluginActivationContext {
  readonly pluginId: string;
  readonly apiVersion: 1;
}

/** Optional exports a plugin entry may provide. Everything is optional in Phase 1. */
export interface PluginModule {
  activate?(context: PluginActivationContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  ping?(): unknown | Promise<unknown>;
  status?(): unknown | Promise<unknown>;
}
