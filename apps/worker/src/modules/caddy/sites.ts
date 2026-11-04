import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleStorage, OperationContext, OperationResult, ServiceState, Site, SitesApplyRequest } from '@stackmanage/core';
import { OperationResultSchema, SiteSchema } from '@stackmanage/core';
import { DEFAULT_INSTANCE_ID, OperationAbortedError, OperationFailure, OperationProgress, failureResult, throwIfAborted } from './manifest';
import { CADDY_MODULE_ID, CaddySiteRecordSchema, STORAGE_KEYS, type CaddyInstallationRecord, type CaddySiteRecord } from './state';
import { atomicWriteFile, isInside, type Paths } from './paths';
import { assertRenderableSite, renderCaddyfile } from './caddyfile';
import { childEnvironment, runCaddy } from './installer';
import type { CaddyServiceManager } from './service';

export interface SiteManagerDeps {
  storage: ModuleStorage;
  paths: Paths;
  installer: { installed(): Promise<CaddyInstallationRecord | undefined> };
  service: Pick<CaddyServiceManager, 'status'>;
  platform?: NodeJS.Platform | string;
}

/**
 * Minimal static-site manager. The full site set is a single generated
 * Caddyfile, so `apply` replaces the set after validating every item. When an
 * item is invalid nothing is written (the set is the required unit) but each
 * item still gets its own outcome with a reason.
 */
export class CaddySiteManager {
  private readonly platform: string;

  constructor(private readonly deps: SiteManagerDeps) {
    this.platform = deps.platform ?? process.platform;
  }

  async list(): Promise<{ sites: Site[] }> {
    const record = await this.deps.storage.StorageGetAsync(CADDY_MODULE_ID, STORAGE_KEYS.sites, CaddySiteRecordSchema);
    return { sites: record?.sites ?? [] };
  }

  async apply(request: SitesApplyRequest, context: OperationContext): Promise<OperationResult> {
    const progress = new OperationProgress(context);
    try {
      const installation = await this.deps.installer.installed();
      if (installation === undefined) throw new OperationFailure('UNAVAILABLE', 'caddy.notInstalled', false);

      const problems = new Map<string, 'site.invalid' | 'site.duplicatePort'>();
      for (const site of request.sites) {
        try {
          assertManagedSite(site, this.deps.paths);
        } catch {
          problems.set(site.id, 'site.invalid');
        }
      }
      const portOwners = new Map<number, string>();
      for (const site of request.sites) {
        const owner = portOwners.get(site.port);
        if (owner !== undefined) {
          problems.set(site.id, 'site.duplicatePort');
          problems.set(owner, 'site.duplicatePort');
        } else {
          portOwners.set(site.port, site.id);
        }
      }
      if (problems.size > 0) {
        const failed = OperationResultSchema.parse({
          operationId: context.operationId,
          status: 'failed',
          items: request.sites.map(site => ({
            id: site.id,
            status: problems.has(site.id) ? 'failed' : 'skipped',
            error: problems.has(site.id)
              ? { code: 'INVALID_REQUEST', messageKey: problems.get(site.id), retryable: false }
              : { code: 'CONFLICT', messageKey: 'site.setRejected', retryable: true }
          })),
          warnings: []
        });
        progress.terminal(failed);
        return failed;
      }

      throwIfAborted(context.signal);
      progress.emit('site.write', 0.4);
      const record: CaddySiteRecord = { sites: [...request.sites].sort((a, b) => a.port - b.port || a.id.localeCompare(b.id)) };
      await this.validateAndWrite(installation, record, context.signal);
      // Roots are created only after the config is accepted; an empty root is valid for file_server.
      for (const site of record.sites) await mkdir(site.root, { recursive: true });

      const warnings: OperationResult['warnings'] = [];
      const state: ServiceState = await this.deps.service.status({ instanceId: DEFAULT_INSTANCE_ID });
      if (state.state === 'running') warnings.push({ code: 'UNAVAILABLE', messageKey: 'caddy.restartRequired', retryable: true });
      const done = OperationResultSchema.parse({
        operationId: context.operationId,
        status: 'completed',
        items: record.sites.map(site => ({ id: site.id, status: 'completed' })),
        warnings
      });
      progress.terminal(done);
      return done;
    } catch (error) {
      const failure = asFailure(error, context.signal);
      const failed = failureResult(context.operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, 'sites');
      progress.terminal(failed);
      return failed;
    }
  }

  async remove(request: { operationId: string; siteId: string }, context: OperationContext): Promise<OperationResult> {
    const progress = new OperationProgress(context);
    try {
      const installation = await this.deps.installer.installed();
      if (installation === undefined) throw new OperationFailure('UNAVAILABLE', 'caddy.notInstalled', false);
      const record = await this.deps.storage.StorageGetAsync(CADDY_MODULE_ID, STORAGE_KEYS.sites, CaddySiteRecordSchema);
      const current = record?.sites ?? [];
      if (!current.some(site => site.id === request.siteId)) {
        const missing = OperationResultSchema.parse({
          operationId: context.operationId,
          status: 'failed',
          items: [{ id: request.siteId, status: 'skipped', error: { code: 'CONFLICT', messageKey: 'site.notFound', retryable: false } }],
          warnings: []
        });
        progress.terminal(missing);
        return missing;
      }
      progress.emit('site.write', 0.4);
      const next: CaddySiteRecord = { sites: current.filter(site => site.id !== request.siteId) };
      await this.validateAndWrite(installation, next, context.signal);
      const warnings: OperationResult['warnings'] = [];
      const state: ServiceState = await this.deps.service.status({ instanceId: DEFAULT_INSTANCE_ID });
      if (state.state === 'running') warnings.push({ code: 'UNAVAILABLE', messageKey: 'caddy.restartRequired', retryable: true });
      const done = OperationResultSchema.parse({
        operationId: context.operationId,
        status: 'completed',
        items: [{ id: request.siteId, status: 'completed' }],
        warnings
      });
      progress.terminal(done);
      return done;
    } catch (error) {
      const failure = asFailure(error, context.signal);
      const failed = failureResult(context.operationId, { code: failure.code, messageKey: failure.messageKey, retryable: failure.retryable }, request.siteId);
      progress.terminal(failed);
      return failed;
    }
  }

  /** Validate the rendered config with the pinned binary, then replace it atomically and persist the set. */
  private async validateAndWrite(installation: CaddyInstallationRecord, record: CaddySiteRecord, signal: AbortSignal): Promise<void> {
    const rendered = renderCaddyfile(record.sites, this.deps.paths.siteRoots);
    throwIfAborted(signal);
    const configPath = join(this.deps.paths.caddyfiles, `${DEFAULT_INSTANCE_ID}.Caddyfile`);
    if (!isInside(this.deps.paths.home, configPath)) throw new OperationFailure('INVALID_REQUEST', 'caddy.unsafePath', false);
    const binary = join(installation.installation.directory, this.platform === 'win32' ? 'caddy.exe' : 'caddy');
    if (!isInside(installation.installation.directory, binary)) throw new OperationFailure('INVALID_REQUEST', 'caddy.unsafePath', false);
    await mkdir(this.deps.paths.caddyfiles, { recursive: true });
    const candidate = `${configPath}.candidate-${Date.now().toString(36)}`;
    await atomicWriteFile(candidate, rendered.content);
    const validation = await runCaddy(binary, ['validate', '--config', candidate, '--adapter', 'caddy'], this.deps.paths.home, 10_000, childEnvironment('validate', this.deps.paths.home));
    if (validation.code !== 0) {
      await rm(candidate, { force: true });
      throw new OperationFailure('INVALID_REQUEST', 'caddy.configInvalid', false);
    }
    await rename(candidate, configPath);
    await this.deps.storage.StorageSetAsync(CADDY_MODULE_ID, STORAGE_KEYS.sites, record, CaddySiteRecordSchema);
  }
}

function asFailure(error: unknown, signal: AbortSignal): OperationFailure {
  if (signal.aborted || error instanceof OperationAbortedError) return new OperationFailure('CANCELLED', 'cancelled', false);
  return error instanceof OperationFailure ? error : new OperationFailure('UNKNOWN', 'unknown', false);
}

function assertManagedSite(site: Site, paths: Paths): void {
  SiteSchema.parse(site);
  if (site.server.moduleId !== CADDY_MODULE_ID) throw new Error('site server must be caddy');
  if (!isInside(paths.siteRoots, site.root)) throw new Error('root outside managed sites directory');
  assertRenderableSite(site, paths.siteRoots);
}
