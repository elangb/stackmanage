/**
 * Module-local singleton for the PHP runtime. It owns deduplication, progress
 * filtering and the event subscription so the Runtimes page can unmount without
 * leaking an operation.
 */
import { reactiveBind } from '@stackmanage/ui';
import type {
  BridgeEventPayload,
  BridgeResponse,
  DesktopBridgeV1,
  EventSubscriptionHandle,
  OperationResult,
  PhpInstallRequest,
  PhpLifecycleRequest,
  PhpLogsRequest,
  PhpUninstallRequest
} from '@stackmanage/core';

export type PhpOperation = 'install' | 'uninstall' | 'start' | 'stop';
export type PhpNoticeLevel = 'info' | 'success' | 'error';

export interface PhpNotice {
  level: PhpNoticeLevel;
  messageKey: string;
}

export interface PhpState {
  operation: PhpOperation | undefined;
  progress: { stage: string; value: number } | undefined;
  notice: PhpNotice | undefined;
  lastSequence: number;
}

const NOTICE_FOR: Record<string, string> = {
  'php.moduleUnsupported': 'phpErrorUnsupported',
  'php.platformUnsupported': 'phpErrorUnsupported',
  'php.versionUnsupported': 'phpErrorUnsupported',
  'php.runtimeMissing': 'phpErrorRuntime',
  'php.versionMismatch': 'phpErrorVersion',
  'php.notInstalled': 'phpErrorNotInstalled',
  'php.configInvalid': 'phpErrorConfig',
  'php.portInUse': 'phpErrorPortInUse',
  'php.identityMismatch': 'phpErrorIdentity',
  'php.identityUnavailable': 'phpErrorIdentity',
  'php.startFailed': 'phpErrorStartFailed',
  'php.stopUnconfirmed': 'phpErrorStartFailed',
  'php.operationBusy': 'phpErrorBusy',
  'php.serviceRunning': 'phpErrorServiceRunning',
  'php.uninstallOutsideManagedRoot': 'phpErrorOutsideRoot',
  'php.installationNotFound': 'phpErrorNotInstalled',
  'php.unsafePath': 'phpErrorInvalid'
};

export function phpNoticeFor(error: { code: string; messageKey: string }): PhpNotice {
  const known = NOTICE_FOR[error.messageKey];
  if (known !== undefined) return { level: 'error', messageKey: known };
  const byCode: Record<string, string> = {
    TIMEOUT: 'phpErrorTimeout',
    UNAVAILABLE: 'phpErrorUnavailable',
    CONFLICT: 'phpErrorBusy',
    INVALID_REQUEST: 'phpErrorInvalid',
    CANCELLED: 'phpErrorCancelled',
    FORBIDDEN: 'phpErrorForbidden',
    NOT_IMPLEMENTED: 'phpErrorUnsupported'
  };
  return { level: 'error', messageKey: byCode[error.code] ?? 'phpErrorUnknown' };
}

function extractOperationResult(data: unknown): OperationResult | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const nested = (data as { data?: unknown }).data;
  if (typeof nested !== 'object' || nested === null) return undefined;
  return 'items' in nested && 'status' in nested ? (nested as OperationResult) : undefined;
}

function wireInput<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class PhpController {
  readonly state = reactiveBind<PhpState>({ operation: undefined, progress: undefined, notice: undefined, lastSequence: 0 });
  private inFlight: Partial<Record<PhpOperation, Promise<BridgeResponse>>> = {};
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

  private begin(operation: PhpOperation, operationId: string): void {
    this.activeOperationId = operationId;
    this.state.operation = operation;
    this.state.progress = { stage: operation, value: 0 };
    this.state.lastSequence = -1;
    this.state.notice = undefined;
  }

  private finish(notice: PhpNotice | undefined): void {
    this.activeOperationId = undefined;
    this.state.operation = undefined;
    this.state.progress = undefined;
    this.state.notice = notice;
  }

  private run(operation: PhpOperation, operationId: string, call: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
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
            this.finish(first !== undefined ? phpNoticeFor(first) : { level: 'error', messageKey: 'phpErrorUnknown' });
            return response;
          }
          const warning = result?.warnings[0];
          this.finish(warning !== undefined ? { level: 'info', messageKey: phpNoticeFor(warning).messageKey } : undefined);
          return response;
        }
        this.finish(phpNoticeFor(response.error));
        return response;
      })
      .catch(() => {
        this.finish({ level: 'error', messageKey: 'phpErrorUnknown' });
        return { ok: false, error: { code: 'UNKNOWN', messageKey: 'phpErrorUnknown', retryable: true } } satisfies BridgeResponse;
      })
      .finally(() => {
        delete this.inFlight[operation];
      });
    this.inFlight[operation] = promise;
    return promise;
  }

  versions(): Promise<BridgeResponse> {
    return this.tryBridge()?.phpVersions(wireInput({ moduleId: 'php' })) ?? Promise.resolve(this.unavailable());
  }

  status(): Promise<BridgeResponse> {
    return this.tryBridge()?.phpStatus(wireInput({ moduleId: 'php' })) ?? Promise.resolve(this.unavailable());
  }

  list(): Promise<BridgeResponse> {
    return this.tryBridge()?.phpList(wireInput({ moduleId: 'php' })) ?? Promise.resolve(this.unavailable());
  }

  logs(request: PhpLogsRequest): Promise<BridgeResponse> {
    return this.tryBridge()?.phpLogs(wireInput(request)) ?? Promise.resolve(this.unavailable());
  }

  install(request: PhpInstallRequest): Promise<BridgeResponse> {
    return this.run('install', request.operationId, () => this.tryBridge()?.phpInstall(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  uninstall(request: PhpUninstallRequest): Promise<BridgeResponse> {
    return this.run('uninstall', request.operationId, () => this.tryBridge()?.phpUninstall(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  start(request: PhpLifecycleRequest): Promise<BridgeResponse> {
    return this.run('start', request.operationId, () => this.tryBridge()?.phpStart(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  stop(request: PhpLifecycleRequest): Promise<BridgeResponse> {
    return this.run('stop', request.operationId, () => this.tryBridge()?.phpStop(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  clearNotice(): void {
    this.state.notice = undefined;
  }
}

export const phpController = new PhpController(() => window.stackmanage);
