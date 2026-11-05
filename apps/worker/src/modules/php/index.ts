import type {
  ModuleStorage,
  OperationContext,
  OperationEvent,
  PhpInstallRequest,
  PhpLifecycleRequest,
  PhpLogsRequest,
  PhpModuleRequest,
  PhpUninstallRequest,
  WorkerManagementRequest,
  WorkerMethodResult
} from '@stackmanage/core';
import { failureResult } from '../../shared/operation';
import { PhpRuntimeManager } from './runtime';
import { PhpServiceManager } from './service';
import { phpPaths, type PhpPaths } from './paths';

export interface PhpModuleOptions {
  storage: ModuleStorage;
  home?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  /** Development/portable runtime override; never comes from IPC. */
  runtimeOverride?: string;
}

export type Emit = (event: OperationEvent) => void;

const READ_DEADLINE_MS = 5000;

/** Facade for the worker's PHP methods. */
export class PhpModule {
  readonly runtime: PhpRuntimeManager;
  readonly service: PhpServiceManager;
  private readonly paths: PhpPaths;

  constructor(options: PhpModuleOptions) {
    this.paths = phpPaths(options.home);
    this.runtime = new PhpRuntimeManager({
      storage: options.storage,
      paths: this.paths,
      ...(options.runtimeOverride !== undefined ? { runtimeOverride: options.runtimeOverride } : {})
    });
    this.service = new PhpServiceManager({
      storage: options.storage,
      paths: this.paths,
      runtime: this.runtime,
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
      case 'php.versions':
        return { method: 'php.versions', data: this.runtime.versionsView((request.params as PhpModuleRequest).moduleId) };
      case 'php.install':
        return { method: 'php.install', data: await this.runtime.install(request.params as PhpInstallRequest, this.context(request, emit)) };
      case 'php.status':
        return { method: 'php.status', data: await withDeadline(this.service.status((request.params as PhpModuleRequest).moduleId), READ_DEADLINE_MS) };
      case 'php.list':
        return { method: 'php.list', data: await withDeadline(this.runtime.list((request.params as PhpModuleRequest).moduleId), READ_DEADLINE_MS) };
      case 'php.uninstall':
        return { method: 'php.uninstall', data: await this.uninstall(request.params as PhpUninstallRequest, this.context(request, emit)) };
      case 'php.start':
        return { method: 'php.start', data: await this.service.start(request.params as PhpLifecycleRequest, this.context(request, emit)) };
      case 'php.stop':
        return { method: 'php.stop', data: await this.service.stop(request.params as PhpLifecycleRequest, this.context(request, emit)) };
      case 'php.logs':
        return { method: 'php.logs', data: await withDeadline(this.service.logs(request.params as PhpLogsRequest), READ_DEADLINE_MS) };
      default:
        throw new Error('Unhandled PHP method');
    }
  }

  /** Uninstall requires a stopped service: removing a running binary is not supported. */
  private async uninstall(request: PhpUninstallRequest, context: OperationContext) {
    const status = await this.service.status('php');
    const active = status.service.state === 'running' || (status.service.state === 'unknown' && status.service.pid !== undefined);
    if (active) {
      return failureResult(context.operationId, { code: 'CONFLICT', messageKey: 'php.serviceRunning', retryable: true }, request.installationId);
    }
    const result = await this.runtime.uninstall(request.installationId, context.operationId, context);
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

export type { PhpPaths };
