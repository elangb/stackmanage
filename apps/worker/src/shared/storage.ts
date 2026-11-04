import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { ModuleStorage } from '@stackmanage/core';
import { atomicWriteFile } from './files';

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** JSON-file storage scoped per module id; module-scoped state, never `config.setup`. */
export class FsModuleStorage implements ModuleStorage {
  private writing = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private file(moduleId: string, key: string): string {
    if (!SAFE_SEGMENT.test(moduleId) || !SAFE_SEGMENT.test(key)) throw new Error('invalid storage key');
    return join(this.root, moduleId, `${key}.json`);
  }

  async StorageGetAsync<T>(moduleId: string, key: string, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(moduleId, key), 'utf8'));
      // A corrupt record is treated as absent; owners reconcile against the filesystem.
      const result = schema.safeParse(parsed);
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  async StorageSetAsync<T>(moduleId: string, key: string, value: T, schema: z.ZodType<T>): Promise<void> {
    // Validate before persisting so a caller cannot store an out-of-contract record.
    schema.parse(value);
    const path = this.file(moduleId, key);
    const previous = this.writing.get(path) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`))
      .finally(() => {
        if (this.writing.get(path) === next) this.writing.delete(path);
      });
    this.writing.set(path, next);
    await next;
  }
}
