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

/** Registered adapters. */
export const implementedModules: readonly ModuleDefinition[] = Object.freeze([caddyModuleDefinition, nodeModuleDefinition]);
