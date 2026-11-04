import { join, resolve } from 'node:path';
import { z } from 'zod';
import { IdSchema, InstallationSchema, ServiceRefSchema, SiteSchema } from '@stackmanage/core';
import { listDirectoryWithin, ReadFailure, readHeadWithin } from './read.js';
import type { DataRoots } from './roots.js';
import { isPathInside } from './roots.js';

const MAX_RECORD_BYTES = 512 * 1024;
const MAX_SERVICE_FILES = 10;
const MAX_DIRECTORY_ENTRIES = 256;
const SERVICE_FILE = /^service-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/;

const ProcessBaseSchema = z
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

const UnverifiedSchema = z
  .object({
    pid: z.number().int().positive(),
    observedAt: z.iso.datetime(),
    reason: z.enum(['executable', 'start-token', 'proc-token', 'unverifiable'])
  })
  .strict();

export const CaddyInstallationRecordSchema = z
  .object({
    installation: InstallationSchema,
    target: z.string().min(1).max(64),
    binaryPath: z.string().min(1).max(4096),
    archivePath: z.string().min(1).max(4096),
    installedAt: z.iso.datetime(),
    versionOutput: z.string().min(1).max(200)
  })
  .strict();

export const CaddyServiceRecordSchema = z
  .object({
    instanceId: IdSchema,
    status: z.enum(['running', 'stopped', 'unknown']),
    process: ProcessBaseSchema.extend({ ref: ServiceRefSchema }).strict().optional(),
    unverified: UnverifiedSchema.optional()
  })
  .strict();

export const NginxInstallationRecordSchema = z
  .object({
    id: IdSchema,
    moduleId: z.literal('nginx'),
    version: z.string().min(1).max(100),
    target: z.string().min(1).max(64),
    directory: z.string().min(1).max(4096),
    binaryPath: z.string().min(1).max(4096),
    archivePath: z.string().min(1).max(4096),
    source: z.url().refine(value => new URL(value).protocol === 'https:', 'HTTPS required'),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    installedAt: z.iso.datetime(),
    versionOutput: z.string().min(1).max(200)
  })
  .strict();

export const NginxInstallationsRecordSchema = z
  .object({ installations: z.array(NginxInstallationRecordSchema).max(4) })
  .strict();

export const NginxServiceRecordSchema = z
  .object({
    instanceId: IdSchema,
    status: z.enum(['running', 'stopped', 'unknown']),
    process: ProcessBaseSchema.optional(),
    unverified: UnverifiedSchema.optional()
  })
  .strict();

export const NodeInstallationRecordSchema = z
  .object({
    id: IdSchema,
    moduleId: z.literal('node'),
    version: z.string().min(1).max(100),
    target: z.string().min(1).max(64),
    directory: z.string().min(1).max(4096),
    binaryPath: z.string().min(1).max(4096),
    archivePath: z.string().min(1).max(4096),
    installedAt: z.iso.datetime(),
    versionOutput: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export const NodeInstallationsRecordSchema = z
  .object({ installations: z.array(NodeInstallationRecordSchema).max(10) })
  .strict();

export const SitesRecordSchema = z.object({ sites: z.array(SiteSchema).max(100) }).strict();

export type CaddyInstallationRecord = z.infer<typeof CaddyInstallationRecordSchema>;
export type CaddyServiceRecord = z.infer<typeof CaddyServiceRecordSchema>;
export type NginxInstallationRecord = z.infer<typeof NginxInstallationRecordSchema>;
export type NginxServiceRecord = z.infer<typeof NginxServiceRecordSchema>;
export type NodeInstallationRecord = z.infer<typeof NodeInstallationRecordSchema>;

export interface PersistedProcess {
  readonly instanceId: string;
  readonly pid: number;
  readonly executable: string;
  readonly startToken: string;
  readonly procToken: string;
  readonly port: number;
  readonly configPath: string;
  readonly logPath: string;
  readonly startedAt: string;
}

export interface PersistedServiceRecord {
  readonly instanceId: string;
  readonly status: 'running' | 'stopped' | 'unknown';
  readonly process?: PersistedProcess;
  readonly unverified?: { readonly pid: number; readonly observedAt: string; readonly reason: 'executable' | 'start-token' | 'proc-token' | 'unverifiable' };
}

export type RecordRead<T> = { readonly state: 'present'; readonly value: T } | { readonly state: 'absent' } | { readonly state: 'unknown'; readonly reason: string };

export interface Warning {
  readonly code: string;
  readonly message: string;
}

function statePath(moduleId: string, key: string): string {
  return join('state', moduleId, `${key}.json`);
}

async function readJsonWithin<T>(roots: DataRoots, relativePath: string, schema: z.ZodType<T>): Promise<RecordRead<T>> {
  let text;
  try {
    text = await readHeadWithin(roots.dataRoot, relativePath, MAX_RECORD_BYTES);
  } catch (error) {
    if (error instanceof ReadFailure) return { state: 'unknown', reason: error.code === 'PATH_REJECTED' ? 'unsafe-path' : 'unreadable' };
    return { state: 'unknown', reason: 'unreadable' };
  }
  if (text.state === 'absent') return { state: 'absent' };
  if (text.truncated) return { state: 'unknown', reason: 'oversized' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.text);
  } catch {
    return { state: 'unknown', reason: 'corrupt-json' };
  }
  const result = schema.safeParse(parsed);
  return result.success ? { state: 'present', value: result.data } : { state: 'unknown', reason: 'schema-mismatch' };
}

export function readCaddyInstallation(roots: DataRoots): Promise<RecordRead<CaddyInstallationRecord>> {
  return readJsonWithin(roots, statePath('caddy', 'installation'), CaddyInstallationRecordSchema);
}

export function readNginxInstallations(roots: DataRoots): Promise<RecordRead<z.infer<typeof NginxInstallationsRecordSchema>>> {
  return readJsonWithin(roots, statePath('nginx', 'installations'), NginxInstallationsRecordSchema);
}

export function readNodeInstallations(roots: DataRoots): Promise<RecordRead<z.infer<typeof NodeInstallationsRecordSchema>>> {
  return readJsonWithin(roots, statePath('node', 'installations'), NodeInstallationsRecordSchema);
}

export function readCaddySites(roots: DataRoots): Promise<RecordRead<z.infer<typeof SitesRecordSchema>>> {
  return readJsonWithin(roots, statePath('caddy', 'sites'), SitesRecordSchema);
}

function normalizeCaddy(record: CaddyServiceRecord): PersistedServiceRecord {
  const process = record.process;
  const normalized =
    process === undefined
      ? undefined
      : {
          instanceId: process.instanceId,
          pid: process.pid,
          executable: process.executable,
          startToken: process.startToken,
          procToken: process.procToken,
          port: process.port,
          configPath: process.configPath,
          logPath: process.logPath,
          startedAt: process.startedAt
        };
  return {
    instanceId: record.instanceId,
    status: record.status,
    ...(normalized !== undefined ? { process: normalized } : {}),
    ...(record.unverified !== undefined ? { unverified: record.unverified } : {})
  };
}

function normalizeNginx(record: NginxServiceRecord): PersistedServiceRecord {
  return {
    instanceId: record.instanceId,
    status: record.status,
    ...(record.process !== undefined ? { process: record.process } : {}),
    ...(record.unverified !== undefined ? { unverified: record.unverified } : {})
  };
}

export interface ServiceRecordEntry {
  readonly instanceId: string;
  readonly state: 'present' | 'unknown';
  readonly record?: PersistedServiceRecord;
  readonly warning?: Warning;
}

export interface ServiceRecordListing {
  readonly state: 'absent' | 'present' | 'unknown';
  readonly entries: readonly ServiceRecordEntry[];
  readonly warnings: readonly Warning[];
}

export async function readServiceRecords(roots: DataRoots, moduleId: 'caddy' | 'nginx'): Promise<ServiceRecordListing> {
  let listing;
  try {
    listing = await listDirectoryWithin(roots.dataRoot, join('state', moduleId), MAX_DIRECTORY_ENTRIES);
  } catch (error) {
    if (error instanceof ReadFailure) {
      return { state: 'unknown', entries: [], warnings: [{ code: 'STATE_UNREADABLE', message: 'Service state directory could not be read.' }] };
    }
    return { state: 'unknown', entries: [], warnings: [{ code: 'STATE_UNREADABLE', message: 'Service state directory could not be read.' }] };
  }
  if (listing.state === 'absent') return { state: 'absent', entries: [], warnings: [] };
  const matching = listing.names.filter(name => SERVICE_FILE.test(name));
  const overflow = matching.length > MAX_SERVICE_FILES;
  const warnings: Warning[] = overflow ? [{ code: 'TOO_MANY_RECORDS', message: `Only the first ${MAX_SERVICE_FILES} service records were read.` }] : [];
  const entries: ServiceRecordEntry[] = [];
  for (const name of matching.slice(0, MAX_SERVICE_FILES)) {
    const match = SERVICE_FILE.exec(name);
    const instanceId = match?.[1] ?? 'unknown';
    const read =
      moduleId === 'caddy'
        ? await readJsonWithin(roots, join('state', 'caddy', name), CaddyServiceRecordSchema)
        : await readJsonWithin(roots, join('state', 'nginx', name), NginxServiceRecordSchema);
    if (read.state === 'present') {
      const record = moduleId === 'caddy' ? normalizeCaddy(read.value as CaddyServiceRecord) : normalizeNginx(read.value as NginxServiceRecord);
      entries.push({ instanceId: record.instanceId, state: 'present', record });
    } else if (read.state === 'unknown') {
      entries.push({
        instanceId,
        state: 'unknown',
        warning: { code: 'STATE_UNREADABLE', message: `Record ${name} is ${read.reason}; no running state is claimed.` }
      });
    }
  }
  return { state: 'present', entries, warnings };
}

/** Absolute path only when it is lexically inside the owning module root. */
export function confinedPath(root: string, value: string): string | null {
  return isPathInside(root, value) ? resolve(value) : null;
}
