import { AvailabilitySchema } from '@stackmanage/core';
import type { ModuleDefinition } from '@stackmanage/core';
import type { SupportedArchitecture } from './detect.js';

export type PlatformCapability =
  | 'hosts-write'
  | 'trust-store'
  | 'port-bind'
  | 'autostart'
  | 'shell-hook'
  | 'process-tree-kill'
  | 'port-probe'
  | 'data-root'
  | 'elevation';

export type CapabilityStatus =
  | { readonly status: 'verified'; readonly evidence: string }
  | { readonly status: 'unverified'; readonly reason: string }
  | { readonly status: 'unsupported'; readonly reason: string };

export type CapabilityMatrix = Readonly<Record<PlatformCapability, CapabilityStatus>>;

export interface CapabilityInput {
  readonly platform: 'linux' | 'win32';
  readonly arch: SupportedArchitecture;
  /** Command availability discovered at runtime; absent means unknown. */
  readonly commands: Readonly<Record<string, boolean>>;
}

const ALL: readonly PlatformCapability[] = ['hosts-write', 'trust-store', 'port-bind', 'autostart', 'shell-hook', 'process-tree-kill', 'port-probe', 'data-root', 'elevation'];

/**
 * Capability matrix. Nothing is `verified` by construction: `verified` is only
 * set by explicit evidence, and this function takes a caller-supplied evidence
 * map so an adapter cannot promote itself. Everything without evidence is
 * `unverified`; `unsupported` is used only when the platform family genuinely
 * lacks the feature.
 */
export function buildCapabilityMatrix(input: CapabilityInput, evidence: Partial<Record<PlatformCapability, string>> = {}): CapabilityMatrix {
  const matrix = Object.create(null) as Record<PlatformCapability, CapabilityStatus>;
  for (const capability of ALL) {
    const provided = evidence[capability];
    if (provided !== undefined) {
      matrix[capability] = { status: 'verified', evidence: provided };
      continue;
    }
    if (input.platform === 'win32') {
      matrix[capability] = { status: 'unverified', reason: 'Windows execution is not verified in this phase; planning only' };
      continue;
    }
    if (capability === 'trust-store') {
      const has = input.commands['update-ca-certificates'] === true || input.commands['update-ca-trust'] === true || input.commands['trust'] === true;
      matrix[capability] = has ? { status: 'unverified', reason: 'refresh command present; the refresh has not been run' } : { status: 'unsupported', reason: 'no supported trust refresh command on PATH' };
      continue;
    }
    if (capability === 'elevation') {
      matrix[capability] = input.commands['pkexec'] === true ? { status: 'unverified', reason: 'pkexec present; no privileged operation has been executed' } : { status: 'unsupported', reason: 'pkexec is not installed; privileged operations report unavailable' };
      continue;
    }
    if (capability === 'port-bind') {
      matrix[capability] = input.commands['setcap'] === true ? { status: 'unverified', reason: 'setcap present; capability was not applied' } : { status: 'unsupported', reason: 'setcap is not installed; only the high-port fallback is possible' };
      continue;
    }
    matrix[capability] = { status: 'unverified', reason: 'implemented in packages/platform; not executed as part of acceptance' };
  }
  return matrix;
}

/** Availability rows for module definitions. Status is never `supported` without evidence. */
export function availabilityRows(arch: SupportedArchitecture, platform: 'linux' | 'win32'): ModuleDefinition['availability'] {
  return [
    AvailabilitySchema.parse({ platform, architecture: arch, status: 'unverified', reason: 'no vendor artifact or execution evidence recorded for this platform' }),
    AvailabilitySchema.parse({ platform: platform === 'linux' ? 'win32' : 'linux', architecture: arch, status: 'unverified', reason: 'other platform not verified' })
  ];
}
