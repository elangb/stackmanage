import { describe, expect, it } from 'vitest';
import { detectCurrentHost, detectPlatform } from '../src/detect';
import { RootPaths, resolveDataRoots } from '../src/paths';

describe('platform detection', () => {
  it('accepts only linux and win32 on contract architectures', () => {
    expect(detectPlatform({ platform: 'linux', arch: 'x64' })).toEqual({ supported: true, platform: 'linux', architecture: 'x64' });
    expect(detectPlatform({ platform: 'linux', arch: 'arm64' })).toEqual({ supported: true, platform: 'linux', architecture: 'arm64' });
    expect(detectPlatform({ platform: 'win32', arch: 'x64' })).toEqual({ supported: true, platform: 'win32', architecture: 'x64' });
  });

  it('reports darwin as unsupported instead of guessing an adapter', () => {
    const result = detectPlatform({ platform: 'darwin', arch: 'arm64' });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toContain('darwin');
  });

  it('rejects architectures outside the frozen contract and unknown platforms', () => {
    for (const arch of ['ia32', 'arm', 'ppc64', 's390x', '']) expect(detectPlatform({ platform: 'linux', arch }).supported).toBe(false);
    expect(detectPlatform({ platform: 'freebsd', arch: 'x64' }).supported).toBe(false);
  });

  it('detects the real current host without throwing', () => {
    const current = detectCurrentHost();
    expect(typeof current.supported).toBe('boolean');
    expect(current.platform).toBe(process.platform);
    expect(current.architecture).toBe(process.arch);
  });
});

describe('data root resolution', () => {
  it('uses XDG_DATA_HOME and XDG_CONFIG_HOME on Linux', () => {
    const roots = resolveDataRoots('linux', { HOME: '/home/dev', XDG_DATA_HOME: '/xdg/data', XDG_CONFIG_HOME: '/xdg/config' });
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.roots.data).toBe('/xdg/data/StackManage');
    expect(roots.roots.config).toBe('/xdg/config/StackManage');
    expect(roots.roots.source).toBe('xdg-data-home');
    expect(roots.roots.overridden).toBe(false);
  });

  it('falls back to HOME defaults when XDG variables are absent', () => {
    const roots = resolveDataRoots('linux', { HOME: '/home/dev' });
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.roots.data).toBe('/home/dev/.local/share/StackManage');
    expect(roots.roots.config).toBe('/home/dev/.config/StackManage');
    expect(roots.roots.cache).toBe('/home/dev/.cache/StackManage');
    expect(roots.roots.source).toBe('home-fallback');
  });

  it('honours portable mode before any OS default', () => {
    const roots = resolveDataRoots('linux', { HOME: '/home/dev', XDG_DATA_HOME: '/xdg/data', STACKMANAGE_HOME: '/opt/portable' });
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.roots.data).toBe('/opt/portable');
    expect(roots.roots.source).toBe('portable-env');
    expect(roots.roots.overridden).toBe(true);
  });

  it('honours an explicit data override and cache override', () => {
    const roots = resolveDataRoots('linux', { HOME: '/home/dev', STACKMANAGE_DATA_HOME: '/srv/sm', STACKMANAGE_CACHE_HOME: '/var/tmp/sm' });
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.roots.data).toBe('/srv/sm');
    expect(roots.roots.cache).toBe('/var/tmp/sm');
    expect(roots.roots.logs).toBe('/srv/sm');
    expect(roots.roots.source).toBe('env-override');
    expect(roots.roots.overridden).toBe(true);

    const anchored = resolveDataRoots('linux', { HOME: '/home/dev', STACKMANAGE_DATA_HOME: '/srv/sm' });
    expect(anchored.ok).toBe(true);
    if (!anchored.ok) return;
    expect(anchored.roots.cache).toBe('/srv/sm/cache');
  });

  it('reports missing environment facts instead of inventing a path', () => {
    const roots = resolveDataRoots('linux', {});
    expect(roots.ok).toBe(false);
    if (roots.ok) return;
    expect(roots.missing).toContain('HOME');
  });

  it('uses Windows per-user locations and portable override', () => {
    const standard = resolveDataRoots('win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' });
    expect(standard.ok).toBe(true);
    if (!standard.ok) return;
    expect(standard.roots.data).toBe('C:\\Users\\dev\\AppData\\Local\\StackManage');
    expect(standard.roots.config).toBe('C:\\Users\\dev\\AppData\\Roaming\\StackManage');

    const portable = resolveDataRoots('win32', { LOCALAPPDATA: 'C:\\Local', APPDATA: 'C:\\Roaming', STACKMANAGE_HOME: 'D:\\StackManage Portable' });
    expect(portable.ok).toBe(true);
    if (!portable.ok) return;
    expect(portable.roots.data).toBe('D:\\StackManage Portable');
    expect(portable.roots.source).toBe('portable-env');
  });

  it('derives Windows roaming/local from USERPROFILE when the dedicated variables are absent', () => {
    const roots = resolveDataRoots('win32', { USERPROFILE: 'C:\\Users\\dev' });
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.roots.data).toContain('AppData\\Local');
  });

  it('is workspace independent: no cwd or checkout path leaks in', () => {
    const roots = resolveDataRoots('linux', { HOME: '/home/dev', XDG_DATA_HOME: '/xdg/data' });
    expect(roots.ok).toBe(true);
    if (!roots.ok) return;
    expect(roots.roots.data).not.toContain(process.cwd());
  });

  it('keeps containment checks platform aware', () => {
    const posix = new RootPaths('linux');
    expect(posix.isInside('/data/sm', '/data/sm/projects/a')).toBe(true);
    expect(posix.isInside('/data/sm', '/data/sm2/escape')).toBe(false);
    expect(posix.isInside('/data/sm', '/data/SM/projects')).toBe(false);
    const windows = new RootPaths('win32');
    expect(windows.isInside('C:\\SM', 'c:/sm/projects/a')).toBe(true);
    expect(windows.isInside('C:\\SM', 'C:/SMBackup/x')).toBe(false);
  });
});
