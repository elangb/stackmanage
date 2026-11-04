/**
 * Module-local singleton for Caddy operations. Not a Pinia store: it outlives the
 * view that starts an operation, deduplicates re-entry, and owns the event
 * subscription so a progress listener is always cleaned up.
 */
import { reactiveBind } from '@stackmanage/ui';
import type {
  BridgeEventPayload,
  BridgeResponse,
  DesktopBridgeV1,
  EventSubscriptionHandle,
  InstallRequest,
  InstanceRequest,
  OperationResult,
  LogTailRequest,
  ServiceRequest,
  SitesApplyRequest,
  SiteRemoveRequest
} from '@stackmanage/core';

export type OperationName = 'install' | 'start' | 'stop' | 'restart' | 'sitesApply' | 'sitesRemove';
export type NoticeLevel = 'info' | 'success' | 'error';

export interface Notice {
  level: NoticeLevel;
  messageKey: string;
}

export interface CaddyState {
  operation: OperationName | undefined;
  progress: { stage: string; value: number } | undefined;
  notice: Notice | undefined;
  lastSequence: number;
}

const NOTICE_FOR: Record<string, string> = {
  'install.digestMismatch': 'caddy.install.digestMismatch',
  'install.downloadTooLarge': 'caddy.install.tooLarge',
  'install.downloadFailed': 'caddy.install.downloadFailed',
  'install.platformUnsupported': 'caddy.install.unsupportedPlatform',
  'service.portInUse': 'caddy.service.portInUse',
  'service.identityMismatch': 'caddy.service.identityMismatch',
  'service.startFailed': 'caddy.service.startFailed',
  'caddy.notInstalled': 'caddy.notInstalled',
  'caddy.restartRequired': 'caddy.restartRequired'
};

/** Map a wire error to a stable message key; never surface raw text. */
export function noticeFor(error: { code: string; messageKey: string }): Notice {
  const known = NOTICE_FOR[error.messageKey];
  if (known !== undefined) return { level: 'error', messageKey: known };
  const byCode: Record<string, string> = {
    TIMEOUT: 'caddy.error.timeout',
    UNAVAILABLE: 'caddy.error.unavailable',
    CONFLICT: 'caddy.error.conflict',
    INVALID_REQUEST: 'caddy.error.invalidRequest',
    CANCELLED: 'caddy.error.cancelled'
  };
  return { level: 'error', messageKey: byCode[error.code] ?? 'caddy.error.unknown' };
}

/** Operation results are nested under the method's own key; reads answer with a view. */
function extractOperationResult(data: unknown): OperationResult | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const nested = (data as { data?: unknown }).data;
  if (typeof nested !== 'object' || nested === null) return undefined;
  return 'items' in nested && 'status' in nested ? (nested as OperationResult) : undefined;
}

export class CaddyController {
  readonly state = reactiveBind<CaddyState>({ operation: undefined, progress: undefined, notice: undefined, lastSequence: 0 });
  private inFlight: Partial<Record<OperationName, Promise<BridgeResponse>>> = {};
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

  /** A missing preload bridge (for example a plain browser preview) is unavailable, not fatal. */
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

  detach(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  private onEvent(payload: BridgeEventPayload): void {
    // Drop events from another operation and stale/replayed frames. Sequences restart per operation.
    if (payload.operationId !== this.activeOperationId) return;
    if (payload.sequence <= this.state.lastSequence) return;
    this.state.lastSequence = payload.sequence;
    const stage = payload.stageKey ?? this.state.operation;
    if (stage !== undefined) this.state.progress = { stage, value: payload.fraction ?? this.state.progress?.value ?? 0 };
  }

  private begin(operation: OperationName, operationId: string): void {
    this.activeOperationId = operationId;
    this.state.operation = operation;
    this.state.progress = { stage: operation, value: 0 };
    this.state.lastSequence = -1;
    this.state.notice = undefined;
  }

  private finish(notice: Notice | undefined): void {
    this.activeOperationId = undefined;
    this.state.operation = undefined;
    this.state.progress = undefined;
    this.state.notice = notice;
  }

  private run(operation: OperationName, operationId: string, call: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
    const existing = this.inFlight[operation];
    if (existing !== undefined) return existing;
    this.begin(operation, operationId);
    const promise = Promise.resolve()
      .then(call)
      .then(response => {
        if (response.ok) {
          // Reads (`status`, `list*`, `logsTail`) answer with a view, not an OperationResult.
          const data: unknown = response.data;
          const result = extractOperationResult(data);
          if (result !== undefined && (result.status === 'failed' || result.status === 'partial')) {
            const first = result.items.find(item => item.error !== undefined)?.error;
            const warning = result.warnings[0];
            this.finish(first !== undefined ? noticeFor(first) : warning !== undefined ? noticeFor(warning) : { level: 'error', messageKey: 'caddy.error.unknown' });
            return response;
          }
          const warning = result?.warnings[0];
          this.finish(warning !== undefined ? noticeFor(warning) : undefined);
          return response;
        }
        this.finish(noticeFor(response.error));
        return response;
      })
      .catch(() => {
        this.finish({ level: 'error', messageKey: 'caddy.error.unknown' });
        return { ok: false, error: { code: 'UNKNOWN', messageKey: 'caddy.error.unknown', retryable: true } } satisfies BridgeResponse;
      })
      .finally(() => {
        delete this.inFlight[operation];
      });
    this.inFlight[operation] = promise;
    return promise;
  }

  install(request: InstallRequest): Promise<BridgeResponse> {
    return this.run('install', request.operationId, () => this.tryBridge()?.install(request) ?? Promise.resolve(this.unavailable()));
  }

  start(request: ServiceRequest): Promise<BridgeResponse> {
    return this.run('start', request.operationId, () => this.tryBridge()?.start(request) ?? Promise.resolve(this.unavailable()));
  }

  stop(request: ServiceRequest): Promise<BridgeResponse> {
    return this.run('stop', request.operationId, () => this.tryBridge()?.stop(request) ?? Promise.resolve(this.unavailable()));
  }

  restart(request: ServiceRequest): Promise<BridgeResponse> {
    return this.run('restart', request.operationId, () => this.tryBridge()?.restart(request) ?? Promise.resolve(this.unavailable()));
  }

  sitesApply(request: SitesApplyRequest): Promise<BridgeResponse> {
    return this.run('sitesApply', request.operationId, () => this.tryBridge()?.sitesApply(request) ?? Promise.resolve(this.unavailable()));
  }

  sitesList(): Promise<BridgeResponse> {
    return this.tryBridge()?.sitesList({}) ?? Promise.resolve(this.unavailable());
  }

  sitesRemove(request: SiteRemoveRequest): Promise<BridgeResponse> {
    return this.run('sitesRemove', request.operationId, () => this.tryBridge()?.sitesRemove(request) ?? Promise.resolve(this.unavailable()));
  }

  /** Reads are not tracked as operations; they never touch the operation state. */
  status(request: InstanceRequest): Promise<BridgeResponse> {
    return this.tryBridge()?.status(request) ?? Promise.resolve(this.unavailable());
  }

  listServices(): Promise<BridgeResponse> {
    return this.tryBridge()?.listServices({}) ?? Promise.resolve(this.unavailable());
  }

  listInstallations(): Promise<BridgeResponse> {
    return this.tryBridge()?.listInstallations({}) ?? Promise.resolve(this.unavailable());
  }

  logsTail(request: LogTailRequest): Promise<BridgeResponse> {
    return this.tryBridge()?.logsTail(request) ?? Promise.resolve(this.unavailable());
  }

  clearNotice(): void {
    this.state.notice = undefined;
  }
}

export const caddyController = new CaddyController(() => window.stackmanage);
