import type {
  InstallRequest,
  ModuleStorage,
  OperationContext,
  OperationEvent,
  RuntimeModuleRequest,
  RuntimeUninstallRequest,
  WorkerManagementRequest,
  WorkerMethodResult
} from '@stackmanage/core';
import { NodeInstaller } from './installer';
import { nodePaths, type NodePaths } from './paths';

export interface NodeModuleOptions {
  storage: ModuleStorage;
  home?: string;
  platform?: NodeJS.Platform | string;
  architecture?: string;
  fetchImpl?: typeof fetch;
  logger?: { info(event: string, fields?: Record<string, unknown>): void };
  verifyChecksumList?: boolean;
}

export type Emit = (event: OperationEvent) => void;

const READ_DEADLINE_MS = 5000;

/** Facade for the worker's runtime methods. Node has no service process to own. */
export class NodeModule {
  readonly installer: NodeInstaller;
  private readonly paths: NodePaths;

  constructor(options: NodeModuleOptions) {
    this.paths = nodePaths(options.home);
    this.installer = new NodeInstaller({
      storage: options.storage,
      paths: this.paths,
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.verifyChecksumList !== undefined ? { verifyChecksumList: options.verifyChecksumList } : {})
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
      case 'runtime.versions':
        return { method: 'runtime.versions', data: this.installer.versionsView((request.params as RuntimeModuleRequest).moduleId) };
      case 'runtime.install':
        return { method: 'runtime.install', data: await this.installer.install(request.params as InstallRequest, this.context(request, emit)) };
      case 'runtime.status':
        return { method: 'runtime.status', data: await withDeadline(this.installer.status((request.params as RuntimeModuleRequest).moduleId), READ_DEADLINE_MS) };
      case 'runtime.list':
        return { method: 'runtime.list', data: await withDeadline(this.installer.list((request.params as RuntimeModuleRequest).moduleId), READ_DEADLINE_MS) };
      case 'runtime.uninstall': {
        const params = request.params as RuntimeUninstallRequest;
        return { method: 'runtime.uninstall', data: await this.installer.uninstall(params.installationId, params.operationId, this.context(request, emit)) };
      }
      default:
        throw new Error('Unhandled runtime method');
    }
  }
}

export type { NodePaths };

/** Reads become TIMEOUT (unknown), never a false empty/success view. */
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
