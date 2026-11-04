import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeFileSystem, isAbsolutePath, writeFileAtomicWith } from '../src/fs';

const fs = createNodeFileSystem();

describe('real filesystem port (temp directories only)', () => {
  it('replaces atomically and leaves no temp file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stackmanage-fs-'));
    const target = join(dir, 'hosts');
    writeFileSync(target, 'old\n');
    await fs.writeFileAtomic(target, 'new\n');
    expect(readFileSync(target, 'utf8')).toBe('new\n');
    expect(readdirSync(dir)).toEqual(['hosts']);
  });

  it('creates missing parent directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stackmanage-fs-'));
    const target = join(dir, 'a', 'b', 'hosts');
    await fs.writeFileAtomic(target, 'x\n');
    expect(readFileSync(target, 'utf8')).toBe('x\n');
  });

  it('leaves the destination untouched when the temp write fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stackmanage-fs-'));
    const target = join(dir, 'hosts');
    writeFileSync(target, 'keep\n');
    const failing = {
      ...fs,
      writeFile: async () => {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }
    };
    await expect(writeFileAtomicWith(failing, target, 'discard\n')).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
  });

  it('reports kind and mtime without throwing for missing paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stackmanage-fs-'));
    expect(await fs.kind(join(dir, 'nope'))).toBe('missing');
    expect(await fs.modifiedAt(join(dir, 'nope'))).toBeUndefined();
    const file = join(dir, 'f');
    writeFileSync(file, 'x');
    expect(await fs.kind(file)).toBe('file');
    expect(await fs.kind(dir)).toBe('directory');
    expect(await fs.modifiedAt(file)).toBeGreaterThan(0);
  });

  it('detects write permission honestly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stackmanage-fs-'));
    const file = join(dir, 'f');
    writeFileSync(file, 'x');
    expect(await fs.canWrite(file)).toBe(true);
    expect(await fs.canWrite(join(dir, 'absent'))).toBe(false);
  });

  it('validates absolute paths and rejects NUL', () => {
    expect(isAbsolutePath('/etc/hosts')).toBe(true);
    expect(isAbsolutePath('C:\\Windows\\hosts')).toBe(true);
    expect(isAbsolutePath('relative/path')).toBe(false);
    expect(isAbsolutePath('/a\0b')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
    expect(isAbsolutePath(`/${'a'.repeat(5000)}`)).toBe(false);
  });
});
