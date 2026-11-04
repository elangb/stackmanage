import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { LinuxHostsManager } from '../src/hosts-linux';
import { createLinuxRunner } from '../src/runner-linux';
import { createNodeFileSystem } from '../src/fs';
import { HOSTS_MARKER_BEGIN, HOSTS_MARKER_END } from '../src/scripts';

/**
 * End-to-end coverage of the *elevated* code path WITHOUT privilege: a stub
 * `pkexec` in a temp PATH simply execs the real helper script as the current
 * user. This proves the staging, argv layout, helper semantics and
 * post-write verification compose correctly. It does not prove that a real
 * polkit prompt succeeds, and it never touches /etc/hosts.
 */
const sandbox = mkdtempSync(join(tmpdir(), 'stackmanage-elevated-'));
const realHosts = '/etc/hosts';

function writeStubPkexec(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'pkexec');
  // A real pkexec runs its first non-option argument as the program: `exec "$@"`.
  writeFileSync(path, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

describe('elevated hosts path with a stub pkexec (no privilege, temp paths)', () => {
  let hostsPath: string;
  let helperDirectory: string;
  const hostsBefore = (() => {
    try {
      return readFileSync(realHosts, 'utf8');
    } catch {
      return '';
    }
  })();

  beforeAll(() => {
    writeStubPkexec(join(sandbox, 'bin'));
  });

  it('writes through the helper when the direct file is not writable', async () => {
    hostsPath = join(sandbox, 'hosts');
    helperDirectory = join(sandbox, 'helpers');
    const original = '127.0.0.1\tlocalhost\n# keep me\n';
    writeFileSync(hostsPath, original);
    const fs = createNodeFileSystem();
    const runner = createLinuxRunner({ PATH: `${join(sandbox, 'bin')}:/usr/bin:/bin` });
    const manager = new LinuxHostsManager({
      fs: { ...fs, canWrite: async () => false },
      runner,
      hostsPath,
      helperDirectory,
      now: () => new Date('2026-11-04T01:02:03.000Z'),
      elevation: async () => ({ kind: 'pkexec', wrapper: { file: join(sandbox, 'bin', 'pkexec'), args: [] } })
    });
    const outcome = await manager.write([{ hostname: 'app.test', address: '127.0.0.1' }, { hostname: 'api.test', address: '::1' }]);
    expect(outcome.status).toBe('written');
    const after = readFileSync(hostsPath, 'utf8');
    expect(after).toContain('127.0.0.1\tlocalhost');
    expect(after).toContain('# keep me');
    expect(after).toContain('127.0.0.1\tapp.test');
    expect(after).toContain('::1\tapi.test');
    expect(after.indexOf(HOSTS_MARKER_BEGIN)).toBeLessThan(after.indexOf(HOSTS_MARKER_END));
    // A backup sibling exists with the original bytes.
    const backups = readFileSync(`${hostsPath}.stackmanage.bak-2026-11-04T01-02-03-000Z`, 'utf8');
    expect(backups).toBe(original);
    // Staged helper has the deterministic digest-derived name.
    expect(readFileSync(join(helperDirectory, readdirOne(helperDirectory))).length).toBeGreaterThan(0);
  });

  it('leaves the real /etc/hosts untouched by this suite', () => {
    const after = (() => {
      try {
        return readFileSync(realHosts, 'utf8');
      } catch {
        return '';
      }
    })();
    expect(after).toBe(hostsBefore);
  });

  it('reports failure and preserves the file when the helper exits non-zero', async () => {
    const failing = join(sandbox, 'fail-hosts');
    const original = '127.0.0.1 localhost\n';
    writeFileSync(failing, original);
    const fs = createNodeFileSystem();
    const runner = createLinuxRunner({ PATH: '/usr/bin:/bin' });
    const manager = new LinuxHostsManager({
      fs: { ...fs, canWrite: async () => false },
      runner,
      hostsPath: failing,
      helperDirectory: join(sandbox, 'helpers-fail'),
      elevation: async () => ({ kind: 'pkexec', wrapper: { file: '/bin/false', args: [] } })
    });
    const outcome = await manager.write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('failed');
    expect(readFileSync(failing, 'utf8')).toBe(original);
  });
});

function readdirOne(directory: string): string {
  const entries = readdirSync(directory).filter(name => name.endsWith('.sh'));
  return entries[0] as string;
}
