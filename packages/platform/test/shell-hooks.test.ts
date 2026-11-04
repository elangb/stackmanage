import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractHookBlock, parseHook, renderCmdHook, renderFishHook, renderHook, renderPosixHook, renderPowerShellHook } from '../src/shell-hooks';

const HOSTILE_DIRS = [
  '/home/dev/My Project',
  "/home/dev/it's a project",
  '/home/dev/$HOME/$(touch pwned)',
  '/home/dev/`touch pwned`',
  '/home/dev/semi;colon&&pipe|',
  '/home/dev/ünïcode/проект',
  '/home/dev/back\\slash',
  '/home/dev/double"quote'
];

describe('POSIX hook generation', () => {
  it.each(HOSTILE_DIRS)('round-trips %s and never breaks quoting', projectDirectory => {
    const result = renderPosixHook({ projectDirectory, pathEntries: ['bin', '/usr/local/bin'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseHook(result.content, 'bash');
    expect(parsed.projectDirectory).toBe(projectDirectory);
    expect(parsed.pathEntries).toEqual([`${projectDirectory}/bin`, '/usr/local/bin']);
    expect(result.content).toContain('StackManage shell hook');
  });

  it('rejects relative project paths', () => {
    expect(renderPosixHook({ projectDirectory: 'relative/dir', pathEntries: [] }).ok).toBe(false);
    expect(renderFishHook({ projectDirectory: 'relative', pathEntries: [] }).ok).toBe(false);
    expect(renderPowerShellHook({ projectDirectory: '/posix/path', pathEntries: [] }).ok).toBe(false);
  });

  it('rejects NUL and newline injection in entries', () => {
    const nul = renderPosixHook({ projectDirectory: '/a\0b', pathEntries: [] });
    expect(nul.ok).toBe(false);
    const newline = renderPowerShellHook({ projectDirectory: 'C:\\a\nb', pathEntries: [] });
    expect(newline.ok).toBe(false);
  });

  it('executes safely in real bash and prepends only existing directories', () => {
    const projectDirectory = '/tmp/opencode/stackmanage-hook-project';
    const result = renderPosixHook({ projectDirectory, pathEntries: ['bin', 'missing-dir', '$(touch /tmp/opencode/pwned)'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    spawnSync('mkdir', ['-p', `${projectDirectory}/bin`]);
    expect(existsSync(`${projectDirectory}/bin`)).toBe(true);
    const run = spawnSync('bash', ['--noprofile', '--norc', '-c', `PATH=/usr/bin:/bin; ${result.content}\nprintf '%s' "$PATH"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(run.status).toBe(0);
    const entries = run.stdout.split(':');
    expect(entries[0]).toBe(`${projectDirectory}/bin`);
    expect(entries).not.toContain(`${projectDirectory}/missing-dir`);
    // The command-substitution entry is a literal path that does not exist: it is never executed and never added.
    expect(entries).not.toContain(`${projectDirectory}/$(touch /tmp/opencode/pwned)`);
    expect(run.stdout).not.toContain('\n');
  });

  it('is idempotent when evaluated twice', () => {
    const projectDirectory = '/tmp/opencode/stackmanage-hook-project';
    const result = renderHook('bash', { projectDirectory, pathEntries: ['bin'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = spawnSync('bash', ['--noprofile', '--norc', '-c', `export PATH=/usr/bin:/bin; ${result.content}\n${result.content}\nprintf '%s' "$PATH"`], { encoding: 'utf8' });
    expect(run.stdout.split(':').filter(entry => entry === `${projectDirectory}/bin`).length).toBe(1);
  });
});

describe('fish hook generation', () => {
  it.each(HOSTILE_DIRS)('round-trips %s', projectDirectory => {
    const result = renderFishHook({ projectDirectory, pathEntries: ['bin'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = parseHook(result.content, 'fish');
    expect(parsed.projectDirectory).toBe(projectDirectory);
    expect(parsed.pathEntries).toEqual([`${projectDirectory}/bin`]);
  });
});

describe('PowerShell and cmd hooks', () => {
  it('escapes PowerShell metacharacters with backticks', () => {
    const result = renderPowerShellHook({ projectDirectory: 'C:\\Users\\dev\\My $Project', pathEntries: ['bin'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('`$Project');
    expect(result.content).toContain('"C:\\Users\\dev\\My `$Project\\bin"');
    expect(result.content).toContain('Test-Path -LiteralPath');
    expect(result.content).not.toContain('Invoke-Expression');
  });

  it('rejects quote injection in PowerShell paths', () => {
    const result = renderPowerShellHook({ projectDirectory: 'C:\\a"\nb', pathEntries: [] });
    expect(result.ok).toBe(false);
  });

  it('refuses cmd paths that cmd cannot represent instead of emitting broken output', () => {
    expect(renderCmdHook({ projectDirectory: 'C:\\Users\\dev\\my project', pathEntries: ['bin'] }).ok).toBe(true);
    expect(renderCmdHook({ projectDirectory: 'C:\\100%\\sm', pathEntries: [] }).ok).toBe(false);
    expect(renderCmdHook({ projectDirectory: 'C:\\a&b\\sm', pathEntries: [] }).ok).toBe(false);
    const ok = renderCmdHook({ projectDirectory: 'C:\\Users\\dev\\my project', pathEntries: ['bin'] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.content).toContain('set "STACKMANAGE_PROJECT=C:\\Users\\dev\\my project"');
  });
});

describe('block extraction', () => {
  it('extracts exactly one block and rejects duplicates', () => {
    const first = renderHook('bash', { projectDirectory: '/a/b', pathEntries: [] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const wrapped = `# user profile\nalias ll='ls -l'\n${first.content}`;
    expect(extractHookBlock(wrapped)).toContain('STACKMANAGE_PROJECT');
    expect(() => extractHookBlock(`${first.content}${first.content}`)).toThrow(/duplicated/);
    expect(extractHookBlock('# nothing here\n')).toBeUndefined();
  });
});
