import type { FileSystemPort } from './ports.js';
import { isAbsolutePath } from './fs.js';
import { psLiteral, shLiteral } from './scripts.js';

export const XDG_AUTOSTART_FILE = 'stackmanage.desktop';
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_RUN_VALUE = 'StackManage';

export type AutostartSpec = {
  /** Absolute path to the executable launched at login. */
  readonly executable: string;
  /** Extra argv; each element is quoted independently. */
  readonly args?: readonly string[];
};

/** Desktop Entry spec `Exec` quoting: double quotes are escaped, `%` in literals is doubled. */
export function desktopExecArgument(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('control characters are not permitted in a desktop entry argument');
  const needsQuotes = /[\s"'\\><~|&;$*?#()`]/.test(value) || value.length === 0;
  if (!needsQuotes) return value.replace(/%/g, '%%');
  return `"${value.replace(/[\\"`$]/g, ch => `\\${ch}`).replace(/%/g, '%%')}"`;
}

/** Parses one Desktop Entry `Exec` value back to argv. Throws on malformed quoting. */
export function parseDesktopExec(value: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] as string;
    if (quoted) {
      if (ch === '\\') {
        const next = value[index + 1];
        if (next === undefined) throw new Error('dangling escape');
        current += next;
        index += 1;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        argv.push(current.replace(/%%/g, '%'));
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quoted) throw new Error('unterminated quote');
  if (started) argv.push(current.replace(/%%/g, '%'));
  return argv;
}

export interface DesktopEntryInput extends AutostartSpec {
  readonly name?: string;
  readonly comment?: string;
  readonly tryExec?: boolean;
}

/** Renders a deterministic XDG autostart entry for the current user. */
export function renderDesktopEntry(input: DesktopEntryInput): string {
  const exec = [input.executable, ...(input.args ?? [])].map(desktopExecArgument).join(' ');
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${input.name ?? 'StackManage'}`,
    `Comment=${input.comment ?? 'StackManage local development workspace'}`,
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ...(input.tryExec ? [`TryExec=${desktopExecArgument(input.executable)}`] : []),
    ''
  ];
  return lines.join('\n');
}

export function autostartPath(configHome: string, file = XDG_AUTOSTART_FILE): string {
  if (!isAbsolutePath(configHome)) throw new Error('XDG config home must be an absolute path');
  return `${configHome.replace(/[\\/]+$/, '')}/autostart/${file}`;
}

export type AutostartOutcome =
  | { readonly status: 'written'; readonly path: string; readonly changed: boolean }
  | { readonly status: 'removed'; readonly path: string; readonly removed: boolean }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

/**
 * Linux autostart writer. Writes only inside the caller-provided XDG config
 * home; it will not accept a path escaping it. Failures are returned, and an
 * unrelated existing file at the target is never overwritten blindly.
 */
export class LinuxAutostart {
  constructor(private readonly fs: FileSystemPort, private readonly configHome: string) {}

  target(): string {
    return autostartPath(this.configHome);
  }

  async status(): Promise<'enabled' | 'missing' | 'foreign'> {
    const path = this.target();
    try {
      const content = await this.fs.readFile(path);
      return isOwnEntry(content) ? 'enabled' : 'foreign';
    } catch {
      return 'missing';
    }
  }

  async enable(input: AutostartSpec): Promise<AutostartOutcome> {
    if (!isAbsolutePath(input.executable)) return { status: 'invalid', reason: 'executable must be an absolute path' };
    let content: string;
    try {
      content = renderDesktopEntry({ ...input, tryExec: true });
    } catch (error) {
      return { status: 'invalid', reason: (error as Error).message };
    }
    const path = this.target();
    const existing = await this.fs.readFile(path).catch(() => undefined);
    if (existing === content) return { status: 'written', path, changed: false };
    // Ownership is decided by our own marker, not by a generic [Desktop Entry] header.
    if (existing !== undefined && !isOwnEntry(existing)) return { status: 'failed', reason: 'refusing to overwrite an unrelated file' };
    try {
      await this.fs.mkdirp(path.slice(0, path.lastIndexOf('/')));
      await this.fs.writeFileAtomic(path, content);
      return { status: 'written', path, changed: true };
    } catch {
      return { status: 'failed', reason: 'could not write the autostart entry' };
    }
  }

  async disable(): Promise<AutostartOutcome> {
    const path = this.target();
    const existing = await this.fs.readFile(path).catch(() => undefined);
    if (existing === undefined) return { status: 'removed', path, removed: false };
    if (!isOwnEntry(existing)) return { status: 'failed', reason: 'refusing to remove an unrelated desktop entry' };
    try {
      await this.fs.remove(path);
      return { status: 'removed', path, removed: true };
    } catch {
      return { status: 'failed', reason: 'could not remove the autostart entry' };
    }
  }
}

function isOwnEntry(content: string): boolean {
  return content.startsWith('[Desktop Entry]') && /^Name=StackManage$/m.test(content) && /^Comment=StackManage local development workspace$/m.test(content);
}

export type RegistryPlan =
  | { readonly status: 'planned'; readonly command: { readonly file: string; readonly args: readonly string[] }; readonly execution: 'unverified'; readonly notes: readonly string[] }
  | { readonly status: 'invalid'; readonly reason: string };

function quoteCommandLineArg(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('control characters are not permitted');
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Windows autostart plan: a per-user `HKCU\\...\\Run` value. Uses PowerShell
 * `-EncodedCommand` with a single-quoted data string, so the data never becomes
 * script. Planning only; never executed in this phase.
 */
export function planWindowsAutostart(input: AutostartSpec, script: string = 'StackManageCtl'): RegistryPlan {
  if (!/^[A-Za-z]:[\\/]/.test(input.executable)) return { status: 'invalid', reason: 'executable must be an absolute Windows path' };
  const quoted = [input.executable, ...(input.args ?? [])].map(quoteCommandLineArg).join(' ');
  const data = `${quoted} ${script}`.trimStart();
  const powershell = `$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; $value = ${psLiteral(WINDOWS_RUN_VALUE)}; $data = ${psLiteral(data)}; New-Item -Path $key -Force | Out-Null; New-ItemProperty -Path $key -Name $value -Value $data -PropertyType String -Force | Out-Null`;
  return {
    status: 'planned',
    command: { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')] },
    execution: 'unverified',
    notes: ['writes only HKCU; no elevation required', 'Windows registry execution is NOT verified', `stored command data: ${data}`]
  };
}

export function planWindowsAutostartRemoval(): RegistryPlan {
  const powershell = `$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; Remove-ItemProperty -Path $key -Name ${psLiteral(WINDOWS_RUN_VALUE)} -ErrorAction SilentlyContinue`;
  return {
    status: 'planned',
    command: { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(powershell, 'utf16le').toString('base64')] },
    execution: 'unverified',
    notes: ['removes only the per-user StackManage value', 'Windows registry execution is NOT verified']
  };
}

/** Shell comment quoting for generated hooks; not used for execution. */
export const shellCommentSafe = (value: string): string => value.replace(/[\r\n]/g, ' ');
export { shLiteral };
