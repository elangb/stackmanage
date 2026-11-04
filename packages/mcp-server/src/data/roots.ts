import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Only the platforms the desktop app targets are accepted for data-root defaults. */
export type StackManagePlatform = 'win32' | 'linux' | 'darwin';

export type RootEnv = Readonly<Record<string, string | undefined>>;

export interface DataRoots {
  readonly platform: StackManagePlatform;
  /** Caddy module root. Also the worker's `STACKMANAGE_DATA_HOME` value. */
  readonly dataRoot: string;
  /** Parent of the per-user StackManage directory that owns all module roots. */
  readonly anchor: string;
  readonly caddyRoot: string;
  readonly nginxRoot: string;
  readonly nodeRoot: string;
  readonly stateRoot: string;
  readonly source: 'env-override' | 'platform-default';
}

export class DataRootConfigError extends Error {
  override readonly name = 'DataRootConfigError';
}

export interface ResolveDataRootsOptions {
  readonly env?: RootEnv;
  readonly platform?: NodeJS.Platform | string;
  readonly home?: string;
}

function supportedPlatform(value: string): StackManagePlatform {
  if (value === 'win32' || value === 'linux' || value === 'darwin') return value;
  throw new DataRootConfigError(`unsupported platform: ${value}`);
}

function absoluteDirectory(value: string, variable: string): string {
  if (value.trim() === '') throw new DataRootConfigError(`${variable} must not be empty`);
  if (value.includes('\u0000')) throw new DataRootConfigError(`${variable} contains an invalid character`);
  if (!isAbsolute(value)) throw new DataRootConfigError(`${variable} must be an absolute path`);
  const resolved = resolve(value);
  if (dirname(resolved) === resolved) throw new DataRootConfigError(`${variable} must not be a filesystem root`);
  return resolved;
}

/** Lexical containment; symlink escapes are checked again on every read. */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertInside(root: string, candidate: string, variable: string): string {
  if (!isPathInside(root, candidate)) throw new DataRootConfigError(`${variable} must stay inside the StackManage data directory`);
  return resolve(candidate);
}

function defaultDataRoot(platform: StackManagePlatform, env: RootEnv, home: string): string {
  if (platform === 'win32') {
    const appData = env['APPDATA']?.trim() !== undefined && env['APPDATA']?.trim() !== '' ? (env['APPDATA'] as string) : join(home, 'AppData', 'Roaming');
    return join(resolve(appData), 'StackManage', 'caddy');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'StackManage', 'caddy');
  const configHome = env['XDG_CONFIG_HOME']?.trim() !== undefined && env['XDG_CONFIG_HOME']?.trim() !== '' ? (env['XDG_CONFIG_HOME'] as string) : join(home, '.config');
  return join(resolve(configHome), 'StackManage', 'caddy');
}

/**
 * Resolves the one trusted data tree for this server.
 *
 * `STACKMANAGE_DATA_HOME` is the Caddy module root, matching what the desktop
 * passes to the worker. The parent directory anchors the sibling Nginx and Node
 * roots. An optional `STACKMANAGE_NGINX_HOME` / `STACKMANAGE_NODE_HOME` override
 * is accepted only when it stays inside that anchor; tool callers can never
 * provide a path.
 */
export function resolveDataRoots(options: ResolveDataRootsOptions = {}): DataRoots {
  const env = options.env ?? process.env;
  const platform = supportedPlatform(options.platform ?? process.platform);
  const home = resolve(options.home ?? homedir());
  const override = env['STACKMANAGE_DATA_HOME'];
  const source = override !== undefined ? 'env-override' : 'platform-default';
  const dataRoot = override !== undefined ? absoluteDirectory(override, 'STACKMANAGE_DATA_HOME') : defaultDataRoot(platform, env, home);
  const anchor = basename(dataRoot).toLowerCase() === 'caddy' ? dirname(dataRoot) : dataRoot;

  const nginxOverride = env['STACKMANAGE_NGINX_HOME'];
  const nodeOverride = env['STACKMANAGE_NODE_HOME'];
  const nginxRoot =
    nginxOverride !== undefined
      ? assertInside(anchor, absoluteDirectory(nginxOverride, 'STACKMANAGE_NGINX_HOME'), 'STACKMANAGE_NGINX_HOME')
      : join(anchor, 'nginx');
  const nodeRoot =
    nodeOverride !== undefined
      ? assertInside(anchor, absoluteDirectory(nodeOverride, 'STACKMANAGE_NODE_HOME'), 'STACKMANAGE_NODE_HOME')
      : join(anchor, 'node', 'runtime');

  return Object.freeze({
    platform,
    dataRoot,
    anchor,
    caddyRoot: dataRoot,
    nginxRoot,
    nodeRoot,
    stateRoot: join(dataRoot, 'state'),
    source
  });
}
