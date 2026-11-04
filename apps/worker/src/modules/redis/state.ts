import { z } from 'zod';
import { IdSchema } from '@stackmanage/core';
import { REDIS_MODULE_ID, REDIS_VERSION, RedisTargetSchema } from './manifest';

/**
 * Module-scoped persisted records. A corrupt record is treated as absent and the
 * owning module reconciles against the filesystem/process table; it is never
 * trusted as proof that a binary or process still exists.
 */
export const RedisInstallationRecordSchema = z
  .object({
    id: IdSchema,
    moduleId: z.literal(REDIS_MODULE_ID),
    version: z.literal(REDIS_VERSION),
    target: RedisTargetSchema,
    directory: z.string().min(1).max(4096),
    serverPath: z.string().min(1).max(4096),
    cliPath: z.string().min(1).max(4096),
    archivePath: z.string().min(1).max(4096),
    source: z.url().refine(value => new URL(value).protocol === 'https:', 'HTTPS required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    installedAt: z.iso.datetime(),
    versionOutput: z.string().min(1).max(200),
    cliVersionOutput: z.string().min(1).max(200)
  })
  .strict();
export type RedisInstallationRecord = z.infer<typeof RedisInstallationRecordSchema>;

export const RedisInstallationsRecordSchema = z
  .object({ installations: z.array(RedisInstallationRecordSchema).max(4) })
  .strict();
export type RedisInstallationsRecord = z.infer<typeof RedisInstallationsRecordSchema>;

export const RedisProcessRecordSchema = z
  .object({
    instanceId: IdSchema,
    pid: z.number().int().positive(),
    executable: z.string().min(1).max(4096),
    startToken: z.string().min(1).max(128),
    procToken: z.string().min(16).max(128),
    port: z.number().int().min(1).max(65535),
    configPath: z.string().min(1).max(4096),
    dataDir: z.string().min(1).max(4096),
    logPath: z.string().min(1).max(4096),
    pidFile: z.string().min(1).max(4096),
    startedAt: z.iso.datetime()
  })
  .strict();
export type RedisProcessRecord = z.infer<typeof RedisProcessRecordSchema>;

export const RedisServiceRecordSchema = z
  .object({
    instanceId: IdSchema,
    status: z.enum(['running', 'stopped', 'unknown']),
    process: RedisProcessRecordSchema.optional(),
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
export type RedisServiceRecord = z.infer<typeof RedisServiceRecordSchema>;

export const REDIS_STORAGE_KEYS = Object.freeze({
  installations: 'installations',
  service: (instanceId: string) => `service-${instanceId}`
});
