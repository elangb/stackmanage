import type {
  ModuleStorage,
  OperationContext,
  OperationEvent,
  RedisInstallRequest,
  RedisLifecycleRequest,
  RedisLogsRequest,
  RedisModuleRequest,
  RedisUninstallRequest,
  WorkerManagementRequest,
  WorkerMethodResult
} from '@stackmanage/core';
import { failureResult } from '../../shared/operation';
import { RedisInstaller, type RedisBuildFn, type RedisPreflightFn } from './installer';
import { RedisServiceManager } from './service';
import { redisPaths, type RedisPaths } from './paths';

export interface RedisModuleOptions {
  storage: ModuleStorage;
  home?: string;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  preflight?: RedisPreflightFn;
  build?: RedisBuildFn;
}

export type Emit = (event: OperationEvent) => void;

const READ_DEADLINE_MS = 5000;

/** Facade for the worker's Redis methods. */
export class RedisModule {
  readonly installer: RedisInstaller;
  readonly service: RedisServiceManager;
  private readonly paths: RedisPaths;

  constructor(options: RedisModuleOptions) {
    this.paths = redisPaths(options.home);
    this.installer = new RedisInstaller({
      storage: options.storage,
      paths: this.paths,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.preflight !== undefined ? { preflight: options.preflight } : {}),
      ...(options.build !== undefined ? { build: options.build } : {})
    });
    this.service = new RedisServiceManager({
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
      case 'redis.versions':
        return { method: 'redis.versions', data: this.installer.versionsView((request.params as RedisModuleRequest).moduleId) };
      case 'redis.install':
        return { method: 'redis.install', data: await this.installer.install(request.params as RedisInstallRequest, this.context(request, emit)) };
      case 'redis.status':
        return { method: 'redis.status', data: await withDeadline(this.service.status((request.params as RedisModuleRequest).moduleId), READ_DEADLINE_MS) };
      case 'redis.list':
        return { method: 'redis.list', data: await withDeadline(this.installer.list((request.params as RedisModuleRequest).moduleId), READ_DEADLINE_MS) };
      case 'redis.uninstall':
        return { method: 'redis.uninstall', data: await this.uninstall(request.params as RedisUninstallRequest, this.context(request, emit)) };
      case 'redis.start':
        return { method: 'redis.start', data: await this.service.start(request.params as RedisLifecycleRequest, this.context(request, emit)) };
      case 'redis.stop':
        return { method: 'redis.stop', data: await this.service.stop(request.params as RedisLifecycleRequest, this.context(request, emit)) };
      case 'redis.logs':
        return { method: 'redis.logs', data: await withDeadline(this.service.logs(request.params as RedisLogsRequest), READ_DEADLINE_MS) };
      default:
        throw new Error('Unhandled Redis method');
    }
  }

  /** Uninstall requires a stopped service: removing a running binary is not supported. */
  private async uninstall(request: RedisUninstallRequest, context: OperationContext) {
    const status = await this.service.status('redis');
    const active = status.service.state === 'running' || (status.service.state === 'unknown' && status.service.pid !== undefined);
    if (active) {
      return failureResult(context.operationId, { code: 'CONFLICT', messageKey: 'redis.serviceRunning', retryable: true }, request.installationId);
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

export type { RedisPaths };
