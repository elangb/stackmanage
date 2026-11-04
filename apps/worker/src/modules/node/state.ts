import { z } from 'zod';
import { NODE_MODULE_ID, NODE_VERSION, NodeTargetSchema } from './manifest';

/**
 * Module-scoped persisted records. A corrupt record is treated as absent and the
 * owning module reconciles against the filesystem; it is never trusted as proof
 * that a binary exists.
 */
export const NodeInstallationRecordSchema = z
  .object({
    id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    moduleId: z.literal(NODE_MODULE_ID),
    version: z.literal(NODE_VERSION),
    target: NodeTargetSchema,
    directory: z.string().min(1).max(4096),
    binaryPath: z.string().min(1).max(4096),
    archivePath: z.string().min(1).max(4096),
    installedAt: z.iso.datetime(),
    versionOutput: z.string().min(1).max(200),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();
export type NodeInstallationRecord = z.infer<typeof NodeInstallationRecordSchema>;

export const NodeInstallationsRecordSchema = z
  .object({ installations: z.array(NodeInstallationRecordSchema).max(10) })
  .strict();
export type NodeInstallationsRecord = z.infer<typeof NodeInstallationsRecordSchema>;

export const NODE_STORAGE_KEYS = Object.freeze({ installations: 'installations' });
