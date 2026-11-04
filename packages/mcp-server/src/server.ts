import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DataRoots } from './data/roots.js';
import { SERVER_NAME, SERVER_VERSION } from './limits.js';
import { configReadTool } from './tools/config-read.js';
import { installationsListTool } from './tools/installations-list.js';
import { logsTailTool } from './tools/logs-tail.js';
import { modulesListTool } from './tools/modules-list.js';
import { servicesStatusTool } from './tools/services-status.js';
import { sitesListTool } from './tools/sites-list.js';
import { systemInfoTool } from './tools/system-info.js';

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

const EmptyInput = z.object({}).strict();
const InstallationFilter = z.object({ moduleId: z.enum(['caddy', 'nginx', 'node', 'redis']).optional() }).strict();
const ServiceFilter = z.object({ moduleId: z.enum(['caddy', 'nginx']).optional() }).strict();
const SitesFilter = z.object({ moduleId: z.literal('caddy').optional() }).strict();
const LogsInput = z
  .object({
    moduleId: z.enum(['caddy', 'nginx']),
    maxBytes: z.number().int().min(256).max(1_048_576).optional()
  })
  .strict();
const ConfigInput = z.object({ moduleId: z.enum(['caddy', 'nginx']) }).strict();

export interface CreateServerOptions {
  readonly roots: DataRoots;
}

/**
 * Read-only, deny-by-default MCP surface. There is deliberately no mutation
 * tool, no shell/exec tool and no caller-selectable filesystem path.
 */
export function createStackManageServer(options: CreateServerOptions): McpServer {
  const { roots } = options;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'system.info',
    {
      title: 'System information',
      description: 'Read platform, architecture, data-root location, read-only flag and hard output limits. No arguments.',
      inputSchema: EmptyInput,
      annotations: READ_ONLY_ANNOTATIONS
    },
    () => systemInfoTool(roots)
  );

  server.registerTool(
    'modules.list',
    {
      title: 'Module catalog',
      description: 'Read the honest StackManage module catalog (Caddy, Nginx, Node.js, planned Redis) with execution evidence and limitations.',
      inputSchema: EmptyInput,
      annotations: READ_ONLY_ANNOTATIONS
    },
    () => modulesListTool()
  );

  server.registerTool(
    'installations.list',
    {
      title: 'Installed records',
      description: 'Read persisted Caddy/Nginx/Node installation records. Missing state is absent; corrupt state is explicitly unknown. No paths are accepted.',
      inputSchema: InstallationFilter,
      annotations: READ_ONLY_ANNOTATIONS
    },
    args => installationsListTool(roots, args.moduleId)
  );

  server.registerTool(
    'services.status',
    {
      title: 'Service status',
      description: 'Read persisted Caddy/Nginx service records and verify PID identity and loopback readiness. Never claims running from renderer state and never mutates a record.',
      inputSchema: ServiceFilter,
      annotations: READ_ONLY_ANNOTATIONS
    },
    args => servicesStatusTool(roots, args.moduleId)
  );

  server.registerTool(
    'sites.list',
    {
      title: 'Local sites',
      description: 'Read the persisted Caddy site set. Proxy URL credentials are redacted and roots outside the managed sites directory are flagged.',
      inputSchema: SitesFilter,
      annotations: READ_ONLY_ANNOTATIONS
    },
    () => sitesListTool(roots)
  );

  server.registerTool(
    'logs.tail',
    {
      title: 'Bounded log tail',
      description: 'Read a bounded tail of the default Caddy or Nginx log. Secret-like values are redacted. Only known module log locations are used.',
      inputSchema: LogsInput,
      annotations: READ_ONLY_ANNOTATIONS
    },
    args => logsTailTool(roots, args.moduleId, args.maxBytes)
  );

  server.registerTool(
    'config.read',
    {
      title: 'Read configuration',
      description: 'Read the bounded, redacted default Caddy or Nginx configuration text. The caller cannot choose a path.',
      inputSchema: ConfigInput,
      annotations: READ_ONLY_ANNOTATIONS
    },
    args => configReadTool(roots, args.moduleId)
  );

  return server;
}
