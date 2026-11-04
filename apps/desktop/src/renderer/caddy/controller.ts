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
  private readonly tracksProgress = new Set<OperationName>(['install', 'start', 'stop', 'restart', 'sitesApply', 'sitesRemove']);

  constructor(private readonly bridge: () => DesktopBridgeV1) {}

  /** Subscribe at most once; a second call is a no-op so remounts cannot leak listeners. */
  attach(): void {
    if (this.subscription !== undefined) return;
    this.subscription = this.bridge().onOperationEvent(payload => this.onEvent(payload));
  }

  detach(): void {
    this.subscription?.unsubscribe();
    this.subscription = undefined;
  }

  private onEvent(payload: BridgeEventPayload): void {
    // Drop stale or replayed frames; sequence is per operation and monotonic.
    if (payload.sequence <= this.state.lastSequence) return;
    this.state.lastSequence = payload.sequence;
  }

  /** Progress frames carry only sequence numbers on the wire; the stage is local. */
  private begin(operation: OperationName): void {
    this.state.operation = operation;
    this.state.progress = { stage: operation, value: 0 };
    this.state.notice = undefined;
  }

  private finish(notice: Notice | undefined): void {
    this.state.operation = undefined;
    this.state.progress = undefined;
    this.state.notice = notice;
  }

  private run(operation: OperationName, call: () => Promise<BridgeResponse>): Promise<BridgeResponse> {
    const existing = this.inFlight[operation];
    if (existing !== undefined) return existing;
    this.begin(operation);
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
    return this.run('install', () => this.bridge().install(request));
  }

  start(request: ServiceRequest): Promise<BridgeResponse> {
    return this.run('start', () => this.bridge().start(request));
  }

  stop(request: ServiceRequest): Promise<BridgeResponse> {
    return this.run('stop', () => this.bridge().stop(request));
  }

  restart(request: ServiceRequest): Promise<BridgeResponse> {
    return this.run('restart', () => this.bridge().restart(request));
  }

  sitesApply(request: SitesApplyRequest): Promise<BridgeResponse> {
    return this.run('sitesApply', () => this.bridge().sitesApply(request));
  }

  sitesRemove(request: SiteRemoveRequest): Promise<BridgeResponse> {
    return this.run('sitesRemove', () => this.bridge().sitesRemove(request));
  }

  /** Reads are not tracked as operations; they never touch the operation state. */
  status(request: InstanceRequest): Promise<BridgeResponse> {
    return this.bridge().status(request);
  }

  listServices(): Promise<BridgeResponse> {
    return this.bridge().listServices({});
  }

  listInstallations(): Promise<BridgeResponse> {
    return this.bridge().listInstallations({});
  }

  logsTail(request: LogTailRequest): Promise<BridgeResponse> {
    return this.bridge().logsTail(request);
  }

  clearNotice(): void {
    this.state.notice = undefined;
  }
}

export const caddyController = new CaddyController(() => window.stackmanage);
