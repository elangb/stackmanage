export type ModuleStatus = 'verified' | 'partial' | 'planned' | 'unverified';

export interface ModuleCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly category: 'web' | 'runtime' | 'cache';
  readonly status: ModuleStatus;
  readonly pinnedVersion: string | null;
  readonly supported: readonly string[];
  readonly tested: readonly string[];
  readonly declaredCapabilities: readonly string[];
  readonly evidence: string | null;
  readonly readOnly: true;
  readonly note: string;
}

/**
 * Honest catalog. `partial` means at least one platform/architecture has real
 * execution evidence; it is not a claim of general availability. `planned`
 * modules have no implementation and no read state in this phase.
 */
export const MODULE_CATALOG: readonly ModuleCatalogEntry[] = Object.freeze([
  {
    id: 'caddy',
    name: 'Caddy',
    category: 'web',
    status: 'partial',
    pinnedVersion: '2.11.8',
    supported: ['linux-x64'],
    tested: ['linux-x64'],
    declaredCapabilities: ['install', 'service', 'sites', 'logs', 'config'],
    evidence: 'docs/reports/phase1-core.md',
    readOnly: true,
    note: 'Installation, lifecycle, sites and local TLS verified on Linux x64 only. Windows and Linux arm64 artifacts are pinned but unexecuted.'
  },
  {
    id: 'nginx',
    name: 'Nginx',
    category: 'web',
    status: 'partial',
    pinnedVersion: '1.30.6',
    supported: ['linux-x64'],
    tested: ['linux-x64'],
    declaredCapabilities: ['install', 'service', 'logs', 'config'],
    evidence: 'docs/reports/phase4-nginx.md',
    readOnly: true,
    note: 'Official source build and lifecycle verified on Linux x64 only. Linux arm64 is unexecuted and Windows execution is unsupported in this build.'
  },
  {
    id: 'node',
    name: 'Node.js',
    category: 'runtime',
    status: 'partial',
    pinnedVersion: '24.22.2',
    supported: ['linux-x64'],
    tested: ['linux-x64'],
    declaredCapabilities: ['install', 'runtime'],
    evidence: 'docs/reports/phase3-node-runtime.md',
    readOnly: true,
    note: 'Pinned install, binary version check and uninstall verified on Linux x64 only. Windows and arm64 artifacts are pinned but unexecuted; shell hooks are not implemented.'
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'cache',
    status: 'planned',
    pinnedVersion: null,
    supported: [],
    tested: [],
    declaredCapabilities: [],
    evidence: null,
    readOnly: true,
    note: 'Planned. No installer, service record or persisted state exists; version and licence path are not pinned.'
  }
]);
