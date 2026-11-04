import type { CertManager, HostsManager } from '@stackmanage/core';
import { detectPlatform, type Detection } from './detect.js';
import { LinuxHostsManager, type LinuxHostsOptions } from './hosts-linux.js';
import { WindowsHostsManager, type WindowsHostsOptions } from './hosts-windows.js';
import { detectLinuxElevation, type Elevation } from './elevation.js';
import { buildLinuxTrustPlan, parseOsRelease, planWindowsTrust, type TrustPlan } from './trust.js';
import { bindCapability, assessPortRisk, linuxUnprivilegedPortStart, type BindCapabilityState } from './ports-capability.js';
import { LinuxAutostart } from './autostart.js';
import { createNodeFileSystem } from './fs.js';
import { resolveDataRoots, type RootResolution } from './paths.js';
import type { FileSystemPort } from './ports.js';
import type { ProcessRunner } from './command.js';

/** Contract-only certificate manager: every method reports NOT_IMPLEMENTED, never fake success. */
export function unimplementedCertManager(): CertManager {
  const reason = { code: 'NOT_IMPLEMENTED' as const, messageKey: 'cert.notImplemented', retryable: false };
  return {
    list: async () => [],
    issue: async (_hostnames, context) => {
      const result = { operationId: context.operationId, status: 'failed' as const, items: [{ id: 'cert', status: 'failed' as const, error: reason }], warnings: [] };
      context.emit({ type: 'terminal', result });
      return result;
    },
    trust: async context => {
      const result = { operationId: context.operationId, status: 'failed' as const, items: [{ id: 'cert-trust', status: 'failed' as const, error: reason }], warnings: [] };
      context.emit({ type: 'terminal', result });
      return result;
    }
  };
}

export interface PlatformComposition {
  readonly detection: Detection;
  readonly roots: RootResolution;
  readonly hosts?: HostsManager;
  readonly elevation?: () => Promise<Elevation>;
  readonly autostart?: LinuxAutostart;
  readonly trustPlan?: () => Promise<TrustPlan>;
}

export interface CompositionOptions {
  readonly fs?: FileSystemPort;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: ProcessRunner;
  readonly linuxHosts?: Omit<LinuxHostsOptions, 'fs' | 'runner'>;
  readonly windowsHosts?: Omit<WindowsHostsOptions, 'fs' | 'runner'>;
  readonly hostFacts?: { readonly platform: string; readonly arch: string };
}

/**
 * Composition root: wires concrete adapters for the detected platform. On an
 * unsupported platform no host adapter is returned. This factory never
 * executes privileged work; callers obtain plans and opt in explicitly.
 */
export function composePlatform(options: CompositionOptions): PlatformComposition {
  const detection = options.hostFacts ? detectPlatform(options.hostFacts) : detectPlatform({ platform: process.platform, arch: process.arch });
  const fs = options.fs ?? createNodeFileSystem();
  if (!detection.supported) return { detection, roots: { ok: false, reason: detection.reason, missing: [] } };
  const roots = resolveDataRoots(detection.platform, options.env);
  if (detection.platform === 'linux') {
    const elevation = async (): Promise<Elevation> => {
      const hosts = options.linuxHosts;
      return hosts?.elevation ? hosts.elevation() : detectLinuxElevation(options.runner);
    };
    const hosts = new LinuxHostsManager({ fs, runner: options.runner, ...options.linuxHosts });
    const configHome = roots.ok ? roots.roots.config : undefined;
    return {
      detection,
      roots,
      hosts,
      elevation,
      ...(configHome === undefined ? {} : { autostart: new LinuxAutostart(fs, configHome) }),
      trustPlan: async () => {
        const osRelease = await fs.readFile('/etc/os-release').catch(() => '');
        const distro = parseOsRelease(osRelease);
        return buildLinuxTrustPlan({ runner: options.runner, platform: 'linux', distro, elevation });
      }
    };
  }
  const staging = roots.ok ? `${roots.roots.data.replace(/[\\/]+$/, '')}\\helpers` : undefined;
  if (staging === undefined) return { detection, roots };
  return { detection, roots, hosts: new WindowsHostsManager({ fs, runner: options.runner, stagingDirectory: staging, ...options.windowsHosts }) };
}

/** Bind-capability check using real sysctl where available; never prompts or elevates. */
export async function currentBindCapability(fs: FileSystemPort, ports: readonly number[]): Promise<BindCapabilityState> {
  const start = await linuxUnprivilegedPortStart(fs);
  return bindCapability(assessPortRisk(ports, start), undefined);
}

export { planWindowsTrust };
