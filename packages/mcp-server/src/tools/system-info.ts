import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LIMITS, SERVER_NAME, SERVER_VERSION } from '../limits.js';
import type { DataRoots } from '../data/roots.js';
import { runTool } from './common.js';

const READ_ONLY_TOOLS = Object.freeze([
  'system.info',
  'modules.list',
  'installations.list',
  'services.status',
  'sites.list',
  'logs.tail',
  'config.read'
]);

export function systemInfoTool(roots: DataRoots): Promise<CallToolResult> {
  return runTool('system.info', async () => ({
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'stdio',
      protocol: 'model-context-protocol'
    },
    platform: roots.platform,
    arch: process.arch,
    node: process.version,
    dataRoot: roots.dataRoot,
    dataRootSource: roots.source,
    moduleRoots: {
      caddy: roots.caddyRoot,
      nginx: roots.nginxRoot,
      node: roots.nodeRoot,
      state: roots.stateRoot
    },
    readOnly: true,
    mutations: {
      exposed: false,
      required: 'A future locally authenticated bridge with explicit user approval. No install/start/stop/write tool exists in this server.'
    },
    network: {
      transport: 'stdio',
      listening: false,
      binds: false
    },
    tools: READ_ONLY_TOOLS,
    limits: {
      maxLogBytes: LIMITS.maxLogBytes,
      defaultLogBytes: LIMITS.defaultLogBytes,
      maxConfigBytes: LIMITS.maxConfigBytes,
      maxServiceRecords: LIMITS.maxServiceRecords,
      maxSites: LIMITS.maxSites,
      readTimeoutMs: LIMITS.readTimeoutMs
    },
    security: {
      confinement: 'realpath-prefix',
      callerPathsAccepted: false,
      shellExecution: false,
      telemetry: false,
      redaction: true
    }
  }));
}
