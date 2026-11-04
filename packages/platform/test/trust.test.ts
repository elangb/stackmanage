import { describe, expect, it } from 'vitest';
import { buildLinuxTrustPlan, detectDistro, parseOsRelease, planLinuxTrust, planWindowsTrust } from '../src/trust';
import { detectLinuxElevation } from '../src/elevation';
import { FakeRunner, MemoryFileSystem } from './fakes';

const osRelease = (id: string, like = ''): string => `NAME="Test"\nID=${id}\n${like ? `ID_LIKE="${like}"\n` : ''}PRETTY_NAME="Test Linux"\n`;

describe('os-release parsing', () => {
  it('maps Debian/Ubuntu families', () => {
    expect(parseOsRelease(osRelease('ubuntu', 'debian')).family).toBe('debian');
    expect(parseOsRelease(osRelease('debian')).family).toBe('debian');
    expect(parseOsRelease(osRelease('linuxmint', 'ubuntu debian')).family).toBe('debian');
  });

  it('maps Fedora/RHEL families', () => {
    expect(parseOsRelease(osRelease('fedora')).family).toBe('rhel');
    expect(parseOsRelease(osRelease('rocky', 'rhel centos fedora')).family).toBe('rhel');
    expect(parseOsRelease(osRelease('almalinux')).family).toBe('rhel');
  });

  it('maps Arch families', () => {
    expect(parseOsRelease(osRelease('arch')).family).toBe('arch');
    expect(parseOsRelease(osRelease('manjaro', 'arch')).family).toBe('arch');
  });

  it('returns unknown for unsupported distributions and never guesses', () => {
    const result = parseOsRelease(osRelease('alpine'));
    expect(result.family).toBe('unknown');
    expect(result.id).toBe('alpine');
    expect(parseOsRelease('').family).toBe('unknown');
    expect(parseOsRelease('garbage\nwithout=structure').family).toBe('unknown');
  });

  it('preserves quoted values and reports the display name', () => {
    const parsed = parseOsRelease('PRETTY_NAME="Ubuntu 26.04 LTS"\nID=ubuntu\n');
    expect(parsed.displayName).toBe('Ubuntu 26.04 LTS');
  });

  it('detects distro via the injected filesystem and degrades to unknown', async () => {
    const fs = new MemoryFileSystem({ '/etc/os-release': osRelease('ubuntu') });
    expect((await detectDistro(fs)).family).toBe('debian');
    expect((await detectDistro(new MemoryFileSystem())).family).toBe('unknown');
  });
});

describe('Linux trust planning', () => {
  it('plans update-ca-certificates for Debian when the command exists', async () => {
    const runner = new FakeRunner().withCommand('update-ca-certificates', '/usr/sbin/update-ca-certificates');
    const target = await planLinuxTrust({ runner, platform: 'linux', distro: parseOsRelease(osRelease('ubuntu')) });
    expect(target.supported).toBe(true);
    if (!target.supported || target.family !== 'debian') return;
    expect(target.command.file).toBe('/usr/sbin/update-ca-certificates');
    expect(target.command.args).toEqual([]);
    expect(target.anchorDirectory).toBe('/usr/local/share/ca-certificates');
  });

  it('reports Debian without the command as unsupported, not as working', async () => {
    const target = await planLinuxTrust({ runner: new FakeRunner(), platform: 'linux', distro: parseOsRelease(osRelease('ubuntu')) });
    expect(target.supported).toBe(false);
    if (target.supported) return;
    expect(target.reason).toContain('update-ca-certificates is not installed');
  });

  it('plans update-ca-trust extract for RHEL', async () => {
    const runner = new FakeRunner().withCommand('update-ca-trust');
    const target = await planLinuxTrust({ runner, platform: 'linux', distro: parseOsRelease(osRelease('fedora')) });
    expect(target.supported).toBe(true);
    if (!target.supported || target.family !== 'rhel') return;
    expect(target.command.args).toEqual(['extract']);
    expect(target.anchorDirectory).toBe('/etc/pki/ca-trust/source/anchors');
  });

  it('uses trust anchor + extract-compat for Arch when trust exists, anchor only otherwise', async () => {
    const withTrust = await planLinuxTrust({ runner: new FakeRunner().withCommand('trust'), platform: 'linux', distro: parseOsRelease(osRelease('arch')) });
    expect(withTrust.supported).toBe(true);
    if (withTrust.supported && withTrust.family === 'arch') expect(withTrust.command?.args).toEqual(['extract-compat']);
    const withoutTrust = await planLinuxTrust({ runner: new FakeRunner(), platform: 'linux', distro: parseOsRelease(osRelease('arch')) });
    expect(withoutTrust.supported).toBe(true);
    if (withoutTrust.supported) expect(withoutTrust.command).toBeUndefined();
  });

  it('reports unknown distributions as unsupported with the id in the reason', async () => {
    const target = await planLinuxTrust({ runner: new FakeRunner(), platform: 'linux', distro: parseOsRelease(osRelease('alpine')) });
    expect(target.supported).toBe(false);
    if (!target.supported) expect(target.reason).toContain('alpine');
  });

  it('never executes anything and marks a planned refresh unverified', async () => {
    const runner = new FakeRunner().withCommand('update-ca-certificates');
    const plan = await buildLinuxTrustPlan({ runner, platform: 'linux', distro: parseOsRelease(osRelease('ubuntu')) });
    expect(runner.runs.length).toBe(0);
    expect(plan.execution).toBe('unverified');
    expect(plan.plan?.execution).toBe('unverified');
    expect(plan.plan?.privilege).toBe('required-unavailable');
  });

  it('wraps with pkexec only when pkexec is present', async () => {
    const runner = new FakeRunner().withCommand('update-ca-certificates').withCommand('pkexec', '/usr/bin/pkexec');
    const plan = await buildLinuxTrustPlan({ runner, platform: 'linux', distro: parseOsRelease(osRelease('ubuntu')), elevation: async () => detectLinuxElevation(runner) });
    expect(plan.plan?.privilege).toBe('required');
    expect(plan.plan?.elevated).toEqual({ file: '/usr/bin/pkexec', args: ['/usr/bin/update-ca-certificates'] });
    expect(runner.runs.length).toBe(0);
  });
});

describe('Windows trust planning', () => {
  it('plans certutil -addstore without executing and marks it unverified', () => {
    const result = planWindowsTrust('C:\\certs\\root.cer');
    expect(result.status).toBe('planned');
    expect(result.plan.command).toEqual({ file: 'certutil.exe', args: ['-addstore', '-f', 'Root', 'C:\\certs\\root.cer'] });
    expect(result.plan.execution).toBe('unverified');
    expect(result.plan.privilege).toBe('unverified');
  });

  it('rejects relative and control-character certificate paths', () => {
    expect(() => planWindowsTrust('certs\\root.cer')).toThrow();
    expect(() => planWindowsTrust('C:\\certs\\root.cer\n$x')).toThrow();
  });
});
