import type { CommandPlan, ProcessRunner } from './command.js';
import { elevateWith, type Elevation } from './elevation.js';
import type { FileSystemPort } from './ports.js';
import { isAbsolutePath } from './fs.js';

export const PRIVILEGED_PORTS = Object.freeze([80, 443] as const);
export const UNPRIVILEGED_PORT_MIN = 1024;

export type PortRisk =
  | { readonly status: 'no-risk'; readonly reason: string }
  | { readonly status: 'risk'; readonly ports: readonly number[]; readonly reason: string };

export type BindCapabilityState =
  | { readonly state: 'unprivileged'; readonly canBind: true; readonly reason: string }
  | { readonly state: 'privileged-ok'; readonly canBind: true; readonly reason: string }
  | { readonly state: 'risk'; readonly canBind: false; readonly reason: string };

/** Parameter-free probe on the actual privilege sysctl when the real filesystem is available. */
export async function linuxUnprivilegedPortStart(fs: FileSystemPort, sysctlPath = '/proc/sys/net/ipv4/ip_unprivileged_port_start'): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(sysctlPath);
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function assessPortRisk(ports: readonly number[], unprivilegedStart: number | undefined): PortRisk {
  const privileged = ports.filter(p => p < (unprivilegedStart ?? UNPRIVILEGED_PORT_MIN));
  if (privileged.length === 0) return { status: 'no-risk', reason: unprivilegedStart === undefined ? 'all requested ports are >= 1024 (sysctl unreadable; default assumed)' : `all requested ports are >= ${unprivilegedStart}` };
  return { status: 'risk', ports: [...new Set(privileged)].sort((a, b) => a - b), reason: `ports below ${unprivilegedStart ?? UNPRIVILEGED_PORT_MIN} require privilege on this host` };
}

export function bindCapability(risk: PortRisk, hasCapability: boolean | undefined): BindCapabilityState {
  if (risk.status === 'no-risk') return { state: 'unprivileged', canBind: true, reason: risk.reason };
  if (hasCapability === true) return { state: 'privileged-ok', canBind: true, reason: `binary already holds cap_net_bind_service (ports ${risk.ports.join(', ')})` };
  if (hasCapability === undefined) return { state: 'risk', canBind: false, reason: `${risk.reason}; getcap could not confirm a capability, so availability is unknown` };
  return { state: 'risk', canBind: false, reason: risk.reason };
}

/** Parses `getcap` output for the capability on the given binary. */
export function parseGetcap(output: string, binary: string): boolean {
  return output.split(/\r?\n/).some(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith(binary)) return false;
    const caps = trimmed.slice(binary.length).trim();
    return caps.split(',').some(cap => cap.trim() === 'cap_net_bind_service=ep' || cap.trim() === 'cap_net_bind_service=eip' || cap.trim() === 'cap_net_bind_service=p');
  });
}

export type BindStrategy =
  | { readonly kind: 'use-port'; readonly port: number; readonly reason: string }
  | { readonly kind: 'high-port-fallback'; readonly requested: number; readonly suggested: number; readonly reason: string }
  | { readonly kind: 'requires-capability'; readonly binary: string; readonly ports: readonly number[]; readonly plan: CommandPlan; readonly notes: readonly string[] };

/**
 * Plans the fix for a bind risk. The preferred, unprivileged strategy is a
 * high-port fallback; `cap_net_bind_service` is offered as an explicit,
 * separately-authorized plan (needs `setcap`, root, and a binary path).
 * This function never executes anything and never invokes sudo.
 */
export async function planBindStrategy(options: {
  readonly runner: ProcessRunner;
  readonly ports: readonly number[];
  readonly unprivilegedStart?: number;
  readonly binary?: string;
  readonly elevation?: () => Promise<Elevation>;
}): Promise<BindStrategy> {
  const first = options.ports[0];
  if (first === undefined) throw new Error('at least one port is required');
  const risk = assessPortRisk(options.ports, options.unprivilegedStart);
  if (risk.status === 'no-risk') return { kind: 'use-port', port: first, reason: 'already unprivileged' };
  const suggested = first === 80 ? 8080 : first === 443 ? 8443 : first + 8000;
  if (!options.binary) return { kind: 'high-port-fallback', requested: first, suggested, reason: 'no binary was specified for setcap' };
  if (!isAbsolutePath(options.binary)) return { kind: 'high-port-fallback', requested: first, suggested, reason: 'binary path must be absolute for setcap' };
  const setcap = await options.runner.which('setcap');
  const elevation = options.elevation ? await options.elevation() : ({ kind: 'none', reason: 'no elevation provider configured' } as Elevation);
  const setcapArgs = ['cap_net_bind_service=+ep', options.binary];
  const command = { file: setcap ?? 'setcap', args: setcapArgs };
  const elevated = elevateWith(elevation, command);
  const plan: CommandPlan = {
    description: 'grant cap_net_bind_service to a binary',
    command,
    ...(elevated ? { elevated } : {}),
    privilege: setcap && elevated ? 'required' : 'required-unavailable',
    execution: 'unverified',
    notes: [
      'setcap is never run automatically; it requires explicit authorization',
      'capability is bound to the binary path; replacing the binary drops it',
      ...(setcap ? [] : ['setcap was not found on PATH']),
      ...(elevated ? [] : ['no pkexec available, so elevation is unavailable'])
    ]
  };
  return { kind: 'requires-capability', binary: options.binary, ports: risk.ports, plan, notes: plan.notes };
}
