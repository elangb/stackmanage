import { describe, expect, it } from 'vitest';
import { assessPortRisk, bindCapability, parseGetcap, planBindStrategy, linuxUnprivilegedPortStart } from '../src/ports-capability';
import { detectLinuxElevation } from '../src/elevation';
import { FakeRunner, MemoryFileSystem } from './fakes';

describe('privileged port risk', () => {
  it('flags 80/443 below the sysctl threshold and ignores high ports', () => {
    const risk = assessPortRisk([80, 443, 8080], 1024);
    expect(risk.status).toBe('risk');
    if (risk.status === 'risk') expect(risk.ports).toEqual([80, 443]);
    expect(assessPortRisk([8080, 8443], 1024).status).toBe('no-risk');
  });

  it('honours a lowered sysctl threshold', () => {
    expect(assessPortRisk([80], 0).status).toBe('no-risk');
    expect(assessPortRisk([443], 443).status).toBe('no-risk');
    expect(assessPortRisk([80], 80).status).toBe('no-risk');
    expect(assessPortRisk([80], 81).status).toBe('risk');
  });

  it('reads the real sysctl through the injected filesystem and returns undefined when absent', async () => {
    const fs = new MemoryFileSystem({ '/proc/sys/net/ipv4/ip_unprivileged_port_start': '1024\n' });
    expect(await linuxUnprivilegedPortStart(fs)).toBe(1024);
    expect(await linuxUnprivilegedPortStart(new MemoryFileSystem())).toBeUndefined();
    const garbage = new MemoryFileSystem({ '/proc/sys/net/ipv4/ip_unprivileged_port_start': 'not-a-number' });
    expect(await linuxUnprivilegedPortStart(garbage)).toBeUndefined();
  });

  it('keeps availability unknown until a capability is proven', () => {
    const risk = assessPortRisk([80], 1024);
    expect(bindCapability(risk, undefined)).toMatchObject({ state: 'risk', canBind: false });
    expect(bindCapability(risk, true)).toMatchObject({ state: 'privileged-ok', canBind: true });
    expect(bindCapability(assessPortRisk([8080], 1024), undefined)).toMatchObject({ state: 'unprivileged', canBind: true });
  });

  it('parses getcap output strictly', () => {
    expect(parseGetcap('/usr/bin/node cap_net_bind_service=ep', '/usr/bin/node')).toBe(true);
    expect(parseGetcap('/usr/bin/node cap_net_bind_service=eip\n', '/usr/bin/node')).toBe(true);
    expect(parseGetcap('/usr/bin/node cap_net_raw=ep', '/usr/bin/node')).toBe(false);
    expect(parseGetcap('/usr/bin/nodex cap_net_bind_service=ep', '/usr/bin/node')).toBe(false);
    expect(parseGetcap('', '/usr/bin/node')).toBe(false);
  });
});

describe('bind strategy planning', () => {
  it('prefers the high-port fallback with no binary and runs nothing', async () => {
    const runner = new FakeRunner();
    const strategy = await planBindStrategy({ runner, ports: [80], unprivilegedStart: 1024 });
    expect(strategy.kind).toBe('high-port-fallback');
    if (strategy.kind === 'high-port-fallback') {
      expect(strategy.suggested).toBe(8080);
      expect(strategy.reason).toContain('no binary');
    }
    expect((await planBindStrategy({ runner, ports: [443], unprivilegedStart: 1024 })).kind).toBe('high-port-fallback');
    expect(runner.runs.length).toBe(0);
  });

  it('offers a setcap plan with an explicit unverified, non-elevated status', async () => {
    const runner = new FakeRunner().withCommand('setcap', '/usr/sbin/setcap');
    const strategy = await planBindStrategy({ runner, ports: [80], unprivilegedStart: 1024, binary: '/opt/stack/node' });
    expect(strategy.kind).toBe('requires-capability');
    if (strategy.kind !== 'requires-capability') return;
    expect(strategy.plan.command).toEqual({ file: '/usr/sbin/setcap', args: ['cap_net_bind_service=+ep', '/opt/stack/node'] });
    expect(strategy.plan.privilege).toBe('required-unavailable');
    expect(strategy.plan.execution).toBe('unverified');
    expect(runner.runs.length).toBe(0);
  });

  it('refuses a relative binary and never invokes sudo', async () => {
    const runner = new FakeRunner().withCommand('setcap').withCommand('sudo');
    const strategy = await planBindStrategy({ runner, ports: [80], unprivilegedStart: 1024, binary: 'bin/node' });
    expect(strategy.kind).toBe('high-port-fallback');
    expect(runner.runs.length).toBe(0);
  });

  it('adds pkexec only when detected and still does not execute', async () => {
    const runner = new FakeRunner().withCommand('setcap').withCommand('pkexec');
    const strategy = await planBindStrategy({ runner, ports: [80], unprivilegedStart: 1024, binary: '/opt/node', elevation: async () => detectLinuxElevation(runner) });
    expect(strategy.kind).toBe('requires-capability');
    if (strategy.kind !== 'requires-capability') return;
    expect(strategy.plan.privilege).toBe('required');
    expect(strategy.plan.elevated?.file).toBe('/usr/bin/pkexec');
    expect(runner.runs.length).toBe(0);
  });

  it('requires at least one port', async () => {
    await expect(planBindStrategy({ runner: new FakeRunner(), ports: [] })).rejects.toThrow();
  });
});
