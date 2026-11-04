import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MODULE_CATALOG } from '../data/catalog.js';
import { runTool } from './common.js';

export function modulesListTool(): Promise<CallToolResult> {
  return runTool('modules.list', async () => ({
    modules: MODULE_CATALOG,
    readOnly: true,
    note: 'Catalog status is execution evidence, not an availability promise. Planned modules have no state and no install path.'
  }));
}
