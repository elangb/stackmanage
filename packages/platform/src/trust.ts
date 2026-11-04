import type { CommandPlan, ProcessRunner } from './command.js';
import { elevateWith, type Elevation } from './elevation.js';
import type { FileSystemPort } from './ports.js';

export type LinuxDistroFamily = 'debian' | 'rhel' | 'arch' | 'unknown';

export interface DistroIdentity {
  readonly family: LinuxDistroFamily;
  readonly id: string;
  readonly likeIds: readonly string[];
  readonly displayName: string;
}

const DEBIAN_IDS = new Set(['debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'zorin', 'raspbian', 'kali', 'parrot']);
const RHEL_IDS = new Set(['rhel', 'fedora', 'centos', 'rocky', 'almalinux', 'ol', 'oracle', 'amzn', 'cloudlinux', 'scientific', 'virtuozzo']);
const ARCH_IDS = new Set(['arch', 'archarm', 'manjaro', 'endeavouros', 'garuda', 'cachyos', 'artix']);

/** Parses `/etc/os-release` text. Values only influence a *plan*; they never imply vendor support. */
export function parseOsRelease(content: string): DistroIdentity {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] as string).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    values.set(key, value);
  }
  const id = (values.get('ID') ?? '').toLowerCase();
  const likeIds = (values.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(v => v.length > 0);
  const candidates = [id, ...likeIds];
  const family: LinuxDistroFamily = candidates.some(c => DEBIAN_IDS.has(c)) ? 'debian'
    : candidates.some(c => RHEL_IDS.has(c)) ? 'rhel'
    : candidates.some(c => ARCH_IDS.has(c)) ? 'arch'
    : 'unknown';
  return { family, id: id || 'unknown', likeIds, displayName: values.get('PRETTY_NAME') ?? id ?? 'unknown' };
}

export type TrustTarget =
  | { readonly supported: true; readonly family: 'debian'; readonly anchorDirectory: string; readonly command: Command; readonly verifyCommand?: Command }
  | { readonly supported: true; readonly family: 'rhel'; readonly anchorDirectory: string; readonly command: Command; readonly verifyCommand?: Command }
  | { readonly supported: true; readonly family: 'arch'; readonly anchorDirectory: string; readonly command?: Command }
  | { readonly supported: false; readonly family: LinuxDistroFamily | 'windows'; readonly reason: string; readonly availableCommands: readonly string[] };

export interface Command {
  readonly file: string;
  readonly args: readonly string[];
}

export interface TrustPlan {
  readonly description: string;
  readonly target: TrustTarget;
  readonly anchorDirectory?: string;
  readonly privilege: 'not-required' | 'required' | 'required-unavailable' | 'unverified';
  readonly execution: 'verified' | 'unverified';
  readonly plan?: CommandPlan;
  readonly elevation?: Elevation;
}

const ANCHOR_DEBIAN = '/usr/local/share/ca-certificates';
const ANCHOR_RHEL = '/etc/pki/ca-trust/source/anchors';
const ANCHOR_ARCH = '/etc/ca-certificates/trust-source/anchors';

export interface TrustProbeOptions {
  readonly runner: ProcessRunner;
  readonly platform: 'linux' | 'win32';
  readonly distro: DistroIdentity;
  readonly elevation?: () => Promise<Elevation>;
}

/**
 * Plans trust installation. Availability is decided by the distro family AND
 * the presence of the expected command: a Debian host without
 * `update-ca-certificates` is reported unsupported, never assumed to work.
 */
export async function planLinuxTrust(options: TrustProbeOptions): Promise<TrustTarget> {
  const { runner, distro } = options;
  const find = async (...names: string[]): Promise<{ name: string; path: string }[]> => {
    const found: { name: string; path: string }[] = [];
    for (const name of names) {
      const path = await runner.which(name);
      if (path) found.push({ name, path });
    }
    return found;
  };
  if (distro.family === 'debian') {
    const found = await find('update-ca-certificates');
    const target = found[0];
    if (!target) return { supported: false, family: 'debian', reason: 'update-ca-certificates is not installed', availableCommands: [] };
    const command: Command = { file: target.path, args: [] };
    return { supported: true, family: 'debian', anchorDirectory: ANCHOR_DEBIAN, command };
  }
  if (distro.family === 'rhel') {
    const found = await find('update-ca-trust');
    const target = found[0];
    if (!target) return { supported: false, family: 'rhel', reason: 'update-ca-trust is not installed', availableCommands: [] };
    return { supported: true, family: 'rhel', anchorDirectory: ANCHOR_RHEL, command: { file: target.path, args: ['extract'] } };
  }
  if (distro.family === 'arch') {
    const found = await find('trust');
    if (found[0]) return { supported: true, family: 'arch', anchorDirectory: ANCHOR_ARCH, command: { file: found[0].path, args: ['extract-compat'] } };
    return { supported: true, family: 'arch', anchorDirectory: ANCHOR_ARCH };
  }
  return { supported: false, family: 'unknown', reason: `unsupported Linux distribution id "${distro.id}"`, availableCommands: [] };
}

/** Builds the full plan including elevation for the refresh command. Never runs it. */
export async function buildLinuxTrustPlan(options: TrustProbeOptions): Promise<TrustPlan> {
  const target = await planLinuxTrust(options);
  const elevation = options.elevation ? await options.elevation() : ({ kind: 'none', reason: 'no elevation provider configured' } as Elevation);
  if (!target.supported) {
    return { description: 'trust refresh unsupported', target, privilege: 'required-unavailable', execution: 'unverified', elevation };
  }
  if (!target.command) {
    return { description: 'trust anchor directory only; no refresh command available', target, anchorDirectory: target.anchorDirectory, privilege: 'required-unavailable', execution: 'unverified', elevation, ...(elevation.reason ? {} : {}) };
  }
  const elevated = elevateWith(elevation, target.command);
  const plan: CommandPlan = {
    description: `trust refresh (${target.family})`,
    command: target.command,
    ...(elevated ? { elevated } : {}),
    privilege: elevated ? 'required' : 'required-unavailable',
    execution: 'unverified',
    notes: [
      `anchor directory: ${target.anchorDirectory}`,
      'the refresh command is invoked with an empty argv after the program path; no shell is used',
      elevated ? 'elevation would be provided by pkexec' : 'no pkexec available; the refresh cannot be elevated and nothing was executed'
    ]
  };
  return { description: plan.description, target, anchorDirectory: target.anchorDirectory, privilege: plan.privilege, execution: 'unverified', plan, elevation };
}

export type WindowsTrustResult = {
  readonly status: 'planned';
  readonly plan: CommandPlan;
  readonly notes: readonly string[];
};

/**
 * Windows trust planning only. `certutil -addstore` is the documented command,
 * but this phase does not execute it; execution remains UNVERIFIED.
 */
export function planWindowsTrust(certificatePath: string): WindowsTrustResult {
  if (!/^[A-Za-z]:[\\/]/.test(certificatePath) || /[\0\r\n]/.test(certificatePath)) {
    throw new Error('certificate path must be an absolute Windows path');
  }
  const command = { file: 'certutil.exe', args: ['-addstore', '-f', 'Root', certificatePath] };
  return {
    status: 'planned',
    plan: {
      description: 'Windows Root store trust via certutil',
      command,
      privilege: 'unverified',
      execution: 'unverified',
      notes: [
        'certutil -addstore -f Root <path> runs only when an already-elevated channel exists',
        'certificate path is a single argv element; no shell interpolation',
        'Windows trust execution is NOT verified'
      ]
    },
    notes: ['planning only; no process was started']
  };
}

/** Reads `/etc/os-release` through the injected port; unreadable content yields `unknown`, never a guess. */
export async function detectDistro(fs: FileSystemPort, osReleasePath = '/etc/os-release'): Promise<DistroIdentity> {
  try {
    return parseOsRelease(await fs.readFile(osReleasePath));
  } catch {
    return { family: 'unknown', id: 'unknown', likeIds: [], displayName: 'unknown' };
  }
}
