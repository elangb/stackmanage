import type {
  NginxConfigRequest,
  NginxInstallRequest,
  NginxLifecycleRequest,
  NginxLogsRequest,
  NginxModuleRequest,
  NginxUninstallRequest,
  ModuleStorage,
  OperationContext,
  OperationEvent,
  WorkerManagementRequest,
  WorkerMethodResult
} from '@stackmanage/core';
import { failureResult } from '../../shared/operation';
import { NginxInstaller, type NginxBuildFn, type NginxPreflightFn } from './installer';
import { NginxServiceManager } from './service';
import { nginxPaths, type NginxPaths } from './paths';

export interface NginxModuleOptions {
  storage: ModuleStorage;
  home?: string;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  verifySignatures?: boolean;
  preflight?: NginxPreflightFn;
  build?: NginxBuildFn;
}

export type Emit = (event: OperationEvent) => void;

const READ_DEADLINE_MS = 5000;

/** Facade for the worker's Nginx methods. */
export class NginxModule {
  readonly installer: NginxInstaller;
  readonly service: NginxServiceManager;
  private readonly paths: NginxPaths;

  constructor(options: NginxModuleOptions) {
    this.paths = nginxPaths(options.home);
    this.installer = new NginxInstaller({
      storage: options.storage,
      paths: this.paths,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.verifySignatures !== undefined ? { verifySignatures: options.verifySignatures } : {}),
      ...(options.preflight !== undefined ? { preflight: options.preflight } : {}),
      ...(options.build !== undefined ? { build: options.build } : {})
    });
    this.service = new NginxServiceManager({
      storage: options.storage,
      paths: this.paths,
      installer: this.installer,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {})
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
      signal: new AbortController().signal,
      emit: (event: OperationEvent) => {
        if (event.type === 'progress') emit(event);
      }
    };
  }

  async handle(request: WorkerManagementRequest, emit: Emit): Promise<WorkerMethodResult> {
    switch (request.method) {
      case 'nginx.versions':
        return { method: 'nginx.versions', data: this.installer.versionsView((request.params as NginxModuleRequest).moduleId) };
      case 'nginx.install':
        return { method: 'nginx.install', data: await this.installer.install(request.params as NginxInstallRequest, this.context(request, emit)) };
      case 'nginx.status':
        return { method: 'nginx.status', data: await withDeadline(this.service.status((request.params as NginxModuleRequest).moduleId), READ_DEADLINE_MS) };
      case 'nginx.list':
        return { method: 'nginx.list', data: await withDeadline(this.installer.list((request.params as NginxModuleRequest).moduleId), READ_DEADLINE_MS) };
      case 'nginx.uninstall':
        return { method: 'nginx.uninstall', data: await this.uninstall(request.params as NginxUninstallRequest, this.context(request, emit)) };
      case 'nginx.start':
        return { method: 'nginx.start', data: await this.service.start(request.params as NginxLifecycleRequest, this.context(request, emit)) };
      case 'nginx.stop':
        return { method: 'nginx.stop', data: await this.service.stop(request.params as NginxLifecycleRequest, this.context(request, emit)) };
      case 'nginx.reload':
        return { method: 'nginx.reload', data: await this.service.reload(request.params as NginxLifecycleRequest, this.context(request, emit)) };
      case 'nginx.logs':
        return { method: 'nginx.logs', data: await withDeadline(this.service.logs(request.params as NginxLogsRequest), READ_DEADLINE_MS) };
      case 'nginx.config':
        return { method: 'nginx.config', data: await withDeadline(this.service.config(), READ_DEADLINE_MS) };
      default:
        throw new Error('Unhandled Nginx method');
    }
  }

  /** Uninstall requires a stopped service: removing a running binary is not supported. */
  private async uninstall(request: NginxUninstallRequest, context: OperationContext) {
    const status = await this.service.status('nginx');
    const active = status.service.state === 'running' || (status.service.state === 'unknown' && status.service.pid !== undefined);
    if (active) {
      return failureResult(context.operationId, { code: 'CONFLICT', messageKey: 'nginx.serviceRunning', retryable: true }, request.installationId);
    }
    const result = await this.installer.uninstall(request.installationId, context.operationId, context);
    if (result.status === 'completed') await this.service.reset();
    return result;
  }

  reconcileOnStartup(): Promise<{ action: 'none' | 'stopped' | 'unknown'; instanceId: string }> {
    return this.service.reconcileOnStartup();
  }

  shutdown(): Promise<void> {
    return this.service.shutdown();
  }
}

/** Reads become TIMEOUT (unknown), never a false empty/success view. */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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

export type { NginxConfigRequest, NginxPaths };
