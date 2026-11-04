import { OperationResultSchema } from '@stackmanage/core';
import type { OperationContext, OperationError, OperationResult } from '@stackmanage/core';

export type ErrorCode = OperationError['code'];
export type ItemStatus = 'completed' | 'failed' | 'skipped' | 'unknown';

export function operationError(code: ErrorCode, messageKey: string, retryable = false): OperationError {
  return { code, messageKey, retryable };
}

export interface ItemOutcomeInput {
  readonly id: string;
  readonly status: ItemStatus;
  readonly error?: OperationError;
}

/**
 * Builds the single terminal result. Status is derived from items so a
 * successful-looking result can never hide a failed or unknown sibling:
 * no items or all completed → completed; all failed/skipped → failed;
 * anything mixed → partial; any unknown → unknown.
 */
export function buildResult(operationId: string, items: readonly ItemOutcomeInput[], warnings: readonly OperationError[] = []): OperationResult {
  const normalizedItems = items.map(item => {
    if (item.status === 'completed' && item.error !== undefined) return { id: item.id, status: item.status };
    if (item.status !== 'completed' && item.error === undefined) {
      return { id: item.id, status: item.status, error: operationError('UNKNOWN', 'error.unspecified') };
    }
    return { id: item.id, status: item.status, ...(item.error === undefined ? {} : { error: item.error }) };
  });
  const statuses = new Set(normalizedItems.map(i => i.status));
  let status: OperationResult['status'];
  if (statuses.has('unknown')) status = 'unknown';
  else if (statuses.size === 0) status = 'completed';
  else if (statuses.has('completed') && (statuses.has('failed') || statuses.has('skipped'))) status = 'partial';
  else if (statuses.has('completed')) status = 'completed';
  else status = 'failed';
  return OperationResultSchema.parse({ operationId, status, items: normalizedItems, warnings: [...warnings] });
}

/** Emits exactly one terminal event. Progress emission is the caller's concern. */
export function emitTerminal(context: OperationContext, result: OperationResult): void {
  context.emit({ type: 'terminal', result });
}

export function unsupportedResult(operationId: string, itemId: string, messageKey: string, warnings: readonly OperationError[] = []): OperationResult {
  return buildResult(operationId, [{ id: itemId, status: 'skipped', error: operationError('NOT_IMPLEMENTED', messageKey) }], warnings);
}
