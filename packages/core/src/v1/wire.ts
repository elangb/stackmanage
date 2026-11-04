import { z } from 'zod';
import { ErrorSchema } from './contracts';
import { SerializedOperationEventSchema } from './operations';

/**
 * JSON-only wire format. Unsupported values are rejected instead of being silently
 * dropped by structured clone, so a caller cannot smuggle a non-JSON payload through.
 */
export function toWireJson(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) => {
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value instanceof Map || value instanceof Set) {
      throw new Error('INVALID_REQUEST');
    }
    return value;
  });
}

/**
 * Main → renderer event envelope. Events are workspace-scoped, not caller-scoped, because
 * the desktop app runs exactly one trusted renderer document; the payload is still the
 * validated operation event, never a raw worker frame.
 */
export const DesktopEventEnvelopeSchema = SerializedOperationEventSchema;
export type DesktopEventEnvelope = z.infer<typeof DesktopEventEnvelopeSchema>;

export const DesktopErrorSchema = ErrorSchema;
