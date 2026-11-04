import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { planLinuxKill, planWindowsKill, describeWindowsJobObject } from '../src/process-kill';
import { OwnedProcess, findFreeLoopbackPort, probePort, startEphemeralListener } from '../src/health';
import { createLinuxRunner } from '../src/runner-linux';

describe('process tree kill planning', () => {
  it('plans a two-phase Linux group kill for an owned process', () => {
    const plan = planLinuxKill({ pid: 4242, owned: true, platform: 'linux' });
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.strategy).toBe('process-group');
    expect(plan.graceful).toEqual({ method: 'SIGTERM', pid: 4242, group: true });
    expect(plan.forceful).toEqual({ method: 'SIGKILL', pid: 4242, group: true });
    expect(plan.plan.command.args).toEqual(['-TERM', '-4242']);
    expect(plan.plan.execution).toBe('verified');
    expect(plan.gracePeriodMs).toBe(5000);
  });

  it('refuses PIDs it does not own and unsafe PIDs', () => {
    expect(planLinuxKill({ pid: 4242, owned: false, platform: 'linux' }).status).toBe('invalid');
    expect(planLinuxKill({ pid: 1, owned: true, platform: 'linux' }).status).toBe('invalid');
    expect(planLinuxKill({ pid: 0, owned: true, platform: 'linux' }).status).toBe('invalid');
    expect(planLinuxKill({ pid: 1.5, owned: true, platform: 'linux' }).status).toBe('invalid');
    expect(planWindowsKill({ pid: 4242, owned: false, platform: 'win32' }).status).toBe('invalid');
    expect(planWindowsKill({ pid: 4, owned: true, platform: 'win32' }).status).toBe('invalid');
  });

  it('plans taskkill /T /F for Windows and marks it unverified', () => {
    const plan = planWindowsKill({ pid: 9000, owned: true, platform: 'win32' });
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.plan.command).toEqual({ file: 'taskkill.exe', args: ['/PID', '9000', '/T', '/F'] });
    expect(plan.plan.execution).toBe('unverified');
    expect(describeWindowsJobObject().execution).toBe('unverified');
  });
});

describe('health and port probe (real loopback)', () => {
  it('reports a listening ephemeral port as open and a closed one as closed', async () => {
    const listener = await startEphemeralListener();
    try {
      const open = await probePort('127.0.0.1', listener.port, 2000);
      expect(open.status).toBe('open');
      if (open.status === 'open') expect(open.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await listener.close();
    }
    const closed = await probePort('127.0.0.1', listener.port, 2000);
    expect(closed.status).toBe('closed');
    if (closed.status === 'closed') expect(closed.reason).toBe('ECONNREFUSED');
  });

  it('finds a free loopback port and it is bindable', async () => {
    const port = await findFreeLoopbackPort();
    expect(port).toBeGreaterThan(1023);
    const before = await probePort('127.0.0.1', port, 1000);
    expect(before.status).toBe('closed');
  });

  it('terminates only a disposable child it spawned itself', async () => {
    const owned = OwnedProcess.spawn('/bin/sh', ['-c', 'sleep 30 & wait; sleep 30']);
    const probe = spawnSync('ps', ['-o', 'pid=', '-p', String(owned.pid)], { encoding: 'utf8' });
    expect(probe.stdout.trim()).toBe(String(owned.pid));
    const result = await owned.stop(5000);
    expect(result.status).toBe('stopped');
    if (result.status === 'stopped') expect(result.pid).toBe(owned.pid);
    const after = spawnSync('ps', ['-o', 'pid=', '-p', String(owned.pid)], { encoding: 'utf8' });
    expect(after.stdout.trim()).toBe('');
  });
});

describe('real Linux runner', () => {
  const runner = createLinuxRunner({ PATH: '/usr/bin:/bin' });

  it('locates a real program and refuses path-like names', async () => {
    expect(await runner.which('sh')).toMatch(/\/sh$/);
    expect(await runner.which('../bin/sh')).toBeUndefined();
    expect(await runner.which('/bin/sh')).toBeUndefined();
    expect(await runner.which('definitely-not-a-real-program-xyz')).toBeUndefined();
  });

  it('captures exit codes and does not use a shell', async () => {
    const result = await runner.run({ file: '/bin/sh', args: ['-c', 'exit 7'] }, { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe(7);
    const marker = '/tmp/opencode/stackmanage-runner-no-shell-marker';
    await rm(marker, { force: true });
    const echo = await runner.run({ file: '/bin/echo', args: [`a b; touch ${marker}`] }, { timeoutMs: 5000 });
    expect(echo.ok).toBe(true);
    if (echo.ok) expect(echo.stdout.trim()).toBe(`a b; touch ${marker}`);
    expect(existsSync(marker)).toBe(false);
  });

  it('reports a missing program and a timeout honestly', async () => {
    const missing = await runner.run({ file: '/nonexistent/program', args: [] }, { timeoutMs: 1000 });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('missing');
    const timed = await runner.run({ file: '/bin/sh', args: ['-c', 'sleep 5'] }, { timeoutMs: 200 });
    expect(timed.ok).toBe(false);
    if (!timed.ok) {
      expect(timed.reason).toBe('timeout');
      expect(timed.timedOut).toBe(true);
    }
  });

  it('honours abort signals', async () => {
    const controller = new AbortController();
    const pending = runner.run({ file: '/bin/sh', args: ['-c', 'sleep 5'] }, { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('aborted');
  });
});
