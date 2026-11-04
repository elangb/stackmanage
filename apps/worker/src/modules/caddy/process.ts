/**
 * Compatibility re-export. The primitives are module-agnostic and now live in
 * `shared/process` so every service module uses one identity/lifecycle policy.
 */
import { join } from 'node:path';

export * from '../../shared/process';

/** Caddy keeps its executable name policy in its own module. */
export function binaryPath(installDir: string, platform: string): string {
  return join(installDir, platform === 'win32' ? 'caddy.exe' : 'caddy');
}
