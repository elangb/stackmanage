import { z } from 'zod';
import { IdSchema } from '@stackmanage/core';
import { NGINX_MODULE_ID, NGINX_VERSION, NginxTargetSchema } from './manifest';

/**
 * Module-scoped persisted records. A corrupt record is treated as absent and the
 * owning module reconciles against the filesystem/process table; it is never
 * trusted as proof that a binary or process still exists.
 */
export const NginxInstallationRecordSchema = z
  .object({
    id: IdSchema,
    moduleId: z.literal(NGINX_MODULE_ID),
    version: z.literal(NGINX_VERSION),
    target: NginxTargetSchema,
    directory: z.string().min(1).max(4096),
    binaryPath: z.string().min(1).max(4096),
    archivePath: z.string().min(1).max(4096),
    source: z.url().refine(value => new URL(value).protocol === 'https:', 'HTTPS required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    installedAt: z.iso.datetime(),
    versionOutput: z.string().min(1).max(200)
  })
  .strict();
export type NginxInstallationRecord = z.infer<typeof NginxInstallationRecordSchema>;

export const NginxInstallationsRecordSchema = z
  .object({ installations: z.array(NginxInstallationRecordSchema).max(4) })
  .strict();
export type NginxInstallationsRecord = z.infer<typeof NginxInstallationsRecordSchema>;

export const NginxProcessRecordSchema = z
  .object({
    instanceId: IdSchema,
    pid: z.number().int().positive(),
    executable: z.string().min(1).max(4096),
    startToken: z.string().min(1).max(128),
    procToken: z.string().min(16).max(128),
    port: z.number().int().min(1).max(65535),
    configPath: z.string().min(1).max(4096),
    logPath: z.string().min(1).max(4096),
    startedAt: z.iso.datetime()
  })
  .strict();
export type NginxProcessRecord = z.infer<typeof NginxProcessRecordSchema>;

export const NginxServiceRecordSchema = z
  .object({
    instanceId: IdSchema,
    status: z.enum(['running', 'stopped', 'unknown']),
    process: NginxProcessRecordSchema.optional(),
    /** Set when a previous PID could not be verified. Never cleared by a kill. */
    unverified: z
      .object({
        pid: z.number().int().positive(),
        observedAt: z.iso.datetime(),
        reason: z.enum(['executable', 'start-token', 'proc-token', 'unverifiable'])
      })
      .strict()
      .optional()
  })
  .strict();
export type NginxServiceRecord = z.infer<typeof NginxServiceRecordSchema>;

export const NGINX_STORAGE_KEYS = Object.freeze({
  installations: 'installations',
  service: (instanceId: string) => `service-${instanceId}`
});
