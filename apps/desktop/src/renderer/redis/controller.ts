/**
 * Module-local singleton for Redis operations. Not a Pinia store: it owns
 * deduplication, progress filtering and the event subscription so the Databases
 * page can unmount without losing or leaking the operation lifecycle.
 */
import { reactiveBind } from '@stackmanage/ui';
import type {
  BridgeEventPayload,
  BridgeResponse,
  DesktopBridgeV1,
  EventSubscriptionHandle,
  OperationResult,
  RedisInstallRequest,
  RedisLifecycleRequest,
  RedisLogsRequest,
  RedisUninstallRequest
} from '@stackmanage/core';

export type RedisOperation = 'install' | 'uninstall' | 'start' | 'stop';
export type RedisNoticeLevel = 'info' | 'success' | 'error';

export interface RedisNotice {
  level: RedisNoticeLevel;
  messageKey: string;
}

export interface RedisState {
  operation: RedisOperation | undefined;
  progress: { stage: string; value: number } | undefined;
  notice: RedisNotice | undefined;
  lastSequence: number;
}

const NOTICE_FOR: Record<string, string> = {
  'redis.dependenciesMissing': 'redisErrorDependencies',
  'redis.compilerMissing': 'redisErrorDependencies',
  'redis.makeMissing': 'redisErrorDependencies',
  'redis.digestMismatch': 'redisErrorDigestMismatch',
  'redis.downloadTooLarge': 'redisErrorDownloadTooLarge',
  'redis.downloadFailed': 'redisErrorDownloadFailed',
  'redis.archiveTooLarge': 'redisErrorDownloadTooLarge',
  'redis.sourceMissing': 'redisErrorBuild',
  'redis.invalidUrl': 'redisErrorInvalid',
  'redis.invalidDigest': 'redisErrorInvalid',
  'redis.unsafeEntry': 'redisErrorInvalid',
  'redis.unsafePath': 'redisErrorInvalid',
  'redis.commitFailed': 'redisErrorBuild',
  'redis.buildFailed': 'redisErrorBuild',
  'redis.configureFailed': 'redisErrorBuild',
  'redis.installFailed': 'redisErrorBuild',
  'redis.versionMismatch': 'redisErrorVersion',
  'redis.portInUse': 'redisErrorPortInUse',
  'redis.identityMismatch': 'redisErrorIdentity',
  'redis.startFailed': 'redisErrorStartFailed',
  'redis.stopUnconfirmed': 'redisErrorStartFailed',
  'redis.notRunning': 'redisErrorNotRunning',
  'redis.notInstalled': 'redisErrorNotInstalled',
  'redis.uninstallOutsideManagedRoot': 'redisErrorOutsideRoot',
  'redis.uninstallFailed': 'redisErrorUninstallFailed',
  'redis.serviceRunning': 'redisErrorServiceRunning',
  'redis.platformUnsupported': 'redisErrorPlatformUnsupported',
  'redis.platformMismatch': 'redisErrorPlatformMismatch',
  'redis.windowsUnsupported': 'redisErrorWindows',
  'redis.installBusy': 'redisErrorBusy'
};

/** Map a wire error to a stable message key; never surface raw text. */
export function redisNoticeFor(error: { code: string; messageKey: string }): RedisNotice {
  const known = NOTICE_FOR[error.messageKey];
  if (known !== undefined) return { level: 'error', messageKey: known };
  const byCode: Record<string, string> = {
    TIMEOUT: 'redisErrorTimeout',
    UNAVAILABLE: 'redisErrorUnavailable',
    CONFLICT: 'redisErrorBusy',
    INVALID_REQUEST: 'redisErrorInvalid',
    CANCELLED: 'redisErrorCancelled',
    FORBIDDEN: 'redisErrorForbidden',
    NOT_IMPLEMENTED: 'redisErrorPlatformUnsupported'
  };
  return { level: 'error', messageKey: byCode[error.code] ?? 'redisErrorUnknown' };
}

function extractOperationResult(data: unknown): OperationResult | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const nested = (data as { data?: unknown }).data;
  if (typeof nested !== 'object' || nested === null) return undefined;
  return 'items' in nested && 'status' in nested ? (nested as OperationResult) : undefined;
}

/** contextBridge structured-clones arguments, so Vue proxies must become plain JSON first. */
function wireInput<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class RedisController {
  readonly state = reactiveBind<RedisState>({ operation: undefined, progress: undefined, notice: undefined, lastSequence: 0 });
  private inFlight: Partial<Record<RedisOperation, Promise<BridgeResponse>>> = {};
  private subscription: EventSubscriptionHandle | undefined;
  private activeOperationId: string | undefined;

  constructor(private readonly bridge: () => DesktopBridgeV1) {}

  attach(): void {
    if (this.subscription !== undefined) return;
    const bridge = this.tryBridge();
    if (bridge === undefined) return;
    this.subscription = bridge.onOperationEvent(payload => this.onEvent(payload));
  }

  detach(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  private tryBridge(): DesktopBridgeV1 | undefined {
    try {
      return this.bridge();
    } catch {
      return undefined;
    }
  }

  private unavailable(): BridgeResponse {
    return { ok: false, error: { code: 'UNAVAILABLE', messageKey: 'worker.unavailable', retryable: true } };
  }

  private onEvent(payload: BridgeEventPayload): void {
    if (payload.operationId !== this.activeOperationId) return;
    if (payload.sequence <= this.state.lastSequence) return;
    this.state.lastSequence = payload.sequence;
    const stage = payload.stageKey ?? this.state.operation;
    if (stage !== undefined) this.state.progress = { stage, value: payload.fraction ?? this.state.progress?.value ?? 0 };
  }

  private begin(operation: RedisOperation, operationId: string): void {
    this.activeOperationId = operationId;
    this.state.operation = operation;
    this.state.progress = { stage: operation, value: 0 };
    this.state.lastSequence = -1;
    this.state.notice = undefined;
  }

  private finish(notice: RedisNotice | undefined): void {
    this.activeOperationId = undefined;
    this.state.operation = undefined;
    this.state.progress = undefined;
    this.state.notice = notice;
  }

  private run(operation: RedisOperation, operationId: string, call: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
    const existing = this.inFlight[operation];
    if (existing !== undefined) return existing;
    this.begin(operation, operationId);
    const promise = Promise.resolve()
      .then(call)
      .then(response => {
        if (response.ok) {
          const result = extractOperationResult(response.data);
          if (result !== undefined && (result.status === 'failed' || result.status === 'partial' || result.status === 'unknown')) {
            const first = result.items.find(item => item.error !== undefined)?.error;
            const warning = result.warnings[0];
            this.finish(first !== undefined ? redisNoticeFor(first) : warning !== undefined ? redisNoticeFor(warning) : { level: 'error', messageKey: 'redisErrorUnknown' });
            return response;
          }
          const warning = result?.warnings[0];
          this.finish(warning !== undefined ? redisNoticeFor(warning) : undefined);
          return response;
        }
        this.finish(redisNoticeFor(response.error));
        return response;
      })
      .catch(() => {
        this.finish({ level: 'error', messageKey: 'redisErrorUnknown' });
        return { ok: false, error: { code: 'UNKNOWN', messageKey: 'redisErrorUnknown', retryable: true } } satisfies BridgeResponse;
      })
      .finally(() => {
        delete this.inFlight[operation];
      });
    this.inFlight[operation] = promise;
    return promise;
  }

  versions(): Promise<BridgeResponse> {
    return this.tryBridge()?.redisVersions(wireInput({ moduleId: 'redis' })) ?? Promise.resolve(this.unavailable());
  }

  status(): Promise<BridgeResponse> {
    return this.tryBridge()?.redisStatus(wireInput({ moduleId: 'redis' })) ?? Promise.resolve(this.unavailable());
  }

  list(): Promise<BridgeResponse> {
    return this.tryBridge()?.redisList(wireInput({ moduleId: 'redis' })) ?? Promise.resolve(this.unavailable());
  }

  logs(request: RedisLogsRequest): Promise<BridgeResponse> {
    return this.tryBridge()?.redisLogs(wireInput(request)) ?? Promise.resolve(this.unavailable());
  }

  install(request: RedisInstallRequest): Promise<BridgeResponse> {
    return this.run('install', request.operationId, () => this.tryBridge()?.redisInstall(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  uninstall(request: RedisUninstallRequest): Promise<BridgeResponse> {
    return this.run('uninstall', request.operationId, () => this.tryBridge()?.redisUninstall(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  start(request: RedisLifecycleRequest): Promise<BridgeResponse> {
    return this.run('start', request.operationId, () => this.tryBridge()?.redisStart(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  stop(request: RedisLifecycleRequest): Promise<BridgeResponse> {
    return this.run('stop', request.operationId, () => this.tryBridge()?.redisStop(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  clearNotice(): void {
    this.state.notice = undefined;
  }
}

export const redisController = new RedisController(() => window.stackmanage);
