import { describe, expect, it } from 'vitest';
import { LinuxHostsManager } from '../src/hosts-linux';
import { WindowsHostsManager } from '../src/hosts-windows';
import { decodeWindowsArgs } from '../src/hosts-windows';
import { detectLinuxElevation, elevateWith } from '../src/elevation';
import { HOSTS_MARKER_BEGIN, HOSTS_MARKER_END, buildLinuxHostsScript } from '../src/scripts';
import { OperationResultSchema } from '@stackmanage/core';
import { FakeRunner, MemoryFileSystem, failedResult, okResult, recordingContext } from './fakes';

const hostsPath = '/sandbox/etc/hosts';
const helperDirectory = '/sandbox/helpers';
const base = '127.0.0.1\tlocalhost\n::1\tlocalhost\n# untouched\n';

function manager(fs: MemoryFileSystem, runner: FakeRunner, extra: Partial<ConstructorParameters<typeof LinuxHostsManager>[0]> = {}): LinuxHostsManager {
  return new LinuxHostsManager({ fs, runner, hostsPath, helperDirectory, now: () => new Date('2026-11-04T00:00:00.000Z'), ...extra });
}

describe('LinuxHostsManager (temp/fake storage, never /etc/hosts)', () => {
  it('writes atomically when the file is writable and reports a backup', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    const runner = new FakeRunner();
    const outcome = await manager(fs, runner).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') return;
    expect(outcome.backedUp).toBe(true);
    expect(fs.files.get(hostsPath)).toContain('127.0.0.1\tapp.test');
    expect(fs.files.get(hostsPath)).toContain('# untouched');
    expect([...fs.files.keys()].some(key => key.includes('.stackmanage.bak-'))).toBe(true);
    expect(fs.writes.filter(w => w.path === hostsPath).every(w => w.atomic)).toBe(true);
    expect(runner.runs.length).toBe(0);
  });

  it('does not write or spawn anything when the block is already identical', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    const runner = new FakeRunner();
    const first = await manager(fs, runner).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(first.status).toBe('written');
    const writesAfterFirst = fs.writes.length;
    const second = await manager(fs, runner).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(second.status).toBe('unchanged');
    expect(fs.writes.length).toBe(writesAfterFirst);
    expect(runner.runs.length).toBe(0);
  });

  it('refuses a malformed existing block without modifying it', async () => {
    const original = `${HOSTS_MARKER_BEGIN}\n127.0.0.1 a.test\n`;
    const fs = new MemoryFileSystem({ [hostsPath]: original });
    const outcome = await manager(fs, new FakeRunner()).write([{ hostname: 'b.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('invalid');
    expect(fs.files.get(hostsPath)).toBe(original);
  });

  it('clears the managed block without touching unrelated hosts lines', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    const instance = manager(fs, new FakeRunner());
    expect((await instance.write([{ hostname: 'app.test', address: '127.0.0.1' }])).status).toBe('written');
    const cleared = await instance.clear();
    expect(cleared.status).toBe('written');
    const content = fs.files.get(hostsPath) as string;
    expect(content).toContain('127.0.0.1\tlocalhost');
    expect(content).toContain('# untouched');
    expect(content).not.toContain('app.test');
    expect(await instance.inspect()).toEqual({ status: 'valid', entries: [] });
  });

  it('rejects invalid and empty entry sets', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    expect((await manager(fs, new FakeRunner()).write([])).status).toBe('invalid');
    expect((await manager(fs, new FakeRunner()).write([{ hostname: 'bad host', address: '127.0.0.1' }])).status).toBe('invalid');
    expect(fs.writes.length).toBe(0);
  });

  it('returns unavailable with a plan when the file is read-only and pkexec is missing', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    fs.readOnly.add(hostsPath);
    const runner = new FakeRunner();
    const outcome = await manager(fs, runner, { elevation: async () => detectLinuxElevation(runner) }).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.plan?.privilege).toBe('required-unavailable');
    expect(outcome.plan?.execution).toBe('unverified');
    expect(runner.runs.length).toBe(0);
    expect(fs.files.get(hostsPath)).toBe(base);
  });

  it('stages a helper and reports an unavailable/failed executor without faking a write', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    fs.readOnly.add(hostsPath);
    const runner = new FakeRunner().withCommand('pkexec');
    runner.respond('/usr/bin/pkexec', failedResult('missing'));
    const outcome = await manager(fs, runner, { elevation: async () => detectLinuxElevation(runner) }).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('unavailable');
    const staged = [...fs.files.keys()].filter(key => key.startsWith(helperDirectory));
    expect(staged.length).toBe(2);
    const script = fs.files.get(staged.find(key => key.endsWith('.sh')) as string) as string;
    expect(script).toBe(buildLinuxHostsScript({ helperDirectory }).content);
    expect(runner.runs[0]?.command.file).toBe('/usr/bin/pkexec');
    expect(runner.runs[0]?.command.args.slice(0, 2)).toEqual(['/bin/sh', staged.find(key => key.endsWith('.sh'))]);
    // Hosts path, block path and backup path are separate argv elements.
    expect(runner.runs[0]?.command.args[2]).toBe(hostsPath);
    expect(runner.runs[0]?.command.args[4]).toContain('.stackmanage.bak-');
    expect(fs.files.get(hostsPath)).toBe(base);
  });

  it('treats a helper exit 5 as failure and exit 0 as success only after verification', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    fs.readOnly.add(hostsPath);
    const runner = new FakeRunner().withCommand('pkexec');
    runner.respond('/usr/bin/pkexec', okResult(5));
    const failed = await manager(fs, runner, { elevation: async () => detectLinuxElevation(runner) }).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') expect(failed.reason).toContain('malformed');

    const runner2 = new FakeRunner().withCommand('pkexec');
    runner2.respond('/usr/bin/pkexec', okResult(0, '', ));
    const success = await manager(fs, runner2, { elevation: async () => detectLinuxElevation(runner2) }).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    // The fake does not perform the write, so verification must reject success.
    expect(success.status).toBe('failed');
    if (success.status === 'failed') expect(success.reason).toContain('verification');
  });

  it('reports a timeout as failed with an unknown file state', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    fs.readOnly.add(hostsPath);
    const runner = new FakeRunner().withCommand('pkexec');
    runner.respond('/usr/bin/pkexec', failedResult('timeout'));
    const outcome = await manager(fs, runner, { elevation: async () => detectLinuxElevation(runner) }).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toContain('unknown');
  });

  it('reports an atomic-write failure instead of claiming success', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    fs.failWrites.add(hostsPath);
    const outcome = await manager(fs, new FakeRunner()).write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('failed');
    expect(fs.files.get(hostsPath)).toBe(base);
  });

  it('emits exactly one terminal result and conforms to the frozen OperationResult schema', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    const managerInstance = manager(fs, new FakeRunner());
    const context = recordingContext('hosts-op');
    const result = await managerInstance.apply([{ hostname: 'app.test', address: '127.0.0.1' }], context);
    expect(OperationResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('completed');
    const terminals = context.events.filter(e => e.type === 'terminal');
    expect(terminals.length).toBe(1);
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({ operationId: 'hosts-op', items: [{ id: 'hosts', status: 'completed' }] });
  });

  it('reports refused privilege honestly through apply', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    fs.readOnly.add(hostsPath);
    const context = recordingContext('hosts-op-2');
    const result = await manager(fs, new FakeRunner()).apply([{ hostname: 'app.test', address: '127.0.0.1' }], context);
    expect(OperationResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.items[0]?.error?.code).toBe('UNAVAILABLE');
    expect(context.events.filter(e => e.type === 'terminal').length).toBe(1);
  });

  it('previews without writing', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    const preview = await manager(fs, new FakeRunner()).preview([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect('content' in preview && preview.content).toContain('app.test');
    expect(fs.writes.length).toBe(0);
  });

  it('inspects valid, malformed and missing files', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    expect((await manager(fs, new FakeRunner()).inspect()).status).toBe('valid');
    fs.files.set(hostsPath, `${HOSTS_MARKER_BEGIN}\n`);
    expect((await manager(fs, new FakeRunner()).inspect()).status).toBe('malformed');
    fs.files.delete(hostsPath);
    expect((await manager(fs, new FakeRunner()).inspect()).status).toBe('absent');
  });
});

describe('elevation detection', () => {
  it('never selects sudo, and wraps only with a located pkexec', async () => {
    const runner = new FakeRunner().withCommand('sudo');
    expect((await detectLinuxElevation(runner)).kind).toBe('none');
    const withPkexec = new FakeRunner().withCommand('pkexec', '/usr/bin/pkexec');
    const elevation = await detectLinuxElevation(withPkexec);
    expect(elevation.kind).toBe('pkexec');
    expect(elevateWith(elevation, { file: '/bin/sh', args: ['a b', 'c;d'] })).toEqual({ file: '/usr/bin/pkexec', args: ['/bin/sh', 'a b', 'c;d'] });
  });
});

describe('WindowsHostsManager (planning only, unverified)', () => {
  const winHosts = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
  const staging = 'C:\\Users\\dev\\AppData\\Local\\StackManage\\helpers';

  it('plans an encoded command and never spawns a process', async () => {
    const fs = new MemoryFileSystem({ [winHosts]: base });
    const runner = new FakeRunner();
    const managerInstance = new WindowsHostsManager({ fs, runner, hostsPath: winHosts, stagingDirectory: staging, now: () => new Date('2026-11-04T00:00:00.000Z') });
    const outcome = await managerInstance.plan([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('planned');
    if (outcome.status !== 'planned') return;
    expect(outcome.plan.execution).toBe('unverified');
    expect(outcome.plan.privilege).toBe('unverified');
    expect(runner.runs.length).toBe(0);
    expect(fs.writes.length).toBe(0);
    expect(outcome.plan.command.args).toContain('-EncodedCommand');
    const decoded = decodeWindowsArgs(outcome.plan);
    expect(decoded.script).toContain(winHosts);
    expect(decoded.script).toContain("'");
    expect(decoded.script).not.toContain('Invoke-Expression');
    expect(outcome.staged.map(s => s.path)).toEqual([`${staging}\\stackmanage-hosts.ps1`, `${staging}\\block-2026-11-04T00-00-00-000Z.txt`]);
  });

  it('rejects non-Windows staging paths and malformed entries', async () => {
    const fs = new MemoryFileSystem({ [winHosts]: base });
    const bad = new WindowsHostsManager({ fs, runner: new FakeRunner(), hostsPath: winHosts, stagingDirectory: '/tmp/helpers' });
    expect((await bad.plan([{ hostname: 'a.test', address: '127.0.0.1' }])).status).toBe('invalid');
    const good = new WindowsHostsManager({ fs, runner: new FakeRunner(), hostsPath: winHosts, stagingDirectory: staging });
    expect((await good.plan([{ hostname: 'a.test', address: 'nope' }])).status).toBe('invalid');
  });

  it('reports unchanged and an unknown apply result', async () => {
    const fs = new MemoryFileSystem({ [winHosts]: base });
    const managerInstance = new WindowsHostsManager({ fs, runner: new FakeRunner(), hostsPath: winHosts, stagingDirectory: staging });
    await managerInstance.plan([{ hostname: 'a.test', address: '127.0.0.1' }]);
    const fs2 = new MemoryFileSystem({ [winHosts]: `${base}${HOSTS_MARKER_BEGIN}\n127.0.0.1\ta.test\n${HOSTS_MARKER_END}\n` });
    const manager2 = new WindowsHostsManager({ fs: fs2, runner: new FakeRunner(), hostsPath: winHosts, stagingDirectory: staging });
    expect((await manager2.plan([{ hostname: 'a.test', address: '127.0.0.1' }])).status).toBe('unchanged');
    const context = recordingContext('win-op');
    const result = await managerInstance.apply([{ hostname: 'a.test', address: '127.0.0.1' }], context);
    expect(OperationResultSchema.safeParse(result).success).toBe(true);
    expect(result.status).toBe('unknown');
    expect(result.warnings[0]?.messageKey).toBe('hosts.windowsExecutionUnverified');
    expect(context.events.filter(e => e.type === 'terminal').length).toBe(1);
  });
});

describe('supplementary failure isolation', () => {
  it('keeps a completed write when the backup cannot be written', async () => {
    const fs = new MemoryFileSystem({ [hostsPath]: base });
    const managerInstance = manager(fs, new FakeRunner());
    const originalWrite = fs.writeFile.bind(fs);
    fs.writeFile = async (path: string, content: string) => {
      if (path.includes('.stackmanage.bak-')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return originalWrite(path, content);
    };
    const outcome = await managerInstance.write([{ hostname: 'app.test', address: '127.0.0.1' }]);
    expect(outcome.status).toBe('written');
    if (outcome.status !== 'written') return;
    expect(outcome.backedUp).toBe(false);
    // The replace still happened exactly once and was not replayed.
    expect(fs.writes.filter(w => w.path === hostsPath).length).toBe(1);
    expect(fs.files.get(hostsPath)).toContain('app.test');
  });
});
