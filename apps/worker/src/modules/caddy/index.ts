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
import { CaddyInstaller } from './installer';
import { CaddyServiceManager } from './service';
import { CaddySiteManager } from './sites';
import { caddyPaths, type Paths } from './paths';
import type { CaddyServiceRecord } from './state';

export interface CaddyModuleOptions {
  storage: ModuleStorage;
  home?: string;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
}

export type Emit = (event: OperationEvent) => void;

const READ_DEADLINE_MS = 5000;

/** Facade the forked worker talks to: one entry point, one terminal result per request. */
export class CaddyModule {
  readonly installer: CaddyInstaller;
  readonly service: CaddyServiceManager;
  readonly sites: CaddySiteManager;
  private readonly paths: Paths;

  constructor(private readonly options: CaddyModuleOptions) {
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
    this.sites = new CaddySiteManager({
      storage: options.storage,
      paths: this.paths,
      installer: this.installer,
      service: this.service,
      ...(options.platform !== undefined ? { platform: options.platform } : {})
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
      case 'installations.list':
        return { method: 'installations.list', data: await withDeadline(this.installer.list(), READ_DEADLINE_MS + 5000) };
      case 'logs.tail': {
        const params = request.params as LogTailRequest;
        return { method: 'logs.tail', data: await withDeadline(this.service.logsTail(params), READ_DEADLINE_MS) };
      }
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
