/**
 * Operation primitives shared by worker modules.
 *
 * They are deliberately transport-free: the worker classifies a thrown value by
 * `code`/`messageKey`/`retryable` and never forwards `detail`, a stack trace or a
 * vendor message to the host.
 */
import type { OperationContext, OperationError, OperationEvent, OperationResult } from '@stackmanage/core';

/** Internal failure signal; only `code`/`messageKey`/`retryable` reach the wire. */
export class OperationFailure extends Error {
  constructor(
    readonly code: OperationError['code'],
    readonly messageKey: string,
    readonly retryable: boolean,
    readonly detail?: string
  ) {
    super(messageKey);
    this.name = 'OperationFailure';
  }
}

export class OperationAbortedError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'OperationAbortedError';
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new OperationAbortedError();
}

export function errorOf(error: OperationError): OperationError {
  return { code: error.code, messageKey: error.messageKey, retryable: error.retryable };
}

export function failureResult(operationId: string, error: OperationError, targetId: string): OperationResult {
  return {
    operationId,
    status: 'failed',
    items: [{ id: targetId, status: 'failed', error: errorOf(error) }],
    warnings: []
  };
}

/** Emits progress frames only; the terminal frame is the request's return value. */
export class OperationProgress {
  private sequence = 0;

  constructor(private readonly context: OperationContext) {}

  emit(stageKey: string, fraction: number): void {
    const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    const event: OperationEvent = {
      type: 'progress',
      operationId: this.context.operationId,
      sequence: this.sequence++,
      stageKey,
      fraction: clamped
    };
    this.context.emit(event);
  }

  /** No-op: the worker emits exactly one terminal frame from the dispatch return value. */
  terminal(result: OperationResult): void {
    void result;
  }
}
