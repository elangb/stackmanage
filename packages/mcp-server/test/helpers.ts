import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveDataRoots, type DataRoots } from '../src/data/roots.js';
import { createStackManageServer } from '../src/server.js';

export interface Harness {
  readonly base: string;
  readonly roots: DataRoots;
  readonly client: Client;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'stackmanage-mcp-test-'));
  const roots = resolveDataRoots({
    env: { STACKMANAGE_DATA_HOME: join(base, 'caddy') },
    platform: 'linux',
    home: base
  });
  const server = createStackManageServer({ roots });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'stackmanage-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    base,
    roots,
    client,
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, 'utf8');
}

export function stateFile(roots: DataRoots, moduleId: string, key: string): string {
  return join(roots.dataRoot, 'state', moduleId, `${key}.json`);
}

const ISO = '2026-11-04T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const SOURCE = 'https://example.invalid/artifact.tar.gz';

export function caddyInstallation(roots: DataRoots): Record<string, unknown> {
  return {
    installation: {
      id: 'caddy-2.11.8-linux-x64',
      version: {
        moduleId: 'caddy',
        version: '2.11.8',
        platform: 'linux',
        architecture: 'x64',
        source: SOURCE,
        sha256: SHA
      },
      directory: join(roots.caddyRoot, 'installations', 'caddy-2.11.8-linux-x64')
    },
    target: 'linux-amd64',
    binaryPath: join(roots.caddyRoot, 'installations', 'caddy-2.11.8-linux-x64', 'caddy'),
    archivePath: join(roots.caddyRoot, 'downloads', 'caddy.tar.gz'),
    installedAt: ISO,
    versionOutput: 'v2.11.8'
  };
}

export function nginxInstallation(roots: DataRoots): Record<string, unknown> {
  return {
    id: 'nginx-1.30.6-linux-x64',
    moduleId: 'nginx',
    version: '1.30.6',
    target: 'linux-amd64',
    directory: join(roots.nginxRoot, 'installations', 'nginx-1.30.6-linux-x64'),
    binaryPath: join(roots.nginxRoot, 'installations', 'nginx-1.30.6-linux-x64', 'sbin', 'nginx'),
    archivePath: join(roots.nginxRoot, 'downloads', 'nginx.tar.gz'),
    source: SOURCE,
    sha256: SHA,
    installedAt: ISO,
    versionOutput: 'nginx/1.30.6'
  };
}

export function nodeInstallation(roots: DataRoots): Record<string, unknown> {
  return {
    id: 'node-24.22.2-linux-x64',
    moduleId: 'node',
    version: '24.22.2',
    target: 'linux-x64',
    directory: join(roots.nodeRoot, 'installations', 'node-24.22.2-linux-x64'),
    binaryPath: join(roots.nodeRoot, 'installations', 'node-24.22.2-linux-x64', 'bin', 'node'),
    archivePath: join(roots.nodeRoot, 'downloads', 'node.tar.gz'),
    installedAt: ISO,
    versionOutput: 'v24.22.2',
    sha256: SHA
  };
}

export function caddyService(roots: DataRoots, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instanceId: 'default',
    status: 'running',
    process: {
      instanceId: 'default',
      ref: { moduleId: 'caddy', installationId: 'caddy-2.11.8-linux-x64', instanceId: 'default' },
      pid: 2_147_483_647,
      executable: join(roots.caddyRoot, 'installations', 'caddy-2.11.8-linux-x64', 'caddy'),
      startToken: '1',
      procToken: 'c'.repeat(32),
      port: 18080,
      configPath: join(roots.caddyRoot, 'caddyfiles', 'default.Caddyfile'),
      logPath: join(roots.caddyRoot, 'logs', 'default.log'),
      startedAt: ISO,
      ...overrides
    }
  };
}

export function validSite(roots: DataRoots, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'default',
    hostname: 'localhost',
    aliases: ['app.test'],
    server: { moduleId: 'caddy', installationId: 'caddy-2.11.8-linux-x64', instanceId: 'default' },
    root: join(roots.caddyRoot, 'sites', 'default'),
    port: 18080,
    tls: true,
    ...overrides
  };
}

export function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) throw new Error('missing content');
  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== 'text' || typeof first.text !== 'string') throw new Error('expected text content');
  return JSON.parse(first.text) as Record<string, unknown>;
}
