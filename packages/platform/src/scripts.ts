import { createHash } from 'node:crypto';
import type { CommandSpec } from './command.js';

/**
 * Encodes a PowerShell script for `-EncodedCommand`: UTF-16LE then base64. The
 * script arrives as one opaque argv element, so caller data is never parsed by a
 * shell nor re-split by the OS. Generated scripts use only single-quoted
 * PowerShell literals, with `'` doubled, so `$` and backticks stay inert.
 */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** PowerShell single-quoted literal: no interpolation, `'` doubled. */
export function psLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('NUL is not permitted in a PowerShell literal');
  return `'${value.replace(/'/g, "''")}'`;
}

/** Shell single-quoted literal for POSIX `sh`: `'` becomes `'\''`. */
export function shLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('NUL is not permitted in a shell literal');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function powershellCommand(script: string): CommandSpec {
  return {
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)]
  };
}

/** Registry key for Windows elevated hosts overwrite. */
export const WINDOWS_HOSTS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters';
export const WINDOWS_HOSTS_VALUE = 'DataBasePath';
export const WINDOWS_HOSTS_FALLBACK = '%SystemRoot%\\System32\\drivers\\etc\\hosts';

export const HOSTS_MARKER_BEGIN = '# >>> StackManage managed block (do not edit inside) >>>';
export const HOSTS_MARKER_END = '# <<< StackManage managed block <<<';

/** Longest comment-only managed block content that will be accepted. */
export const HOSTS_BLOCK_MAX_BYTES = 64 * 1024;

export const LINUX_HOSTS_EXIT = Object.freeze({
  missing: 3,
  notWritable: 4,
  malformed: 5,
  backupFailed: 6,
  replaced: 0
});

export const WINDOWS_HOSTS_EXIT = Object.freeze({
  missing: 3,
  malformed: 5,
  backupFailed: 6,
  replaced: 0
});

export interface HelperScript {
  readonly name: string;
  readonly content: string;
  readonly sha256: string;
}

export interface LinuxHostsScriptInput {
  /** Absolute path of a directory inside the elevated process's trusted location. */
  readonly helperDirectory: string;
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * POSIX `sh` helper for the Linux hosts write. Arguments (never interpolated):
 * `$1` hosts path, `$2` new managed block, `$3` backup path. The script:
 * reads the existing file, rejects a malformed marker pair, writes the merged
 * content to a sibling temp file, backs up the original, then renames atomically.
 */
export function buildLinuxHostsScript(input: LinuxHostsScriptInput): HelperScript {
  const content = `#!/bin/sh
# StackManage hosts helper. Generated deterministically from library $PWD; do not edit.
set -eu
HOSTS=\${1:?hosts path required}
BACKUP=\${3:?backup path required}
BLOCKFILE=\${2:?managed block path required}
BEGIN=${shLiteral(HOSTS_MARKER_BEGIN)}
END=${shLiteral(HOSTS_MARKER_END)}
INVOKED_IN_DIR=${shLiteral(input.helperDirectory)}
[ -f "$HOSTS" ] || { echo "hosts file missing" >&2; exit ${LINUX_HOSTS_EXIT.missing}; }
[ -r "$HOSTS" ] && [ -w "$HOSTS" ] || { echo "hosts file not writable" >&2; exit ${LINUX_HOSTS_EXIT.notWritable}; }
[ -f "$BLOCKFILE" ] || { echo "managed block file missing" >&2; exit ${LINUX_HOSTS_EXIT.malformed}; }
B=$(grep -c -x -F "$BEGIN" "$HOSTS" || true)
E=$(grep -c -x -F "$END" "$HOSTS" || true)
if [ "\${B:-0}" -gt 1 ] || [ "\${E:-0}" -gt 1 ] || [ "\${B:-0}" -ne "\${E:-0}" ]; then
  echo "managed block malformed" >&2
  exit ${LINUX_HOSTS_EXIT.malformed}
fi
TMP="\${HOSTS}.stackmanage.$$.tmp"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT
: > "$TMP"
skipping=0
while IFS= read -r line || [ -n "$line" ]; do
  if [ "$line" = "$BEGIN" ]; then
    cat "$BLOCKFILE" >> "$TMP"
    skipping=1
    continue
  fi
  if [ "$line" = "$END" ]; then
    skipping=0
    continue
  fi
  [ "$skipping" -eq 1 ] && continue
  printf '%s\\n' "$line" >> "$TMP"
done < "$HOSTS"
if [ "\${B:-0}" -eq 0 ]; then
  cat "$BLOCKFILE" >> "$TMP"
fi
cp -p "$HOSTS" "$BACKUP" || { echo "backup failed" >&2; exit ${LINUX_HOSTS_EXIT.backupFailed}; }
chmod 0644 "$TMP" 2>/dev/null || true
mv -f "$TMP" "$HOSTS" || { echo "replace failed" >&2; exit ${LINUX_HOSTS_EXIT.backupFailed}; }
trap - EXIT
exit ${LINUX_HOSTS_EXIT.replaced}
`;
  return { name: 'stackmanage-hosts.sh', content, sha256: digest(content) };
}

export interface WindowsHostsScriptInput {
  readonly hostsPath: string;
  readonly blockPath: string;
  readonly backupPath: string;
}

/**
 * PowerShell helper for the Windows hosts write. All three paths are validated
 * absolute paths embedded as single-quoted literals, and the block is read from
 * its own file, so no caller data reaches a command line, a shell or `Invoke-Expression`.
 */
export function buildWindowsHostsScript(input: WindowsHostsScriptInput): HelperScript {
  for (const [name, value] of Object.entries(input)) {
    if (!isAbsoluteWindowsPath(value)) throw new Error(`${name} must be an absolute Windows path`);
  }
  const content = `# StackManage hosts helper (Windows). Generated deterministically; do not edit.
$ErrorActionPreference = 'Stop'
$Hosts = ${psLiteral(input.hostsPath)}
$BlockFile = ${psLiteral(input.blockPath)}
$Backup = ${psLiteral(input.backupPath)}
$Begin = ${psLiteral(HOSTS_MARKER_BEGIN)}
$End = ${psLiteral(HOSTS_MARKER_END)}
if (-not (Test-Path -LiteralPath $Hosts -PathType Leaf)) { Write-Error 'hosts file missing'; exit ${WINDOWS_HOSTS_EXIT.missing} }
if (-not (Test-Path -LiteralPath $BlockFile -PathType Leaf)) { Write-Error 'managed block file missing'; exit ${WINDOWS_HOSTS_EXIT.malformed} }
$lines = [System.IO.File]::ReadAllLines($Hosts)
$beginCount = @($lines | Where-Object { $_ -ceq $Begin }).Count
$endCount = @($lines | Where-Object { $_ -ceq $End }).Count
if ($beginCount -gt 1 -or $endCount -gt 1 -or $beginCount -ne $endCount) { Write-Error 'managed block malformed'; exit ${WINDOWS_HOSTS_EXIT.malformed} }
$blockLines = [System.IO.File]::ReadAllLines($BlockFile)
$merged = New-Object System.Collections.Generic.List[string]
$skipping = $false
foreach ($line in $lines) {
  if ($line -ceq $Begin) { $merged.AddRange($blockLines); $skipping = $true; continue }
  if ($line -ceq $End) { $skipping = $false; continue }
  if (-not $skipping) { $merged.Add($line) }
}
if ($beginCount -eq 0) { $merged.AddRange($blockLines) }
Copy-Item -LiteralPath $Hosts -Destination $Backup -Force -ErrorAction Stop
$temp = "$Hosts.stackmanage.$PID.tmp"
[System.IO.File]::WriteAllLines($temp, $merged, (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temp -Destination $Hosts -Force
exit ${WINDOWS_HOSTS_EXIT.replaced}
`;
  return { name: 'stackmanage-hosts.ps1', content, sha256: digest(content) };
}

/** Windows path rule: drive-qualified or UNC, no NUL, no control characters. */
export function isAbsoluteWindowsPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value) && /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value);
}

/** Deterministic, collision-resistant helper filename; consumers may cache by digest. */
export function helperFileName(script: HelperScript): string {
  return `${script.sha256.slice(0, 16)}-${script.name}`;
}
