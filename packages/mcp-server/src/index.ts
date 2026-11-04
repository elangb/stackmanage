import type { McpAuthorizer, McpTool } from '@stackmanage/core';

/** No transport or tool implementation is exposed in Phase 0. */
export const exposedTools: readonly McpTool[] = Object.freeze([]);
export const denyAllAuthorizer: McpAuthorizer = { async authorize() { return false; } };
