import type { CertManager, HostsManager, ModuleStorage } from '@stackmanage/core';

/** Contract shape retained from Phase 0; implementations are supplied per platform. */
export interface PlatformAdapter {
  readonly platform: 'win32' | 'linux' | 'darwin';
  readonly hosts: HostsManager;
  readonly certificates: CertManager;
  readonly storage: ModuleStorage;
}

/**
 * Phase 1 status. Linux adapters are implemented with unit/behavioural tests;
 * Windows adapters are planning-only and unverified. Nothing here is a claim of
 * end-to-end platform acceptance.
 */
export const platformImplementationStatus = 'partial' as const;

export const platformEvidence = Object.freeze({
  linux: { implemented: ['detection', 'data-roots', 'hosts-direct-write', 'hosts-elevation-plan', 'trust-plan', 'port-bind-plan', 'autostart', 'shell-hooks', 'kill-plan', 'port-probe'], verifiedUnprivileged: true, verifiedPrivileged: false },
  win32: { implemented: ['detection', 'data-roots', 'hosts-plan', 'trust-plan', 'autostart-plan', 'shell-hooks', 'kill-plan'], verifiedUnprivileged: false, verifiedPrivileged: false }
} as const);

export { detectCurrentHost, detectPlatform, type Detection, type HostFacts, type SupportedArchitecture, type SupportedPlatform } from './detect.js';
export { PORTABLE_ROOT_ENV, DATA_ROOT_OVERRIDE_ENV, CACHE_ROOT_OVERRIDE_ENV, RootPaths, resolveDataRoots, type DataRoots, type DataRootSource, type RootResolution } from './paths.js';
export type { Environment, FileSystemPort, PathKind } from './ports.js';
export { createNodeFileSystem, isAbsolutePath, writeFileAtomicWith } from './fs.js';
export type { CommandPlan, CommandSpec, ProcessRunner, RunOptions, RunResult } from './command.js';
export { encodePowerShell, psLiteral, shLiteral, powershellCommand, buildLinuxHostsScript, buildWindowsHostsScript, helperFileName, HOSTS_MARKER_BEGIN, HOSTS_MARKER_END, LINUX_HOSTS_EXIT, WINDOWS_HOSTS_EXIT, WINDOWS_HOSTS_KEY, WINDOWS_HOSTS_VALUE, WINDOWS_HOSTS_FALLBACK, isAbsoluteWindowsPath, type HelperScript } from './scripts.js';
export { parseManagedBlock, mergeManagedBlock, renderBlock, validateEntries, normalizeEntries, isValidAddress, isIpv6, type BlockParse, type EntryValidation, type HostsEntry } from './hosts-block.js';
export { LinuxHostsManager, LINUX_HOSTS_PATH, LINUX_HELPER_DIRECTORY, itemForOutcome, type HostsInspection, type HostsWriteOutcome, type LinuxHostsOptions } from './hosts-linux.js';
export { WindowsHostsManager, WINDOWS_HOSTS_SCRIPT_NAME, windowsHostsPathQuery, type WindowsHostsOptions, type WindowsHostsOutcome, type WindowsHostsPlan } from './hosts-windows.js';
export { detectLinuxElevation, elevateWith, type Elevation, type ElevationKind } from './elevation.js';
export { parseOsRelease, detectDistro, planLinuxTrust, buildLinuxTrustPlan, planWindowsTrust, type DistroIdentity, type LinuxDistroFamily, type TrustPlan, type WindowsTrustResult } from './trust.js';
export { assessPortRisk, bindCapability, linuxUnprivilegedPortStart, parseGetcap, planBindStrategy, PRIVILEGED_PORTS, UNPRIVILEGED_PORT_MIN, type BindCapabilityState, type BindStrategy, type PortRisk } from './ports-capability.js';
export { LinuxAutostart, renderDesktopEntry, parseDesktopExec, desktopExecArgument, planWindowsAutostart, planWindowsAutostartRemoval, autostartPath, WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE, XDG_AUTOSTART_FILE, type AutostartOutcome, type AutostartSpec, type DesktopEntryInput, type RegistryPlan } from './autostart.js';
export { renderHook, renderPosixHook, renderFishHook, renderPowerShellHook, renderCmdHook, parseHook, extractHookBlock, shQuote, shUnquote, fishQuote, fishUnquote, psQuoteDouble, cmdQuote, HOOK_MARKER_BEGIN, HOOK_MARKER_END, HOOK_ENV, type HookResult, type HookShell, type HookSpec, type ShellRoundTrip } from './shell-hooks.js';
export { planLinuxKill, planWindowsKill, describeWindowsJobObject, GRACE_PERIOD_MS, type KillPlan, type KillTarget } from './process-kill.js';
export { probePort, findFreeLoopbackPort, startEphemeralListener, OwnedProcess, LOOPBACK, type PortProbe, type StopResult } from './health.js';
export { buildCapabilityMatrix, availabilityRows, type CapabilityInput, type CapabilityMatrix, type CapabilityStatus, type PlatformCapability } from './capabilities.js';
export { composePlatform, currentBindCapability, unimplementedCertManager, type CompositionOptions, type PlatformComposition } from './composition.js';
export { createLinuxRunner, MAX_CAPTURE_BYTES } from './runner-linux.js';
export { buildResult, emitTerminal, operationError, unsupportedResult, type ItemOutcomeInput, type ItemStatus } from './results.js';
