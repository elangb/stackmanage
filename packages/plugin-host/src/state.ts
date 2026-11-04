import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { IdSchema } from '@stackmanage/core';
import { PluginManifestSchema, SemverSchema } from '@stackmanage/plugin-sdk';
import { PluginHostError } from './errors';
import { atomicWriteFile, pathExists } from './paths';

export const InstalledPluginRecordSchema = z
  .object({
    id: IdSchema,
    version: SemverSchema,
    manifest: PluginManifestSchema,
    /** Relative to the plugin root, e.g. `installed/demo/1.0.0`. */
    installPath: z.string().min(1).max(512),
    installedAt: z.iso.datetime(),
    enabled: z.boolean()
  })
  .strict();
export type InstalledPluginRecord = z.infer<typeof InstalledPluginRecordSchema>;

export const InstalledPluginsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    plugins: z
      .array(InstalledPluginRecordSchema)
      .max(128)
      .refine(records => new Set(records.map(record => record.id)).size === records.length, 'Plugin IDs must be unique')
  })
  .strict();
export type InstalledPluginsFile = z.infer<typeof InstalledPluginsFileSchema>;

export function emptyInstalledState(): InstalledPluginsFile {
  return { schemaVersion: 1, plugins: [] };
}

/**
 * Module-owned JSON under the plugin root. A missing file is an empty state; a corrupt
 * file is an explicit I/O failure rather than silently orphaning installed plugins.
 */
export async function loadInstalledState(path: string): Promise<InstalledPluginsFile> {
  if (!(await pathExists(path))) return emptyInstalledState();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new PluginHostError('IO_ERROR', 'state-read');
  }
  if (Buffer.byteLength(raw, 'utf8') > 1_048_576) throw new PluginHostError('IO_ERROR', 'state-size');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginHostError('IO_ERROR', 'state-json');
  }
  const result = InstalledPluginsFileSchema.safeParse(parsed);
  if (!result.success) throw new PluginHostError('IO_ERROR', 'state-schema');
  return result.data;
}

export async function saveInstalledState(path: string, state: InstalledPluginsFile): Promise<void> {
  InstalledPluginsFileSchema.parse(state);
  try {
    await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    throw new PluginHostError('IO_ERROR', 'state-write');
  }
}
