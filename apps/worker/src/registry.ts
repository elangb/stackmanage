import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModuleStorage } from '@stackmanage/core';
import { CaddyModule } from './modules/caddy';
import { FsModuleStorage } from './modules/caddy/paths';

export interface BuildOptions {
  home?: string;
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
