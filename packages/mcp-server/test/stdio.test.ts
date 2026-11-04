import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it } from 'vitest';
import { caddyInstallation, parseToolResult, stateFile, writeJson } from './helpers.js';
import { resolveDataRoots } from '../src/data/roots.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'src', 'index.ts');
const distEntry = join(packageRoot, 'dist', 'index.js');

function stringEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...extra };
}

const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => {
  await Promise.all(cleanup.splice(0).map(run => run()));
});

async function connect(command: string, args: string[], dataRoot: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: packageRoot,
    env: stringEnv({ STACKMANAGE_DATA_HOME: dataRoot }),
    stderr: 'pipe'
  });
  const client = new Client({ name: 'stackmanage-mcp-stdio-test', version: '0.0.0' });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close().catch(() => undefined);
    }
  };
}

describe('real stdio MCP transport', () => {
  it('lists and calls tools through a spawned server process', async () => {
    const base = await mkdtemp(join(tmpdir(), 'stackmanage-mcp-stdio-'));
    const roots = resolveDataRoots({ env: { STACKMANAGE_DATA_HOME: join(base, 'caddy') }, platform: 'linux', home: base });
    await writeJson(stateFile(roots, 'caddy', 'installation'), caddyInstallation(roots));
    cleanup.push(async () => rm(base, { recursive: true, force: true }));

    const session = await connect(process.execPath, ['--import', 'tsx', entry], roots.dataRoot);
    cleanup.push(session.close);

    const tools = await session.client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([
      'config.read',
      'installations.list',
      'logs.tail',
      'modules.list',
      'services.status',
      'sites.list',
      'system.info'
    ]);

    const system = parseToolResult(await session.client.callTool({ name: 'system.info', arguments: {} })) as {
      readOnly: boolean;
      dataRoot: string;
    };
    expect(system.readOnly).toBe(true);
    expect(system.dataRoot).toBe(roots.dataRoot);

    const installations = parseToolResult(await session.client.callTool({ name: 'installations.list', arguments: { moduleId: 'caddy' } })) as {
      modules: Array<{ state: string }>;
    };
    expect(installations.modules[0]?.state).toBe('present');
  });

  it('fails fast on a relative data-root override without writing protocol output', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: packageRoot,
      env: stringEnv({ STACKMANAGE_DATA_HOME: 'relative/path' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('configuration error');
    expect(stderr).not.toContain('relative/path');
  });

  it.skipIf(!existsSync(distEntry))('runs the built CLI entry with node dist/index.js', async () => {
    const base = await mkdtemp(join(tmpdir(), 'stackmanage-mcp-dist-'));
    const roots = resolveDataRoots({ env: { STACKMANAGE_DATA_HOME: join(base, 'caddy') }, platform: 'linux', home: base });
    cleanup.push(async () => rm(base, { recursive: true, force: true }));

    const session = await connect(process.execPath, [distEntry], roots.dataRoot);
    cleanup.push(session.close);
    const tools = await session.client.listTools();
    expect(tools.tools).toHaveLength(7);
    const system = parseToolResult(await session.client.callTool({ name: 'system.info', arguments: {} })) as { dataRoot: string };
    expect(system.dataRoot).toBe(roots.dataRoot);
  });
});
