import type { ModuleDefinition } from '@stackmanage/core';

/**
 * Catalog declarations only. Runtime implementation lives in the worker module
 * that owns the installed process; a declaration is never evidence that a platform
 * actually ran.
 */
export const caddyModuleDefinition: ModuleDefinition = {
  apiVersion: 1,
  id: 'caddy',
  nameKey: 'modules.caddy',
  category: 'web',
  capabilities: ['versions', 'install', 'service', 'config', 'logs', 'panel'],
  dependencies: [],
  availability: [
    {
      platform: 'linux',
      architecture: 'x64',
      status: 'unverified',
      reason: 'Artifact is pinned; the Phase 1 Linux execution evidence is recorded in the worker integration test, not in this declaration.'
    },
    { platform: 'linux', architecture: 'arm64', status: 'unverified', reason: 'Artifact is pinned and hashed, no arm64 machine ran it.' },
    { platform: 'win32', architecture: 'x64', status: 'unverified', reason: 'Artifact is pinned and hashed, no Windows machine ran it.' }
  ]
};

export const nodeModuleDefinition: ModuleDefinition = {
  apiVersion: 1,
  id: 'node',
  nameKey: 'modules.node',
  category: 'runtime',
  capabilities: ['versions', 'install'],
  dependencies: [],
  availability: [
    {
      platform: 'linux',
      architecture: 'x64',
      status: 'unverified',
      reason: 'Artifact is pinned; the Phase 3 Linux x64 execution evidence is recorded in the worker integration test, not in this declaration.'
    },
    { platform: 'linux', architecture: 'arm64', status: 'unverified', reason: 'Artifact is pinned and hashed, no arm64 machine ran it.' },
    { platform: 'win32', architecture: 'x64', status: 'unverified', reason: 'Artifact is pinned and hashed, no Windows machine ran it.' },
    { platform: 'win32', architecture: 'arm64', status: 'unverified', reason: 'Artifact is pinned and hashed, no Windows arm64 machine ran it.' }
  ]
};


export const nginxModuleDefinition: ModuleDefinition = {
  apiVersion: 1,
  id: 'nginx',
  nameKey: 'modules.nginx',
  category: 'web',
  capabilities: ['versions', 'install', 'service', 'config', 'logs'],
  dependencies: [],
  availability: [
    {
      platform: 'linux',
      architecture: 'x64',
      status: 'unverified',
      reason: 'Official source is pinned and hashed; the Phase 4 Linux x64 build/HTTP/reload evidence is recorded in the worker integration test, not in this declaration.'
    },
    { platform: 'linux', architecture: 'arm64', status: 'unverified', reason: 'Source build should work, but no arm64 machine ran it.' },
    { platform: 'win32', architecture: 'x64', status: 'unsupported', reason: 'The official Windows zip is pinned and hashed, but Windows extraction/service execution is not implemented.' }
  ]
};

export const redisModuleDefinition: ModuleDefinition = {
  apiVersion: 1,
  id: 'redis',
  nameKey: 'modules.redis',
  category: 'database',
  capabilities: ['versions', 'install', 'service', 'config', 'logs'],
  dependencies: [],
  availability: [
    {
      platform: 'linux',
      architecture: 'x64',
      status: 'unverified',
      reason: 'Official source is pinned and hashed; the Phase 6 Linux x64 build/PING/SET/GET evidence is recorded in the worker integration test, not in this declaration.'
    },
    { platform: 'linux', architecture: 'arm64', status: 'unverified', reason: 'Source build should work, but no arm64 machine ran it.' },
    { platform: 'win32', architecture: 'x64', status: 'unsupported', reason: 'Redis upstream publishes no supported native Windows build; no unofficial fork is used.' }
  ]
};

/** Registered adapters. */
export const phpModuleDefinition: ModuleDefinition = {
  apiVersion: 1,
  id: 'php',
  nameKey: 'modules.php',
  category: 'runtime',
  capabilities: ['versions', 'install', 'service', 'logs'],
  dependencies: [],
  availability: [
    {
      platform: 'linux',
      architecture: 'x64',
      status: 'unverified',
      reason: 'The runtime is produced by the repository build runner and validated locally; no container build was executed in the authoring environment.'
    },
    { platform: 'linux', architecture: 'arm64', status: 'unsupported', reason: 'The build runner currently targets linux-x64 only.' },
    { platform: 'win32', architecture: 'x64', status: 'unsupported', reason: 'No native Windows runtime artifact is produced by the build runner.' }
  ]
};

export const implementedModules: readonly ModuleDefinition[] = Object.freeze([caddyModuleDefinition, nodeModuleDefinition, nginxModuleDefinition, redisModuleDefinition, phpModuleDefinition]);
