import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModuleStorage } from '@stackmanage/core';
import { CaddyModule } from './modules/caddy';
import { FsModuleStorage } from './modules/caddy/paths';
import { NodeModule } from './modules/node';
import { NginxModule } from './modules/nginx';

export interface BuildOptions {
  home?: string;
  runtimeHome?: string;
  storage?: ModuleStorage;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform | string;
  architecture?: string;
}

/** Worker data root for module state; `STACKMANAGE_DATA_HOME` is the test/portable override. */
export function workerDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['STACKMANAGE_DATA_HOME'];
  if (override !== undefined && override.trim() !== '') return override;
  const base =
    process.platform === 'win32'
      ? (env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (env['XDG_DATA_HOME'] !== undefined && env['XDG_DATA_HOME'] !== '' ? env['XDG_DATA_HOME'] : join(homedir(), '.local', 'share'));
  return join(base, 'StackManage');
}

/** Single lazily built Caddy instance; nothing here is selectable by an IPC caller. */
let instance: { module: CaddyModule; storage: ModuleStorage } | undefined;
let runtimeInstance: { module: NodeModule; storage: ModuleStorage } | undefined;
let nginxInstance: { module: NginxModule; storage: ModuleStorage } | undefined;

export function buildCaddyModule(options: BuildOptions = {}): { module: CaddyModule; storage: ModuleStorage } {
  const storage = options.storage ?? new FsModuleStorage(join(workerDataHome(), 'state'));
  const module = new CaddyModule({
    storage,
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {})
  });
  return { module, storage };
}

export function caddyModule(options: BuildOptions = {}): { module: CaddyModule; storage: ModuleStorage } {
  instance ??= buildCaddyModule(options);
  return instance;
}

export { CaddyModule };

/** Node runtime data is isolated from Caddy's module directory. */
export function runtimeDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['STACKMANAGE_NODE_HOME'];
  if (explicit !== undefined && explicit.trim() !== '') return resolve(explicit);
  return join(workerDataHome(env), 'runtimes', 'node');
}

export function buildNodeModule(options: BuildOptions = {}): { module: NodeModule; storage: ModuleStorage } {
  const storage = options.storage ?? new FsModuleStorage(join(workerDataHome(), 'state'));
  const module = new NodeModule({
    storage,
    home: options.runtimeHome ?? runtimeDataHome(),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {})
  });
  return { module, storage };
}

export function nodeModule(options: BuildOptions = {}): { module: NodeModule; storage: ModuleStorage } {
  runtimeInstance ??= buildNodeModule(options);
  return runtimeInstance;
}

export { NodeModule };

/** Nginx data is isolated from Caddy and the Node runtime. */
export function nginxDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['STACKMANAGE_NGINX_HOME'];
  if (explicit !== undefined && explicit.trim() !== '') return resolve(explicit);
  return join(workerDataHome(env), 'nginx');
}

export function buildNginxModule(options: BuildOptions = {}): { module: NginxModule; storage: ModuleStorage } {
  const storage = options.storage ?? new FsModuleStorage(join(workerDataHome(), 'state'));
  const module = new NginxModule({
    storage,
    home: options.runtimeHome ?? nginxDataHome(),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {})
  });
  return { module, storage };
}

export function nginxModule(options: BuildOptions = {}): { module: NginxModule; storage: ModuleStorage } {
  nginxInstance ??= buildNginxModule(options);
  return nginxInstance;
}

export { NginxModule };
