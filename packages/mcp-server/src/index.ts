#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DataRootConfigError, resolveDataRoots } from './data/roots.js';
import { SERVER_NAME } from './limits.js';
import { createStackManageServer } from './server.js';

function stderr(message: string): void {
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
}

async function main(): Promise<void> {
  let roots;
  try {
    roots = resolveDataRoots();
  } catch (error) {
    stderr(error instanceof DataRootConfigError ? `configuration error: ${error.message}` : 'configuration error');
    process.exitCode = 1;
    return;
  }

  const server = createStackManageServer({ roots });
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  try {
    await server.connect(transport);
  } catch {
    stderr('failed to start the stdio transport');
    process.exitCode = 1;
  }
}

void main();
