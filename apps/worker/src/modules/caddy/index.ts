import { join } from 'node:path';
import type {
  InstanceRequest,
  InstallRequest,
  LogTailRequest,
  ModuleStorage,
  OperationContext,
  OperationEvent,
  ServiceListView,
  ServiceRequest,
  ServiceState,
  SiteListView,
  SitesApplyRequest,
  WorkerManagementRequest,
  WorkerMethodResult
} from '@stackmanage/core';
import { DEFAULT_INSTANCE_ID } from './manifest';
import { StartupGroupListSchema } from '@stackmanage/core';
import { CaddyInstaller } from './installer';
import { CaddyServiceManager } from './service';
import { CaddySiteManager } from './sites';
import { CaddyCertificates } from './certificates';
import { LinuxHostsManager, createLinuxRunner, createNodeFileSystem } from '@stackmanage/platform';
import { caddyPaths, type Paths } from './paths';
import type { CaddyServiceRecord } from './state';

export interface CaddyModuleOptions {
  storage: ModuleStorage;
  home?: string;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  hostsPath?: string;
  nssDbPath?: string;
  userHome?: string;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

export type Emit = (event: OperationEvent) => void;

function successWorkflowResult(operationId: string, itemId: string): import('@stackmanage/core').OperationResult {
  return { operationId, status: 'completed', items: [{ id: itemId, status: 'completed' }], warnings: [] };
}
function failedWorkflowResult(operationId: string, itemId: string, messageKey: string): import('@stackmanage/core').OperationResult {
  return { operationId, status: 'failed', items: [{ id: itemId, status: 'failed', error: { code: 'INVALID_REQUEST', messageKey, retryable: false } }], warnings: [] };
}
function invalidRefResult(operationId: string, itemId: string): import('@stackmanage/core').OperationResult {
  return failedWorkflowResult(operationId, itemId, 'workflow.serviceUnavailable');
}

const READ_DEADLINE_MS = 5000;

/** Facade the forked worker talks to: one entry point, one terminal result per request. */
export class CaddyModule {
  readonly installer: CaddyInstaller;
  readonly service: CaddyServiceManager;
  readonly sites: CaddySiteManager;
  readonly certificates: CaddyCertificates;
  managed?: { nginx: import('../nginx').NginxModule; redis: import('../redis').RedisModule; php: import('../php').PhpModule };
  private readonly paths: Paths;
  private workflowGroups: import('@stackmanage/core').StartupGroup[] = [];
  private readonly workflowReady: Promise<void>;
  private groupWrites: Promise<void> = Promise.resolve();
  private readonly groupsSchema = StartupGroupListSchema;

  private async persistGroups(): Promise<void> {
    const snapshot = this.groupsSchema.parse(this.workflowGroups);
    const next = this.groupWrites.then(() => this.options.storage.StorageSetAsync('workflow', 'startup-groups', snapshot, this.groupsSchema));
    this.groupWrites = next;
    await next;
  }

  private async runManagedService(ref: import('@stackmanage/core').ServiceRef, action: 'start' | 'stop', operationId: string, emit: Emit): Promise<import('@stackmanage/core').OperationResult> {
    const context = { operationId, signal: new AbortController().signal, emit: (event: OperationEvent) => { if (event.type === 'progress') emit(event); } };
    const request = { operationId, ref, timeoutMs: 30_000 };
    if (ref.moduleId === 'caddy') {
      if (!(await this.service.validateServiceRef(ref))) return invalidRefResult(operationId, ref.instanceId);
      return action === 'start' ? this.service.start(request, context) : this.service.stop(request, context);
    }
    if (!['nginx', 'redis', 'php'].includes(ref.moduleId) || ref.instanceId !== DEFAULT_INSTANCE_ID) return invalidRefResult(operationId, ref.instanceId);
    const service = this.managed?.[ref.moduleId as 'nginx' | 'redis' | 'php'].service;
    if (!service) return { operationId, status: 'failed', items: [{ id: ref.instanceId, status: 'failed', error: { code: 'NOT_IMPLEMENTED', messageKey: 'workflow.serviceUnsupported', retryable: false } }], warnings: [] };
    if (!(await service.validateServiceRef(ref))) return invalidRefResult(operationId, ref.instanceId);
    const response = action === 'start' ? await service.start(request, context) : await service.stop(request, context);
    return response;
  }

  private async validServiceRef(ref: import('@stackmanage/core').ServiceRef): Promise<boolean> {
    if (ref.instanceId !== DEFAULT_INSTANCE_ID) return false;
    if (ref.moduleId === 'caddy') return this.service.validateServiceRef(ref);
    if (!this.managed || !['nginx', 'redis', 'php'].includes(ref.moduleId)) return false;
    return this.managed[ref.moduleId as 'nginx' | 'redis' | 'php'].service.validateServiceRef(ref);
  }

  private async handleWorkflow(request: WorkerManagementRequest, emit: Emit): Promise<WorkerMethodResult> {
    if (request.method === 'workflow.groups.list') { await this.workflowReady; await this.groupWrites; return { method: request.method, data: { groups: this.workflowGroups } }; }
    if (request.method === 'workflow.groups.save') {
      await this.workflowReady;
      const group = request.params as import('@stackmanage/core').StartupGroup;
      const seen = new Set<string>();
      for (const entry of group.entries) {
        if (entry.dependsOn.some(dependency => !seen.has(dependency))) return { method: request.method, data: failedWorkflowResult(request.id, entry.service.instanceId, 'workflow.invalidDependencies') };
        seen.add(entry.service.instanceId);
      }
      for (const entry of group.entries) if (!(await this.validServiceRef(entry.service))) return { method: request.method, data: failedWorkflowResult(request.id, entry.service.instanceId, 'workflow.serviceUnavailable') };
      await this.groupWrites;
      const previous = this.workflowGroups;
      this.workflowGroups = [...previous.filter(item => item.id !== group.id), group];
      try { await this.persistGroups(); } catch { this.workflowGroups = previous; return { method: request.method, data: failedWorkflowResult(request.id, group.id, 'workflow.storageFailed') }; }
      return { method: request.method, data: successWorkflowResult(request.id, group.id) };
    }
    if (request.method === 'workflow.groups.remove') {
      await this.workflowReady;
      const { id } = request.params as { id: string };
      await this.groupWrites;
      const previous = this.workflowGroups;
      this.workflowGroups = previous.filter(item => item.id !== id);
      try { await this.persistGroups(); } catch { this.workflowGroups = previous; return { method: request.method, data: failedWorkflowResult(request.id, id, 'workflow.storageFailed') }; }
      return { method: request.method, data: successWorkflowResult(request.id, id) };
    }
    if (request.method !== 'workflow.groups.run') throw new Error('Unexpected workflow method');
    await this.workflowReady;
    const { id, action, operationId } = request.params as { id: string; action: 'start' | 'stop'; operationId: string };
    const group = this.workflowGroups.find(item => item.id === id);
    if (!group) return { method: request.method, data: failedWorkflowResult(operationId, id, 'workflow.groupNotFound') };
    const entries = action === 'start' ? group.entries : [...group.entries].reverse();
    const items: import('@stackmanage/core').OperationResult['items'] = [];
    const completed = new Set<string>();
    for (const entry of entries) {
      if (action === 'start' && entry.dependsOn.some(dependency => !completed.has(dependency))) {
        items.push({ id: entry.service.instanceId, status: 'skipped', error: { code: 'CONFLICT', messageKey: 'workflow.dependencyFailed', retryable: false } });
        continue;
      }
      const result = await this.runManagedService(entry.service, action, `${operationId}-${entry.service.instanceId}`, emit);
      const outcome = result.items[0];
      if (outcome) items.push({ ...outcome, id: entry.service.instanceId });
      if (outcome?.status === 'completed') completed.add(entry.service.instanceId);
    }
    const status = items.every(item => item.status === 'completed') ? 'completed' : items.some(item => item.status === 'completed') ? 'partial' : 'failed';
    return { method: request.method, data: { operationId, status, items, warnings: [] } };
  }

  constructor(private readonly options: CaddyModuleOptions) {
    this.workflowReady = options.storage.StorageGetAsync('workflow', 'startup-groups', this.groupsSchema).then(groups => { this.workflowGroups = groups ?? []; });
    this.paths = caddyPaths(options.home);
    this.installer = new CaddyInstaller({
      storage: options.storage,
      paths: this.paths,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    });
    this.service = new CaddyServiceManager({
      storage: options.storage,
      paths: this.paths,
      installer: this.installer,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    });
    const platform = options.platform ?? process.platform;
    const hosts = platform === 'linux'
      ? new LinuxHostsManager({
          fs: createNodeFileSystem(),
          runner: createLinuxRunner(process.env),
          ...(options.hostsPath !== undefined ? { hostsPath: options.hostsPath } : {})
        })
      : undefined;
    this.sites = new CaddySiteManager({
      storage: options.storage,
      paths: this.paths,
      installer: this.installer,
      service: this.service,
      ...(hosts !== undefined ? { hosts } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {})
    });
    this.certificates = new CaddyCertificates({
      home: this.paths.home,
      ...(options.nssDbPath !== undefined ? { nssDbPath: options.nssDbPath } : {}),
      ...(options.userHome !== undefined ? { userHome: options.userHome } : {}),
      ...(platform !== undefined ? { platform } : {})
    });
  }

  get home(): string {
    return this.paths.home;
  }

  private context(request: WorkerManagementRequest, emit: Emit): OperationContext {
    const params = 'params' in request ? (request.params as { operationId?: unknown }) : undefined;
    const operationId = typeof params?.operationId === 'string' ? params.operationId : request.id;
    return {
      operationId,
      // Cancellation is not exposed in Phase 1; the signal stays unaborted.
      signal: new AbortController().signal,
      emit: (event: OperationEvent) => {
        if (event.type === 'progress') emit(event);
      }
    };
  }

  async handle(request: WorkerManagementRequest, emit: Emit): Promise<WorkerMethodResult> {
    switch (request.method) {
      case 'install':
        return { method: 'install', data: await this.installer.install(request.params as InstallRequest, this.context(request, emit)) };
      case 'service.start':
      case 'service.stop':
      case 'service.restart': {
        const params = request.params as ServiceRequest;
        const context = this.context(request, emit);
        const data =
          request.method === 'service.start'
            ? await this.service.start(params, context)
            : request.method === 'service.stop'
              ? await this.service.stop(params, context)
              : await this.service.restart(params, context);
        return { method: request.method, data };
      }
      case 'service.status':
        return { method: 'service.status', data: await withDeadline(this.service.status(request.params as InstanceRequest), READ_DEADLINE_MS) };
      case 'services.list':
        return { method: 'services.list', data: (await withDeadline(this.service.list(), READ_DEADLINE_MS)) as ServiceListView };
      case 'workflow.groups.list':
      case 'workflow.groups.save':
      case 'workflow.groups.remove':
      case 'workflow.groups.run':
        return this.handleWorkflow(request, emit);
      case 'installations.list':
        return { method: 'installations.list', data: await withDeadline(this.installer.list(), READ_DEADLINE_MS + 5000) };
      case 'logs.tail': {
        const params = request.params as LogTailRequest;
        return { method: 'logs.tail', data: await withDeadline(this.service.logsTail(params), READ_DEADLINE_MS) };
      }
      case 'certificates.status':
        return { method: 'certificates.status', data: await withDeadline(this.certificates.status(), READ_DEADLINE_MS) };
      case 'certificates.trust':
        return { method: 'certificates.trust', data: await this.certificates.trust(this.context(request, emit)) };
      case 'sites.apply':
        return { method: 'sites.apply', data: await this.sites.apply(request.params as SitesApplyRequest, this.context(request, emit)) };
      case 'sites.list':
        return { method: 'sites.list', data: (await withDeadline(this.sites.list(), READ_DEADLINE_MS)) as SiteListView };
      case 'sites.remove':
        return { method: 'sites.remove', data: await this.sites.remove(request.params as { operationId: string; siteId: string }, this.context(request, emit)) };
      default:
        throw new Error('Unhandled worker method');
    }
  }

  /** Worker lifecycle: stop a previous worker's still-running verified child. Never throws here. */
  async reconcileOnStartup(): Promise<{ action: 'none' | 'stopped' | 'unknown'; instanceId: string }> {
    return this.service.reconcileOnStartup();
  }

  async shutdown(): Promise<void> {
    await this.service.shutdown();
  }

  /** Diagnostics for tests/integration only; never exposed on the IPC wire. */
  async persistedService(): Promise<CaddyServiceRecord | undefined> {
    return this.service.read(DEFAULT_INSTANCE_ID);
  }

  getDataHome(): string {
    return this.paths.home;
  }

  defaultConfigPath(): string {
    return join(this.paths.caddyfiles, `${DEFAULT_INSTANCE_ID}.Caddyfile`);
  }
}

export { DEFAULT_INSTANCE_ID };
export type { ServiceState };

/** Read deadlines become TIMEOUT (unknown), never success. */
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('UNKNOWN'));
      }
    );
  });
}
