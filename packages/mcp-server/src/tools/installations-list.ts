import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DataRoots } from '../data/roots.js';
import {
  confinedPath,
  readCaddyInstallation,
  readNginxInstallations,
  readNodeInstallations,
  type Warning
} from '../data/state.js';
import { runTool } from './common.js';

export type InstallationModule = 'caddy' | 'nginx' | 'node' | 'redis';

interface InstallationView {
  readonly id: string;
  readonly moduleId: string;
  readonly version: string;
  readonly target: string | null;
  readonly platform: string;
  readonly architecture: string;
  readonly directory: string | null;
  readonly binaryPath: string | null;
  readonly installedAt: string;
  readonly versionOutput: string;
  readonly source: string | null;
  readonly sha256: string | null;
}

function targetFacts(target: string): { platform: string; architecture: string } {
  const match = /^(linux|windows|win|darwin)-(amd64|arm64|x64)$/.exec(target);
  if (match?.[1] === undefined || match[2] === undefined) return { platform: 'unknown', architecture: 'unknown' };
  const platform = match[1] === 'windows' || match[1] === 'win' ? 'win32' : match[1];
  const architecture = match[2] === 'amd64' ? 'x64' : match[2];
  return { platform, architecture };
}

interface ModuleInstallations {
  readonly moduleId: InstallationModule;
  readonly state: 'present' | 'empty' | 'absent' | 'unknown';
  readonly installations: readonly InstallationView[];
  readonly warnings: readonly Warning[];
}

function unknownRecord(moduleId: InstallationModule, reason: string): ModuleInstallations {
  return {
    moduleId,
    state: 'unknown',
    installations: [],
    warnings: [{ code: 'STATE_UNREADABLE', message: `Persisted ${moduleId} state is ${reason}; no installation is claimed.` }]
  };
}

async function caddy(roots: DataRoots): Promise<ModuleInstallations> {
  const read = await readCaddyInstallation(roots);
  if (read.state === 'absent') return { moduleId: 'caddy', state: 'absent', installations: [], warnings: [] };
  if (read.state === 'unknown') return unknownRecord('caddy', read.reason);
  const record = read.value;
  const warnings: Warning[] = [];
  const directory = confinedPath(roots.caddyRoot, record.installation.directory);
  const binaryPath = confinedPath(roots.caddyRoot, record.binaryPath);
  if (directory === null || binaryPath === null) {
    warnings.push({ code: 'PATH_OUTSIDE_ROOT', message: 'The persisted installation path is outside the managed Caddy root and was omitted.' });
  }
  return {
    moduleId: 'caddy',
    state: 'present',
    installations: [
      {
        id: record.installation.id,
        moduleId: 'caddy',
        version: record.installation.version.version,
        target: record.target,
        platform: record.installation.version.platform,
        architecture: record.installation.version.architecture,
        directory,
        binaryPath,
        installedAt: record.installedAt,
        versionOutput: record.versionOutput,
        source: record.installation.version.source,
        sha256: record.installation.version.sha256
      }
    ],
    warnings
  };
}

async function nginx(roots: DataRoots): Promise<ModuleInstallations> {
  const read = await readNginxInstallations(roots);
  if (read.state === 'absent') return { moduleId: 'nginx', state: 'absent', installations: [], warnings: [] };
  if (read.state === 'unknown') return unknownRecord('nginx', read.reason);
  const warnings: Warning[] = [];
  const installations = read.value.installations.map(record => {
    const directory = confinedPath(roots.nginxRoot, record.directory);
    const binaryPath = confinedPath(roots.nginxRoot, record.binaryPath);
    if (directory === null || binaryPath === null) {
      warnings.push({ code: 'PATH_OUTSIDE_ROOT', message: 'A persisted Nginx installation path is outside the managed root and was omitted.' });
    }
    const facts = targetFacts(record.target);
    return {
      id: record.id,
      moduleId: 'nginx',
      version: record.version,
      target: record.target,
      platform: facts.platform,
      architecture: facts.architecture,
      directory,
      binaryPath,
      installedAt: record.installedAt,
      versionOutput: record.versionOutput,
      source: record.source,
      sha256: record.sha256
    };
  });
  return { moduleId: 'nginx', state: installations.length === 0 ? 'empty' : 'present', installations, warnings };
}

async function node(roots: DataRoots): Promise<ModuleInstallations> {
  const read = await readNodeInstallations(roots);
  if (read.state === 'absent') return { moduleId: 'node', state: 'absent', installations: [], warnings: [] };
  if (read.state === 'unknown') return unknownRecord('node', read.reason);
  const warnings: Warning[] = [];
  const installations = read.value.installations.map(record => {
    const directory = confinedPath(roots.nodeRoot, record.directory);
    const binaryPath = confinedPath(roots.nodeRoot, record.binaryPath);
    if (directory === null || binaryPath === null) {
      warnings.push({ code: 'PATH_OUTSIDE_ROOT', message: 'A persisted Node installation path is outside the managed root and was omitted.' });
    }
    const facts = targetFacts(record.target);
    return {
      id: record.id,
      moduleId: 'node',
      version: record.version,
      target: record.target,
      platform: facts.platform,
      architecture: facts.architecture,
      directory,
      binaryPath,
      installedAt: record.installedAt,
      versionOutput: record.versionOutput,
      source: null,
      sha256: record.sha256
    };
  });
  return { moduleId: 'node', state: installations.length === 0 ? 'empty' : 'present', installations, warnings };
}

export function installationsListTool(roots: DataRoots, moduleId?: InstallationModule): Promise<CallToolResult> {
  return runTool('installations.list', async () => {
    const selected: InstallationModule[] = moduleId === undefined ? ['caddy', 'nginx', 'node'] : [moduleId];
    const modules: ModuleInstallations[] = [];
    for (const id of selected) {
      if (id === 'caddy') modules.push(await caddy(roots));
      else if (id === 'nginx') modules.push(await nginx(roots));
      else if (id === 'node') modules.push(await node(roots));
      else modules.push({ moduleId: 'redis', state: 'absent', installations: [], warnings: [{ code: 'PLANNED', message: 'Redis has no installer or persisted records.' }] });
    }
    return {
      modules,
      recordOnly: true,
      note: 'Installation records are read-only state. A record does not prove the binary still exists.'
    };
  });
}
