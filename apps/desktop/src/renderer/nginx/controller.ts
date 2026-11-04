/**
 * Module-local singleton for Nginx operations. Not a Pinia store: it owns
 * deduplication, progress filtering and the event subscription so the Web page
 * can unmount without losing or leaking the operation lifecycle.
 */
import { reactiveBind } from '@stackmanage/ui';
import type {
  BridgeEventPayload,
  BridgeResponse,
  DesktopBridgeV1,
  EventSubscriptionHandle,
  NginxInstallRequest,
  NginxLifecycleRequest,
  NginxLogsRequest,
  NginxUninstallRequest,
  OperationResult
} from '@stackmanage/core';

export type NginxOperation = 'install' | 'uninstall' | 'start' | 'stop' | 'reload';
export type NginxNoticeLevel = 'info' | 'success' | 'error';

export interface NginxNotice {
  level: NginxNoticeLevel;
  messageKey: string;
}

export interface NginxState {
  operation: NginxOperation | undefined;
  progress: { stage: string; value: number } | undefined;
  notice: NginxNotice | undefined;
  lastSequence: number;
}

const NOTICE_FOR: Record<string, string> = {
  'nginx.dependenciesMissing': 'nginxErrorDependencies',
  'nginx.compilerMissing': 'nginxErrorDependencies',
  'nginx.makeMissing': 'nginxErrorDependencies',
  'nginx.headerPcre2Missing': 'nginxErrorDependencies',
  'nginx.headerZlibMissing': 'nginxErrorDependencies',
  'nginx.headerOpenSslMissing': 'nginxErrorDependencies',
  'nginx.digestMismatch': 'nginxErrorDigestMismatch',
  'nginx.downloadTooLarge': 'nginxErrorDownloadTooLarge',
  'nginx.downloadFailed': 'nginxErrorDownloadFailed',
  'nginx.signatureInvalid': 'nginxErrorSignature',
  'nginx.signatureKeyMismatch': 'nginxErrorSignature',
  'nginx.configureFailed': 'nginxErrorConfigure',
  'nginx.buildFailed': 'nginxErrorBuild',
  'nginx.installFailed': 'nginxErrorBuild',
  'nginx.versionMismatch': 'nginxErrorVersion',
  'nginx.configInvalid': 'nginxErrorConfigInvalid',
  'nginx.portInUse': 'nginxErrorPortInUse',
  'nginx.identityMismatch': 'nginxErrorIdentity',
  'nginx.startFailed': 'nginxErrorStartFailed',
  'nginx.notRunning': 'nginxErrorNotRunning',
  'nginx.reloadFailed': 'nginxErrorReloadFailed',
  'nginx.notInstalled': 'nginxErrorNotInstalled',
  'nginx.uninstallOutsideManagedRoot': 'nginxErrorOutsideRoot',
  'nginx.uninstallFailed': 'nginxErrorUninstallFailed',
  'nginx.serviceRunning': 'nginxErrorServiceRunning',
  'nginx.platformUnsupported': 'nginxErrorPlatformUnsupported',
  'nginx.platformMismatch': 'nginxErrorPlatformMismatch',
  'nginx.windowsUnsupported': 'nginxErrorWindows',
  'nginx.installBusy': 'nginxErrorBusy',
  'nginx.signatureUnavailable': 'nginxNoticeSignatureUnavailable'
};

/** Map a wire error to a stable message key; never surface raw text. */
export function nginxNoticeFor(error: { code: string; messageKey: string }): NginxNotice {
  const known = NOTICE_FOR[error.messageKey];
  if (known !== undefined) {
    return { level: error.messageKey === 'nginx.signatureUnavailable' ? 'info' : 'error', messageKey: known };
  }
  const byCode: Record<string, string> = {
    TIMEOUT: 'nginxErrorTimeout',
    UNAVAILABLE: 'nginxErrorUnavailable',
    CONFLICT: 'nginxErrorBusy',
    INVALID_REQUEST: 'nginxErrorInvalid',
    CANCELLED: 'nginxErrorCancelled',
    FORBIDDEN: 'nginxErrorForbidden',
    NOT_IMPLEMENTED: 'nginxErrorPlatformUnsupported'
  };
  return { level: 'error', messageKey: byCode[error.code] ?? 'nginxErrorUnknown' };
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

export class NginxController {
  readonly state = reactiveBind<NginxState>({ operation: undefined, progress: undefined, notice: undefined, lastSequence: 0 });
  private inFlight: Partial<Record<NginxOperation, Promise<BridgeResponse>>> = {};
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

  private begin(operation: NginxOperation, operationId: string): void {
    this.activeOperationId = operationId;
    this.state.operation = operation;
    this.state.progress = { stage: operation, value: 0 };
    this.state.lastSequence = -1;
    this.state.notice = undefined;
  }

  private finish(notice: NginxNotice | undefined): void {
    this.activeOperationId = undefined;
    this.state.operation = undefined;
    this.state.progress = undefined;
    this.state.notice = notice;
  }

  private run(operation: NginxOperation, operationId: string, call: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
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
            this.finish(first !== undefined ? nginxNoticeFor(first) : warning !== undefined ? nginxNoticeFor(warning) : { level: 'error', messageKey: 'nginxErrorUnknown' });
            return response;
          }
          const warning = result?.warnings[0];
          this.finish(warning !== undefined ? nginxNoticeFor(warning) : undefined);
          return response;
        }
        this.finish(nginxNoticeFor(response.error));
        return response;
      })
      .catch(() => {
        this.finish({ level: 'error', messageKey: 'nginxErrorUnknown' });
        return { ok: false, error: { code: 'UNKNOWN', messageKey: 'nginxErrorUnknown', retryable: true } } satisfies BridgeResponse;
      })
      .finally(() => {
        delete this.inFlight[operation];
      });
    this.inFlight[operation] = promise;
    return promise;
  }

  versions(): Promise<BridgeResponse> {
    return this.tryBridge()?.nginxVersions(wireInput({ moduleId: 'nginx' })) ?? Promise.resolve(this.unavailable());
  }

  status(): Promise<BridgeResponse> {
    return this.tryBridge()?.nginxStatus(wireInput({ moduleId: 'nginx' })) ?? Promise.resolve(this.unavailable());
  }

  list(): Promise<BridgeResponse> {
    return this.tryBridge()?.nginxList(wireInput({ moduleId: 'nginx' })) ?? Promise.resolve(this.unavailable());
  }

  logs(request: NginxLogsRequest): Promise<BridgeResponse> {
    return this.tryBridge()?.nginxLogs(wireInput(request)) ?? Promise.resolve(this.unavailable());
  }

  config(): Promise<BridgeResponse> {
    return this.tryBridge()?.nginxConfig(wireInput({})) ?? Promise.resolve(this.unavailable());
  }

  install(request: NginxInstallRequest): Promise<BridgeResponse> {
    return this.run('install', request.operationId, () => this.tryBridge()?.nginxInstall(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  uninstall(request: NginxUninstallRequest): Promise<BridgeResponse> {
    return this.run('uninstall', request.operationId, () => this.tryBridge()?.nginxUninstall(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  start(request: NginxLifecycleRequest): Promise<BridgeResponse> {
    return this.run('start', request.operationId, () => this.tryBridge()?.nginxStart(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  stop(request: NginxLifecycleRequest): Promise<BridgeResponse> {
    return this.run('stop', request.operationId, () => this.tryBridge()?.nginxStop(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  reload(request: NginxLifecycleRequest): Promise<BridgeResponse> {
    return this.run('reload', request.operationId, () => this.tryBridge()?.nginxReload(wireInput(request)) ?? Promise.resolve(this.unavailable()));
  }

  clearNotice(): void {
    this.state.notice = undefined;
  }
}

export const nginxController = new NginxController(() => window.stackmanage);
