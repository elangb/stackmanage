/**
 * Module-local singleton for runtime operations. Not a Pinia store: it owns
 * deduplication, progress filtering and the event subscription so a page can
 * unmount without losing or leaking the operation lifecycle.
 */
import { reactiveBind } from '@stackmanage/ui';
import type {
  BridgeEventPayload,
  BridgeResponse,
  DesktopBridgeV1,
  EventSubscriptionHandle,
  OperationResult,
  RuntimeInstallRequest,
  RuntimeUninstallRequest
} from '@stackmanage/core';

export type RuntimeOperation = 'install' | 'uninstall';
export type RuntimeNoticeLevel = 'info' | 'success' | 'error';

export interface RuntimeNotice {
  level: RuntimeNoticeLevel;
  messageKey: string;
}

export interface RuntimeState {
  operation: RuntimeOperation | undefined;
  progress: { stage: string; value: number } | undefined;
  notice: RuntimeNotice | undefined;
  lastSequence: number;
}

const NOTICE_FOR: Record<string, string> = {
  'runtime.digestMismatch': 'runtimeErrorDigestMismatch',
  'runtime.downloadTooLarge': 'runtimeErrorDownloadTooLarge',
  'runtime.downloadFailed': 'runtimeErrorDownloadFailed',
  'runtime.platformUnsupported': 'runtimeErrorPlatformUnsupported',
  'runtime.platformMismatch': 'runtimeErrorPlatformMismatch',
  'runtime.installBusy': 'runtimeErrorBusy',
  'runtime.notInstalled': 'runtimeErrorNotInstalled',
  'runtime.uninstallOutsideManagedRoot': 'runtimeErrorOutsideRoot',
  'runtime.uninstallFailed': 'runtimeErrorUninstallFailed',
  'runtime.checksumMismatch': 'runtimeErrorChecksumMismatch',
  'runtime.checksumListUnavailable': 'runtimeNoticeChecksumListUnavailable',
  'runtime.checksumEntryMissing': 'runtimeNoticeChecksumEntryMissing',
  'runtime.commitFailed': 'runtimeErrorCommitFailed'
};

/** Map a wire error to a stable message key; never surface raw text. */
export function runtimeNoticeFor(error: { code: string; messageKey: string }): RuntimeNotice {
  const known = NOTICE_FOR[error.messageKey];
  if (known !== undefined) return { level: 'error', messageKey: known };
  const byCode: Record<string, string> = {
    TIMEOUT: 'runtimeErrorTimeout',
    UNAVAILABLE: 'runtimeErrorUnavailable',
    CONFLICT: 'runtimeErrorBusy',
    INVALID_REQUEST: 'runtimeErrorInvalidRequest',
    CANCELLED: 'runtimeErrorCancelled',
    FORBIDDEN: 'runtimeErrorForbidden'
  };
  return { level: 'error', messageKey: byCode[error.code] ?? 'runtimeErrorUnknown' };
}

/** Operation results are nested under the method's own key; reads answer with a view. */
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

export class RuntimeController {
  readonly state = reactiveBind<RuntimeState>({ operation: undefined, progress: undefined, notice: undefined, lastSequence: 0 });
  private inFlight: Partial<Record<RuntimeOperation, Promise<BridgeResponse>>> = {};
  private subscription: EventSubscriptionHandle | undefined;
  private activeOperationId: string | undefined;

  constructor(private readonly bridge: () => DesktopBridgeV1) {}

  /** Subscribe at most once; a second call is a no-op so remounts cannot leak listeners. */
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

  private begin(operation: RuntimeOperation, operationId: string): void {
    this.activeOperationId = operationId;
    this.state.operation = operation;
    this.state.progress = { stage: operation, value: 0 };
    this.state.lastSequence = -1;
    this.state.notice = undefined;
  }

  private finish(notice: RuntimeNotice | undefined): void {
    this.activeOperationId = undefined;
    this.state.operation = undefined;
    this.state.progress = undefined;
    this.state.notice = notice;
  }

  private run(operation: RuntimeOperation, operationId: string, call: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
    const existing = this.inFlight[operation];
    if (existing !== undefined) return existing;
    this.begin(operation, operationId);
    const promise = Promise.resolve()
      .then(call)
      .then(response => {
        if (response.ok) {
          const result = extractOperationResult(response.data);
          if (result !== undefined && (result.status === 'failed' || result.status === 'partial')) {
            const first = result.items.find(item => item.error !== undefined)?.error;
            this.finish(first !== undefined ? runtimeNoticeFor(first) : { level: 'error', messageKey: 'runtimeErrorUnknown' });
            return response;
          }
          const warning = result?.warnings[0];
          this.finish(warning !== undefined ? { level: 'info', messageKey: runtimeNoticeFor(warning).messageKey } : undefined);
          return response;
        }
        this.finish(runtimeNoticeFor(response.error));
        return response;
      })
      .catch(() => {
        this.finish({ level: 'error', messageKey: 'runtimeErrorUnknown' });
        return { ok: false, error: { code: 'UNKNOWN', messageKey: 'runtimeErrorUnknown', retryable: true } } satisfies BridgeResponse;
      })
      .finally(() => {
        delete this.inFlight[operation];
      });
    this.inFlight[operation] = promise;
    return promise;
  }

  versions(moduleId = 'node'): Promise<BridgeResponse> {
    return this.tryBridge()?.runtimeVersions(wireInput({ moduleId })) ?? Promise.resolve(this.unavailable());
  }

  status(moduleId = 'node'): Promise<BridgeResponse> {
    return this.tryBridge()?.runtimeStatus(wireInput({ moduleId })) ?? Promise.resolve(this.unavailable());
  }

  list(moduleId = 'node'): Promise<BridgeResponse> {
    return this.tryBridge()?.runtimeList(wireInput({ moduleId })) ?? Promise.resolve(this.unavailable());
  }

  install(request: RuntimeInstallRequest): Promise<BridgeResponse> {
    return this.run('install', request.operationId, () => this.tryBridge()?.runtimeInstall(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  uninstall(request: RuntimeUninstallRequest): Promise<BridgeResponse> {
    return this.run('uninstall', request.operationId, () => this.tryBridge()?.runtimeUninstall(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  clearNotice(): void {
    this.state.notice = undefined;
  }
}

export const runtimeController = new RuntimeController(() => window.stackmanage);
