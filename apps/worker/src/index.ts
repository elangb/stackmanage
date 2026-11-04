import {
  ErrorSchema,
  WorkerManagementRequestSchema,
  WorkerManagementResponseSchema,
  WorkerResponseSchema,
  parseBounded
} from '@stackmanage/core';
import type { ErrorCode, OperationEvent, WorkerManagementResponse, WorkerMethodResult, WorkerResponse } from '@stackmanage/core';
import { caddyModule } from './registry';

/**
 * Forked worker entry.
 *
 * Responsibilities:
 *  - own the vendor child process, the persisted PID/port state and the module facade;
 *  - validate every inbound frame before it reaches the module, so a malformed or
 *    unsolicited message can never start an operation;
 *  - relay `progress` frames while a request is running and answer with exactly one
 *    `result` or `error` frame;
 *  - reconcile a record left by a previous worker at startup, without ever signalling an
 *    unverified PID;
 *  - stop its own children on disconnect so the host can exit cleanly.
 *
 * It deliberately has no knowledge of Electron, windows or renderer state.
 */

const { module } = caddyModule();

const logger = {
  info(event: string, fields: Record<string, unknown> = {}): void {
    if (!process.connected) return;
    // Diagnostics never carry secrets, absolute user paths or vendor output.
    process.stderr.write(`${JSON.stringify({ event, ...redact(fields) })}\n`);
  }
};

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/token|secret|key|password|authorization|path/i.test(key)) continue;
    output[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return output;
}

let reconcile: Promise<void> = Promise.resolve();
try {
  reconcile = module.reconcileOnStartup().then(
    report => {
      logger.info('startup.reconciled', { action: report.action, instanceId: report.instanceId });
    },
    error => {
      logger.info('startup.reconcileFailed', { reason: error instanceof Error ? error.message : 'unknown' });
    }
  );
} catch (error) {
  logger.info('startup.reconcileFailed', { reason: error instanceof Error ? error.message : 'unknown' });
}

/** Operations accepted but not settled yet; also the dedupe map for repeated IDs. */
const inflight = new Map<string, Promise<WorkerMethodResult>>();

function send(frame: WorkerManagementResponse | WorkerResponse): void {
  if (!process.connected) return;
  process.send?.(frame, undefined, undefined, (error: Error | null) => {
    // A failed send means the host is gone; keep the exit code honest but do not throw.
    if (error) process.exitCode = 1;
  });
}

function errorFrame(id: string, code: ErrorCode, messageKey: string, retryable: boolean): WorkerManagementResponse {
  return { apiVersion: 1, id, status: 'error', error: ErrorSchema.parse({ code, messageKey, retryable }) };
}

/**
 * Map an internal failure onto the frozen error contract. Anything unrecognised becomes
 * `UNKNOWN` with a fixed key, so a stack trace or vendor message never reaches the host.
 */
function classify(error: unknown): { code: ErrorCode; messageKey: string; retryable: boolean } {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { code?: unknown; messageKey?: unknown; retryable?: unknown };
    const code = ErrorSchema.shape.code.safeParse(candidate.code);
    if (code.success && typeof candidate.messageKey === 'string' && typeof candidate.retryable === 'boolean') {
      const messageKey = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(candidate.messageKey) ? candidate.messageKey : 'unknown';
      return { code: code.data, messageKey, retryable: candidate.retryable };
    }
  }
  if (error instanceof Error) {
    if (error.message === 'TIMEOUT') return { code: 'TIMEOUT', messageKey: 'operation.timeout', retryable: true };
    if (error.message === 'CONFLICT') return { code: 'CONFLICT', messageKey: 'operation.conflict', retryable: false };
    if (error.message === 'INVALID_REQUEST') return { code: 'INVALID_REQUEST', messageKey: 'invalidRequest', retryable: false };
  }
  return { code: 'UNKNOWN', messageKey: 'operation.failed', retryable: false };
}

/** The operation identity used for dedupe: the caller's ID when the method has one. */
function operationKey(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const frame = input as { id?: unknown; params?: unknown };
  if (typeof frame.id !== 'string') return undefined;
  const params = frame.params;
  if (typeof params === 'object' && params !== null && 'operationId' in params) {
    const operationId = (params as { operationId?: unknown }).operationId;
    if (typeof operationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(operationId)) return operationId;
  }
  return `request:${frame.id}`;
}

async function dispatch(id: string, input: unknown): Promise<void> {
  let request;
  try {
    request = parseBounded(WorkerManagementRequestSchema, input);
  } catch {
    send(errorFrame(id, 'INVALID_REQUEST', 'invalidRequest', false));
    return;
  }

  if (request.method === 'health') {
    send(WorkerResponseSchema.parse({ apiVersion: 1, id: request.id, status: 'ready', pid: process.pid }));
    return;
  }

  const key = operationKey(input) ?? `request:${request.id}`;
  const existing = inflight.get(key);
  if (existing !== undefined) {
    try {
      const result = await existing;
      send(WorkerManagementResponseSchema.parse({ apiVersion: 1, id, status: 'result', result }));
    } catch (error) {
      const failure = classify(error);
      send(errorFrame(id, failure.code, failure.messageKey, failure.retryable));
    }
    return;
  }

  let lastSequence = -1;
  const emit = (event: OperationEvent): void => {
    // Only progress is streamed: the terminal result travels as the `result` frame, so a
    // duplicated terminal event would give the renderer two completion signals.
    if (event.type !== 'progress' || event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    send(WorkerManagementResponseSchema.parse({ apiVersion: 1, id: request.id, status: 'progress', event }));
  };

  const job = (async (): Promise<WorkerMethodResult> => {
    await reconcile;
    return module.handle(request, emit);
  })();
  inflight.set(key, job);
  try {
    const result = await job;
    send(WorkerManagementResponseSchema.parse({ apiVersion: 1, id, status: 'result', result }));
  } catch (error) {
    const failure = classify(error);
    logger.info('operation.failed', { code: failure.code, messageKey: failure.messageKey });
    send(errorFrame(id, failure.code, failure.messageKey, failure.retryable));
  } finally {
    inflight.delete(key);
  }
}

/** Read the envelope ID without validating it, so an invalid frame can still be answered. */
function envelopeId(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const id = (input as { id?: unknown }).id;
  return typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ? id : undefined;
}

process.on('message', (input: unknown) => {
  const id = envelopeId(input);
  // A frame without a usable ID cannot be correlated, so it is dropped rather than guessed.
  if (id === undefined) {
    logger.info('frame.rejected', { reason: 'missing-id' });
    return;
  }
  void dispatch(id, input);
});

process.on('disconnect', () => {
  void module
    .shutdown()
    .catch(() => undefined)
    .finally(() => process.exit(0));
});

process.on('uncaughtException', () => {
  // Never leak a stack trace over IPC; exit so the host reports UNAVAILABLE.
  process.exit(1);
});

process.on('unhandledRejection', () => {
  process.exitCode = 1;
});
