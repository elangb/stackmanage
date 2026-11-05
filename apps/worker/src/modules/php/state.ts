import { z } from 'zod';
import { IdSchema } from '@stackmanage/core';
import { PHP_MODULE_ID, PHP_VERSION } from './manifest';

export const PhpInstallationRecordSchema = z
  .object({
    id: IdSchema,
    moduleId: z.literal(PHP_MODULE_ID),
    version: z.literal(PHP_VERSION),
    target: z.literal('linux-x64'),
    directory: z.string().min(1).max(4096),
    fpmPath: z.string().min(1).max(4096),
    cliPath: z.string().min(1).max(4096),
    versionOutput: z.string().min(1).max(200),
    installedAt: z.iso.datetime()
  })
  .strict();
export type PhpInstallationRecord = z.infer<typeof PhpInstallationRecordSchema>;

export const PhpInstallationsRecordSchema = z.object({ installations: z.array(PhpInstallationRecordSchema).max(4) }).strict();

export const PhpProcessRecordSchema = z
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
export type PhpProcessRecord = z.infer<typeof PhpProcessRecordSchema>;

export const PhpServiceRecordSchema = z
  .object({
    instanceId: IdSchema,
    status: z.enum(['running', 'stopped', 'unknown']),
    process: PhpProcessRecordSchema.optional(),
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
export type PhpServiceRecord = z.infer<typeof PhpServiceRecordSchema>;

export const PHP_STORAGE_KEYS = Object.freeze({
  installations: 'installations',
  service: (instanceId: string) => `service-${instanceId}`
});
