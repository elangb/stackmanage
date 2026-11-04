import { describe, expect, it } from 'vitest';
import { LinuxAutostart, autostartPath, desktopExecArgument, parseDesktopExec, planWindowsAutostart, planWindowsAutostartRemoval, renderDesktopEntry } from '../src/autostart';
import { MemoryFileSystem } from './fakes';

function decode(plan: { command: { args: readonly string[] } }): string {
  const index = plan.command.args.indexOf('-EncodedCommand');
  return Buffer.from(plan.command.args[index + 1] as string, 'base64').toString('utf16le');
}

describe('XDG autostart', () => {
  const configHome = '/home/dev/.config';

  it('writes a valid desktop entry under XDG_CONFIG_HOME/autostart', async () => {
    const fs = new MemoryFileSystem();
    const autostart = new LinuxAutostart(fs, configHome);
    const outcome = await autostart.enable({ executable: '/opt/StackManage/stackmanage', args: ['--hidden'] });
    expect(outcome.status).toBe('written');
    const path = autostartPath(configHome);
    expect(path).toBe('/home/dev/.config/autostart/stackmanage.desktop');
    const content = fs.files.get(path) as string;
    expect(content).toContain('[Desktop Entry]');
    expect(content).toContain('Type=Application');
    expect(content).toContain('Exec=/opt/StackManage/stackmanage --hidden');
    expect(content).toContain('Terminal=false');
    expect(await autostart.status()).toBe('enabled');
  });

  it('is idempotent and reports changed=false', async () => {
    const fs = new MemoryFileSystem();
    const autostart = new LinuxAutostart(fs, configHome);
    await autostart.enable({ executable: '/opt/sm/sm' });
    const second = await autostart.enable({ executable: '/opt/sm/sm' });
    expect(second).toMatchObject({ status: 'written', changed: false });
  });

  it('quotes paths with spaces, quotes and percent signs', async () => {
    const fs = new MemoryFileSystem();
    const autostart = new LinuxAutostart(fs, configHome);
    const exe = '/opt/My App $HOME `x` "q" %f/sm';
    const outcome = await autostart.enable({ executable: exe, args: ['--flag=a b'] });
    expect(outcome.status).toBe('written');
    const content = fs.files.get(autostartPath(configHome)) as string;
    const execLine = content.split('\n').find(line => line.startsWith('Exec=')) as string;
    expect(execLine).toContain('\\"');
    expect(execLine).toContain('%%f');
    expect(execLine).not.toContain('`x`');
    expect(parseDesktopExec(execLine.slice('Exec='.length))).toEqual([exe, '--flag=a b']);
  });

  it('rejects relative executables and control characters', async () => {
    const autostart = new LinuxAutostart(new MemoryFileSystem(), configHome);
    expect((await autostart.enable({ executable: 'bin/sm' })).status).toBe('invalid');
    expect((await autostart.enable({ executable: '/opt/sm\nrm -rf /' })).status).toBe('invalid');
  });

  it('refuses to overwrite or remove an unrelated file', async () => {
    const fs = new MemoryFileSystem({ [autostartPath(configHome)]: '[Desktop Entry]\nName=Something Else\n' });
    const autostart = new LinuxAutostart(fs, configHome);
    expect((await autostart.enable({ executable: '/opt/sm/sm' })).status).toBe('failed');
    expect((await autostart.disable()).status).toBe('failed');
    expect(await autostart.status()).toBe('foreign');
  });

  it('removes only its own entry and reports a no-op removal', async () => {
    const fs = new MemoryFileSystem();
    const autostart = new LinuxAutostart(fs, configHome);
    await autostart.enable({ executable: '/opt/sm/sm' });
    expect(await autostart.disable()).toEqual({ status: 'removed', path: autostartPath(configHome), removed: true });
    expect(await autostart.disable()).toEqual({ status: 'removed', path: autostartPath(configHome), removed: false });
  });

  it('rejects a non-absolute config home', () => {
    expect(() => autostartPath('relative/.config')).toThrow();
  });
});

describe('desktop entry escaping', () => {
  it('round-trips hostile argv values', () => {
    const argv = ['/opt/a b/c', 'arg"with"quotes', '-x=$HOME', 'back\\slash', "single'quote", '%percent'];
    const line = argv.map(desktopExecArgument).join(' ');
    expect(parseDesktopExec(line)).toEqual(argv);
  });

  it('rejects unterminated quoting instead of guessing', () => {
    expect(() => parseDesktopExec('"unterminated')).toThrow();
  });

  it('renders deterministic entries including TryExec when requested', () => {
    const a = renderDesktopEntry({ executable: '/opt/sm/sm', tryExec: true });
    const b = renderDesktopEntry({ executable: '/opt/sm/sm', tryExec: true });
    expect(a).toBe(b);
    expect(a).toContain('TryExec=/opt/sm/sm');
  });
});

describe('Windows registry autostart planning', () => {
  it('plans an HKCU Run write using an encoded command and never executes it', () => {
    const plan = planWindowsAutostart({ executable: 'C:\\Program Files\\StackManage\\sm.exe', args: ['--hidden'] });
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    expect(plan.execution).toBe('unverified');
    expect(plan.command.file).toBe('powershell.exe');
    const script = decode(plan as { command: { args: readonly string[] } });
    expect(script).toContain('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
    expect(script).toContain('New-ItemProperty');
    expect(script).not.toContain('Invoke-Expression');
    expect(plan.notes.some(n => n.includes('NOT verified'))).toBe(true);
  });

  it('rejects a relative Windows executable', () => {
    expect(planWindowsAutostart({ executable: 'sm.exe' }).status).toBe('invalid');
  });

  it('plans removal limited to the StackManage value', () => {
    const plan = planWindowsAutostartRemoval();
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') return;
    const script = decode(plan as { command: { args: readonly string[] } });
    expect(script).toContain('Remove-ItemProperty');
    expect(script).toContain("'StackManage'");
  });
});
