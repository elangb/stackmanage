import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DataRootConfigError } from '../data/roots.js';
import { ReadFailure } from '../data/read.js';

export interface ToolErrorBody {
  readonly code: string;
  readonly message: string;
}

function text(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: `${JSON.stringify(payload, null, 2)}\n` }] };
}

export function ok(tool: string, data: Record<string, unknown>): CallToolResult {
  return text({ ok: true, tool, ...data });
}

export function fail(tool: string, error: ToolErrorBody): CallToolResult {
  return { ...text({ ok: false, tool, error }), isError: true };
}

function normalize(error: unknown): ToolErrorBody {
  if (error instanceof ReadFailure) {
    if (error.code === 'PATH_REJECTED') return { code: 'PATH_REJECTED', message: 'The requested resource is outside the managed data root.' };
    if (error.code === 'NOT_A_FILE') return { code: 'INVALID_STATE', message: 'The expected state resource is not a regular file.' };
    return { code: 'UNREADABLE', message: 'The state resource could not be read.' };
  }
  if (error instanceof DataRootConfigError) return { code: 'CONFIG_ERROR', message: 'The configured data root is invalid.' };
  return { code: 'INTERNAL', message: 'The request failed without exposing internal details.' };
}

/** Every handler returns a JSON text result; stack traces and raw OS errors never cross the MCP boundary. */
export async function runTool(tool: string, run: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(tool, await run());
  } catch (error) {
    return fail(tool, normalize(error));
  }
}
