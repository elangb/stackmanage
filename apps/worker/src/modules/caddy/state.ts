import { z } from 'zod';
import { IdSchema, InstallationSchema, ServiceRefSchema, SiteSchema } from '@stackmanage/core';
import { CADDY_MODULE_ID, CADDY_VERSION, CaddyTargetSchema } from './manifest';
export { CADDY_MODULE_ID } from './manifest';

/**
 * Module-scoped persisted records (never `config.setup`). Every record is
 * schema-validated on read and write; a corrupt record is treated as missing and
 * reconciled against the real filesystem/process table by the owning module.
 */
export const CaddyInstallationRecordSchema = z
  .object({
    installation: InstallationSchema,
    target: CaddyTargetSchema,
    binaryPath: z.string().min(1).max(4096),
    archivePath: z.string().min(1).max(4096),
    installedAt: z.iso.datetime(),
    versionOutput: z.string().min(1).max(200)
  })
  .strict()
  .refine(v => v.installation.version.moduleId === CADDY_MODULE_ID && v.installation.version.version === CADDY_VERSION, 'Only the pinned Caddy release');
export type CaddyInstallationRecord = z.infer<typeof CaddyInstallationRecordSchema>;

export const CaddyProcessRecordSchema = z
  .object({
    instanceId: IdSchema,
    ref: ServiceRefSchema,
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
export type CaddyProcessRecord = z.infer<typeof CaddyProcessRecordSchema>;

export const CaddyServiceRecordSchema = z
  .object({
    instanceId: IdSchema,
    status: z.enum(['running', 'stopped', 'unknown']),
    process: CaddyProcessRecordSchema.optional(),
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
export type CaddyServiceRecord = z.infer<typeof CaddyServiceRecordSchema>;

export const CaddySiteRecordSchema = z.object({ sites: z.array(SiteSchema).max(100) }).strict();
export type CaddySiteRecord = z.infer<typeof CaddySiteRecordSchema>;

export const STORAGE_KEYS = Object.freeze({
  installation: 'installation',
  service: (instanceId: string) => `service-${instanceId}`,
  sites: 'sites'
});
