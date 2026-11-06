import { resolve } from 'node:path';
import { z } from 'zod';
import type { OperationContext, OperationResult } from '@stackmanage/core';
import {
  PluginManifestSchema,
  PluginManifestValidationError,
  SUPPORTED_PLUGIN_PERMISSIONS,
  validatePluginManifest,
  type PluginManifest
} from '@stackmanage/plugin-sdk';
import {
  completedResult,
  failedResult,
  normalizePluginError,
  PluginHostError,
  stateWriteWarning
} from './errors';
import { PluginInstaller } from './installer';
import type { TrustedKeyring } from './keys';
import type { PluginPackageLimits } from './package';
import { isInside, pluginDataHome, pluginPaths, resolveWithin, type PluginPaths } from './paths';
import { loadRegistry } from './registry';
import { PluginRuntime, type PluginRuntimeLogger, type PluginRuntimeView } from './runtime';
import type { RegistryEntry } from './registry';
import {
  loadInstalledState,
  saveInstalledState,
  type InstalledPluginRecord,
  type InstalledPluginsFile
} from './state';

export const PluginRuntimeViewSchema = z
  .object({
    state: z.enum(['stopped', 'starting', 'running', 'stopping', 'failed']),
    pid: z.number().int().positive().optional(),
    startedAt: z.iso.datetime().optional(),
    lastHeartbeatAt: z.iso.datetime().optional(),
    failureReason: z.string().min(1).max(100).optional()
  })
  .strict();

export const PluginStatusViewSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.string().min(1).max(80),
    enabled: z.boolean(),
    manifest: PluginManifestSchema,
    runtime: PluginRuntimeViewSchema
  })
  .strict();
export type PluginStatusView = z.infer<typeof PluginStatusViewSchema>;

export interface PluginHostOptions {
  /** Managed plugin root. Defaults to the per-user data directory derived from the environment. */
  readonly root?: string;
  readonly registryIndex?: string;
  readonly trustedKeys: TrustedKeyring;
  /** Host application version checked against each manifest's compatibility window. */
  readonly hostVersion: string;
  readonly requireSignature?: boolean;
  readonly requireSignedRegistry?: boolean;
  readonly packageLimits?: PluginPackageLimits;
  readonly logger?: PluginRuntimeLogger;
  readonly runtime?: {
    readonly handshakeTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
    readonly heartbeatIntervalMs?: number;
    readonly heartbeatTimeoutMs?: number;
    readonly maxMessageBytes?: number;
    readonly maxOutputBytes?: number;
  };
}

/**
 * Local plugin host backend. It owns the managed plugin root, registry verification,
 * installation records and one child process per enabled plugin. It deliberately has no
 * renderer/IPC/UI dependency and never stores state in shared application config.
 */
export class PluginHost {
  private readonly paths: PluginPaths;
  private readonly hostVersion: string;
  private readonly requireSignature: boolean;
  private readonly requireSignedRegistry: boolean;
  private readonly packageLimits: PluginPackageLimits | undefined;
  private readonly logger: PluginRuntimeLogger | undefined;
  private readonly runtimeOptions: PluginHostOptions['runtime'];
  private readonly runtimes = new Map<string, PluginRuntime>();

  constructor(private readonly options: PluginHostOptions) {
    this.paths = pluginPaths({
      root: options.root ?? pluginDataHome(),
      ...(options.registryIndex !== undefined ? { registryIndex: options.registryIndex } : {})
    });
    this.hostVersion = options.hostVersion;
    this.requireSignature = options.requireSignature !== false;
    this.requireSignedRegistry = options.requireSignedRegistry !== false;
    this.packageLimits = options.packageLimits;
    this.logger = options.logger;
    this.runtimeOptions = options.runtime;
  }


  get root(): string {
    return this.paths.root;
  }
  get registryIndexPath(): string { return this.paths.registryIndex; }
  listTrustedKeyIds(): string[] { return this.options.trustedKeys.keyIds(); }

  private async state(): Promise<InstalledPluginsFile> {
    return loadInstalledState(this.paths.stateFile);
  }

  private async findRecord(id: string): Promise<InstalledPluginRecord> {
    const state = await this.state();
    const record = state.plugins.find(item => item.id === id);
    if (record === undefined) throw new PluginHostError('PLUGIN_NOT_FOUND');
    return record;
  }

  private installer(): PluginInstaller {
    return new PluginInstaller({
      paths: this.paths,
      keyring: this.options.trustedKeys,
      hostVersion: this.hostVersion,
      requireSignature: this.requireSignature,
      ...(this.packageLimits !== undefined ? { limits: this.packageLimits } : {})
    });
  }

  private runtimeFor(record: InstalledPluginRecord): PluginRuntime {
    const existing = this.runtimes.get(record.id);
    if (existing !== undefined) return existing;
    const installDir = resolveWithin(this.paths.root, record.installPath);
    if (!isInside(this.paths.installedRoot, installDir)) throw new PluginHostError('FORBIDDEN', 'install-path');
    const entryPath = resolve(installDir, record.manifest.entry);
    if (!isInside(installDir, entryPath)) throw new PluginHostError('FORBIDDEN', 'entry-path');
    const runtime = new PluginRuntime({
      id: record.id,
      entryPath,
      pluginDir: installDir,
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
      ...(this.runtimeOptions?.handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: this.runtimeOptions.handshakeTimeoutMs } : {}),
      ...(this.runtimeOptions?.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.runtimeOptions.requestTimeoutMs } : {}),
      ...(this.runtimeOptions?.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: this.runtimeOptions.heartbeatIntervalMs } : {}),
      ...(this.runtimeOptions?.heartbeatTimeoutMs !== undefined ? { heartbeatTimeoutMs: this.runtimeOptions.heartbeatTimeoutMs } : {}),
      ...(this.runtimeOptions?.maxMessageBytes !== undefined ? { maxMessageBytes: this.runtimeOptions.maxMessageBytes } : {}),
      ...(this.runtimeOptions?.maxOutputBytes !== undefined ? { maxOutputBytes: this.runtimeOptions.maxOutputBytes } : {})
    });
    this.runtimes.set(record.id, runtime);
    return runtime;
  }

  private validateForHost(record: InstalledPluginRecord): void {
    try {
      validatePluginManifest(record.manifest, {
        hostVersion: this.hostVersion,
        requireSignature: this.requireSignature,
        supportedPermissions: SUPPORTED_PLUGIN_PERMISSIONS
      });
    } catch (error) {
      if (error instanceof PluginManifestValidationError) {
        if (error.code === 'UNSUPPORTED_API') throw new PluginHostError('UNSUPPORTED_API');
        if (error.code === 'INCOMPATIBLE_HOST') throw new PluginHostError('INCOMPATIBLE_HOST');
        if (error.code === 'UNSUPPORTED_PERMISSION') throw new PluginHostError('UNSUPPORTED_PERMISSION');
        if (error.code === 'SIGNATURE_REQUIRED') throw new PluginHostError('SIGNATURE_REQUIRED');
        if (error.code === 'INVALID_HOST_VERSION') throw new PluginHostError('INVALID_HOST_VERSION');
      }
      throw new PluginHostError('INVALID_MANIFEST');
    }
  }

  async list(): Promise<PluginManifest[]> {
    return (await this.state()).plugins.map(record => record.manifest);
  }

  async listInstalled(): Promise<PluginStatusView[]> {
    const state = await this.state();
    return state.plugins.map(record => this.statusView(record));
  }

  async listCatalog(): Promise<RegistryEntry[]> {
    return (await loadRegistry(this.paths.registryIndex, {
      keyring: this.options.trustedKeys,
      requireSigned: this.requireSignedRegistry
    })).index.entries;
  }


  async status(id: string): Promise<PluginStatusView> {
    return this.statusView(await this.findRecord(id));
  }

  private statusView(record: InstalledPluginRecord): PluginStatusView {
    const runtime: PluginRuntimeView = this.runtimes.get(record.id)?.view() ?? { state: 'stopped' };
    return {
      id: record.id,
      version: record.version,
      enabled: record.enabled,
      manifest: record.manifest,
      runtime
    };
  }

  /** Install one registry-pinned id/version. Duplicate ids are rejected, never silently upgraded. */
  async install(id: string, version: string, context: OperationContext): Promise<OperationResult> {
    let prepared: Awaited<ReturnType<PluginInstaller['prepare']>> | undefined;
    try {
      const state = await this.state();
      if (state.plugins.some(record => record.id === id)) throw new PluginHostError('DUPLICATE_PLUGIN');
      const registry = await loadRegistry(this.paths.registryIndex, {
        keyring: this.options.trustedKeys,
        requireSigned: this.requireSignedRegistry
      });
      prepared = await this.installer().prepare(registry, id, version, state.plugins);
      await prepared.promote();

      const record: InstalledPluginRecord = {
        id: prepared.manifest.id,
        version: prepared.manifest.version,
        manifest: prepared.manifest,
        installPath: `installed/${prepared.manifest.id}/${prepared.manifest.version}`,
        installedAt: new Date().toISOString(),
        enabled: false
      };
      const next: InstalledPluginsFile = { schemaVersion: 1, plugins: [...state.plugins, record] };
      try {
        await saveInstalledState(this.paths.stateFile, next);
      } catch (error) {
        await prepared.cleanup();
        throw error;
      }
      prepared = undefined;
      return completedResult(context.operationId, id);
    } catch (error) {
      if (prepared !== undefined) await prepared.cleanup();
      return failedResult(context.operationId, id, normalizePluginError(error, context.signal));
    }
  }

  /**
   * Enable and start the plugin child. Idempotent when already running. The state record
   * is only marked enabled after the handshake succeeds.
   */
  async enable(id: string, context: OperationContext): Promise<OperationResult> {
    try {
      const state = await this.state();
      const record = state.plugins.find(item => item.id === id);
      if (record === undefined) throw new PluginHostError('PLUGIN_NOT_FOUND');
      this.validateForHost(record);
      const runtime = this.runtimeFor(record);
      if (runtime.view().state === 'running') return completedResult(context.operationId, id);

      await runtime.start();
      const next: InstalledPluginsFile = {
        schemaVersion: 1,
        plugins: state.plugins.map(item => (item.id === id ? { ...item, enabled: true } : item))
      };
      try {
        await saveInstalledState(this.paths.stateFile, next);
      } catch (error) {
        await runtime.stop().catch(() => undefined);
        throw error;
      }
      return completedResult(context.operationId, id);
    } catch (error) {
      return failedResult(context.operationId, id, normalizePluginError(error, context.signal));
    }
  }

  /** Disable and stop the child. A failed state write is reported as a warning after the process stopped. */
  async disable(id: string, context: OperationContext): Promise<OperationResult> {
    try {
      const state = await this.state();
      const record = state.plugins.find(item => item.id === id);
      if (record === undefined) throw new PluginHostError('PLUGIN_NOT_FOUND');
      const runtime = this.runtimes.get(id);
      await runtime?.stop();
      this.runtimes.delete(id);

      const next: InstalledPluginsFile = {
        schemaVersion: 1,
        plugins: state.plugins.map(item => (item.id === id ? { ...item, enabled: false } : item))
      };
      try {
        await saveInstalledState(this.paths.stateFile, next);
      } catch {
        // The process is already stopped; report the persisted-state failure without
        // pretending the plugin is still running or replaying a mutation.
        return completedResult(context.operationId, id, [stateWriteWarning()]);
      }
      return completedResult(context.operationId, id);
    } catch (error) {
      return failedResult(context.operationId, id, normalizePluginError(error, context.signal));
    }
  }

  /** Remove an installed plugin. It must be disabled first; removal is recorded before cleanup. */
  async remove(id: string, context: OperationContext): Promise<OperationResult> {
    try {
      const state = await this.state();
      const record = state.plugins.find(item => item.id === id);
      if (record === undefined) throw new PluginHostError('PLUGIN_NOT_FOUND');
      const runtime = this.runtimes.get(id);
      if (runtime !== undefined && runtime.view().state !== 'stopped' && runtime.view().state !== 'failed') {
        throw new PluginHostError('PLUGIN_ENABLED');
      }
      await runtime?.stop().catch(() => undefined);
      this.runtimes.delete(id);

      const removal = await this.installer().stageRemoval(record);
      const next: InstalledPluginsFile = { schemaVersion: 1, plugins: state.plugins.filter(item => item.id !== id) };
      try {
        await saveInstalledState(this.paths.stateFile, next);
      } catch (error) {
        await removal.restore();
        throw error;
      }
      let warnings: OperationResult['warnings'] = [];
      try {
        await removal.finalize();
      } catch {
        warnings = [stateWriteWarning()];
      }
      return completedResult(context.operationId, id, warnings);
    } catch (error) {
      return failedResult(context.operationId, id, normalizePluginError(error, context.signal));
    }
  }

  /** Read-only probe. No filesystem, network, shell or exec API exists here. */
  async ping(id: string): Promise<unknown> {
    await this.findRecord(id);
    const runtime = this.runtimes.get(id);
    if (runtime === undefined || runtime.view().state !== 'running') throw new PluginHostError('PLUGIN_NOT_RUNNING');
    return runtime.ping();
  }

  async probeStatus(id: string): Promise<unknown> {
    await this.findRecord(id);
    const runtime = this.runtimes.get(id);
    if (runtime === undefined || runtime.view().state !== 'running') throw new PluginHostError('PLUGIN_NOT_RUNNING');
    return runtime.status();
  }

  /** Stop every child without rewriting enabled records; the next host can enable them again. */
  async shutdown(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(runtimes.map(runtime => runtime.stop()));
  }
}
