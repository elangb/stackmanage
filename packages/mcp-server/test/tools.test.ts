import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHeadWithin, readTailWithin } from '../src/data/read.js';
import { redactSecrets } from '../src/data/redact.js';
import { resolveDataRoots } from '../src/data/roots.js';
import {
  caddyInstallation,
  caddyService,
  createHarness,
  nginxInstallation,
  nodeInstallation,
  parseToolResult,
  stateFile,
  validSite,
  writeJson,
  writeText,
  type Harness
} from './helpers.js';

const harnesses: Harness[] = [];

async function harness(): Promise<Harness> {
  const created = await createHarness();
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(item => item.close()));
});

interface ModuleListResult {
  modules: Array<{ moduleId: string; state: string; installations: Array<{ version: string; moduleId: string }>; warnings: Array<{ code: string }> }>;
}

interface ServiceResult {
  modules: Array<{
    moduleId: string;
    recordState: string;
    services: Array<{ state: string; identity: string; pid: number | null; warnings: Array<{ code: string }> }>;
  }>;
}

interface SiteResult {
  state: string;
  sites: Array<{ rootWithinManagedSites: boolean; proxyTarget: string | null }>;
  warnings: Array<{ code: string }>;
}

interface TextResult {
  exists: boolean;
  text?: string;
  content?: string;
  bytes: number;
  truncated: boolean;
  redactions: number;
  redacted: boolean;
  maxBytes: number;
}

describe('read-only tool surface', () => {
  it('exposes exactly the seven read-only tools and no mutation tools', async () => {
    const h = await harness();
    const listed = await h.client.listTools();
    const names = listed.tools.map(tool => tool.name).sort();
    expect(names).toEqual(['config.read', 'installations.list', 'logs.tail', 'modules.list', 'services.status', 'sites.list', 'system.info']);
    for (const tool of listed.tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('reports platform, data root, read-only and no network listener', async () => {
    const h = await harness();
    const result = parseToolResult(await h.client.callTool({ name: 'system.info', arguments: {} })) as {
      readOnly: boolean;
      platform: string;
      dataRoot: string;
      network: { listening: boolean; binds: boolean };
      tools: string[];
    };
    expect(result.readOnly).toBe(true);
    expect(result.platform).toBe('linux');
    expect(result.dataRoot).toBe(h.roots.dataRoot);
    expect(result.network).toEqual({ transport: 'stdio', listening: false, binds: false });
    expect(result.tools).toHaveLength(7);
  });

  it('reports honest module status and no planned Redis implementation', async () => {
    const h = await harness();
    const result = parseToolResult(await h.client.callTool({ name: 'modules.list', arguments: {} })) as {
      modules: Array<{ id: string; status: string }>;
    };
    expect(result.modules.map(module => [module.id, module.status])).toEqual([
      ['caddy', 'partial'],
      ['nginx', 'partial'],
      ['node', 'partial'],
      ['redis', 'planned']
    ]);
  });
});

describe('installations.list', () => {
  it('returns explicit absent states when no records exist', async () => {
    const h = await harness();
    const result = parseToolResult(await h.client.callTool({ name: 'installations.list', arguments: {} })) as ModuleListResult;
    expect(result.modules.map(module => [module.moduleId, module.state])).toEqual([
      ['caddy', 'absent'],
      ['nginx', 'absent'],
      ['node', 'absent']
    ]);
  });

  it('reads valid Caddy, Nginx and Node records without claiming binary existence', async () => {
    const h = await harness();
    await writeJson(stateFile(h.roots, 'caddy', 'installation'), caddyInstallation(h.roots));
    await writeJson(stateFile(h.roots, 'nginx', 'installations'), { installations: [nginxInstallation(h.roots)] });
    await writeJson(stateFile(h.roots, 'node', 'installations'), { installations: [nodeInstallation(h.roots)] });

    const result = parseToolResult(await h.client.callTool({ name: 'installations.list', arguments: {} })) as ModuleListResult;
    expect(result.modules.map(module => [module.moduleId, module.state])).toEqual([
      ['caddy', 'present'],
      ['nginx', 'present'],
      ['node', 'present']
    ]);
    expect(result.modules[0]?.installations[0]?.moduleId).toBe('caddy');
    expect(result.modules[1]?.installations[0]?.version).toBe('1.30.6');
    expect(result.modules[2]?.installations[0]?.version).toBe('24.22.2');
  });

  it('marks corrupt, oversized and schema-mismatched records as unknown', async () => {
    const h = await harness();
    await writeText(stateFile(h.roots, 'caddy', 'installation'), '{not json');
    await writeJson(stateFile(h.roots, 'nginx', 'installations'), { installations: 'nope' });
    await writeJson(stateFile(h.roots, 'node', 'installations'), { installations: [nodeInstallation(h.roots)] });
    const result = parseToolResult(await h.client.callTool({ name: 'installations.list', arguments: { moduleId: 'caddy' } })) as ModuleListResult;
    expect(result.modules[0]?.state).toBe('unknown');
    expect(result.modules[0]?.installations).toEqual([]);
    expect(result.modules[0]?.warnings[0]?.code).toBe('STATE_UNREADABLE');
  });

  it('flags installation paths outside the managed module root', async () => {
    const h = await harness();
    const record = caddyInstallation(h.roots) as { binaryPath: string };
    record.binaryPath = '/etc/passwd';
    await writeJson(stateFile(h.roots, 'caddy', 'installation'), record);
    const result = parseToolResult(await h.client.callTool({ name: 'installations.list', arguments: { moduleId: 'caddy' } })) as ModuleListResult & {
      modules: Array<{ installations: Array<{ binaryPath: string | null }> }>;
    };
    expect(result.modules[0]?.installations[0]?.binaryPath).toBeNull();
    expect(result.modules[0]?.warnings[0]?.code).toBe('PATH_OUTSIDE_ROOT');
  });
});

describe('services.status', () => {
  it('returns absent when no service records exist', async () => {
    const h = await harness();
    const result = parseToolResult(await h.client.callTool({ name: 'services.status', arguments: {} })) as ServiceResult;
    expect(result.modules.map(module => [module.moduleId, module.recordState])).toEqual([
      ['caddy', 'absent'],
      ['nginx', 'absent']
    ]);
    expect(result.modules[0]?.services).toEqual([]);
  });

  it('treats a dead PID as stopped and never claims running from the record', async () => {
    const h = await harness();
    await writeJson(stateFile(h.roots, 'caddy', 'service-default'), caddyService(h.roots));
    const result = parseToolResult(await h.client.callTool({ name: 'services.status', arguments: { moduleId: 'caddy' } })) as ServiceResult;
    const service = result.modules[0]?.services[0];
    expect(service?.state).toBe('stopped');
    expect(service?.identity).toBe('gone');
    expect(service?.warnings.map(warning => warning.code)).toContain('STALE_RECORD');
  });

  it('reports unknown when a live PID has a different executable', async () => {
    const h = await harness();
    await writeJson(
      stateFile(h.roots, 'caddy', 'service-default'),
      caddyService(h.roots, { pid: process.pid, executable: '/definitely/not/this/binary', startToken: '1' })
    );
    const result = parseToolResult(await h.client.callTool({ name: 'services.status', arguments: { moduleId: 'caddy' } })) as ServiceResult;
    const service = result.modules[0]?.services[0];
    expect(service?.state).toBe('unknown');
    expect(service?.identity).toBe('mismatch');
    expect(service?.warnings.map(warning => warning.code)).toContain('IDENTITY_MISMATCH');
  });

  it('surfaces unverified and corrupt records as unknown', async () => {
    const h = await harness();
    await writeJson(stateFile(h.roots, 'caddy', 'service-default'), {
      instanceId: 'default',
      status: 'unknown',
      unverified: { pid: 123, observedAt: '2026-11-04T00:00:00.000Z', reason: 'start-token' }
    });
    await writeText(stateFile(h.roots, 'nginx', 'service-default'), '{broken');
    const result = parseToolResult(await h.client.callTool({ name: 'services.status', arguments: {} })) as ServiceResult;
    expect(result.modules[0]?.services[0]?.state).toBe('unknown');
    expect(result.modules[0]?.services[0]?.warnings[0]?.code).toBe('UNVERIFIED_RECORD');
    expect(result.modules[1]?.services[0]?.state).toBe('unknown');
    expect(result.modules[1]?.services[0]?.warnings[0]?.code).toBe('STATE_UNREADABLE');
  });
});

describe('sites.list', () => {
  it('reads Caddy sites and redacts proxy credentials', async () => {
    const h = await harness();
    await writeJson(stateFile(h.roots, 'caddy', 'sites'), {
      sites: [validSite(h.roots, { proxyTarget: 'http://user:pass@127.0.0.1:3000/' })]
    });
    const result = parseToolResult(await h.client.callTool({ name: 'sites.list', arguments: {} })) as SiteResult;
    expect(result.state).toBe('present');
    expect(result.sites[0]?.rootWithinManagedSites).toBe(true);
    expect(result.sites[0]?.proxyTarget).not.toContain('user');
    expect(result.sites[0]?.proxyTarget).not.toContain('pass');
  });

  it('flags roots outside the managed sites directory and corrupt state', async () => {
    const h = await harness();
    await writeJson(stateFile(h.roots, 'caddy', 'sites'), { sites: [validSite(h.roots, { root: '/tmp/outside-root' })] });
    const outside = parseToolResult(await h.client.callTool({ name: 'sites.list', arguments: {} })) as SiteResult;
    expect(outside.sites[0]?.rootWithinManagedSites).toBe(false);
    expect(outside.warnings.map(warning => warning.code)).toContain('SITE_ROOT_OUTSIDE_MANAGED');

    await writeText(stateFile(h.roots, 'caddy', 'sites'), '{not json');
    const corrupt = parseToolResult(await h.client.callTool({ name: 'sites.list', arguments: {} })) as SiteResult;
    expect(corrupt.state).toBe('unknown');
    expect(corrupt.sites).toEqual([]);
  });
});

describe('logs.tail and config.read', () => {
  it('returns explicit missing output and never accepts caller paths', async () => {
    const h = await harness();
    const missing = parseToolResult(await h.client.callTool({ name: 'logs.tail', arguments: { moduleId: 'caddy' } })) as TextResult;
    expect(missing.exists).toBe(false);
    expect(missing.text).toBe('');

    const traversal = await h.client.callTool({ name: 'logs.tail', arguments: { moduleId: 'caddy', path: '/etc/passwd' } });
    expect(traversal.isError).toBe(true);
    const absolute = await h.client.callTool({ name: 'config.read', arguments: { moduleId: 'caddy', path: '/etc/passwd' } });
    expect(absolute.isError).toBe(true);
    const tooBig = await h.client.callTool({ name: 'logs.tail', arguments: { moduleId: 'caddy', maxBytes: 9_999_999 } });
    expect(tooBig.isError).toBe(true);
  });

  it('bounds log tails and redacts credentials', async () => {
    const h = await harness();
    await writeText(join(h.roots.caddyRoot, 'logs', 'default.log'), `${'x'.repeat(10_000)}\nAuthorization: Bearer abcdefghijklmnop\npassword=supersecret\n`);
    const result = parseToolResult(await h.client.callTool({ name: 'logs.tail', arguments: { moduleId: 'caddy', maxBytes: 512 } })) as TextResult;
    expect(result.exists).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(512);
    expect(result.text?.length).toBeLessThanOrEqual(512);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('supersecret');
    expect(result.text).not.toContain('abcdefghijklmnop');
    expect(result.redactions).toBeGreaterThanOrEqual(1);
  });

  it('bounds configuration text and redacts secrets and private keys', async () => {
    const h = await harness();
    const config = `{\n  admin off\n}\napi_key = "topsecretvalue"\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n`;
    await writeText(join(h.roots.caddyRoot, 'caddyfiles', 'default.Caddyfile'), config);
    const result = parseToolResult(await h.client.callTool({ name: 'config.read', arguments: { moduleId: 'caddy' } })) as TextResult;
    expect(result.exists).toBe(true);
    expect(result.content).not.toContain('topsecretvalue');
    expect(result.content).not.toContain('BEGIN PRIVATE KEY');
    expect(result.redactions).toBeGreaterThanOrEqual(2);

    await writeText(join(h.roots.nginxRoot, 'service', 'conf', 'nginx.conf'), 'a'.repeat(300_000));
    const nginx = parseToolResult(await h.client.callTool({ name: 'config.read', arguments: { moduleId: 'nginx' } })) as TextResult;
    expect(nginx.content?.length).toBeLessThanOrEqual(240_000);
    expect(nginx.truncated).toBe(true);
  });
});

describe('path confinement', () => {
  it('rejects relative traversal and absolute paths', async () => {
    const h = await harness();
    await mkdir(h.roots.caddyRoot, { recursive: true });
    await expect(readTailWithin(h.roots.caddyRoot, '../etc/passwd', 128)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(readTailWithin(h.roots.caddyRoot, 'logs/../logs/default.log', 128)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
    await expect(readHeadWithin(h.roots.caddyRoot, '/etc/passwd', 128)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
  });

  it('rejects symlinks that escape the data root', async () => {
    const h = await harness();
    await mkdir(join(h.roots.caddyRoot, 'logs'), { recursive: true });
    const outside = join(h.base, 'outside.log');
    await writeText(outside, 'outside secret');
    await symlink(outside, join(h.roots.caddyRoot, 'logs', 'escape.log'));
    await expect(readTailWithin(h.roots.caddyRoot, 'logs/escape.log', 128)).rejects.toMatchObject({ code: 'PATH_REJECTED' });
  });

  it('redacts common secret forms', () => {
    const result = redactSecrets('Authorization: Basic dXNlcjpwYXNz\nclient_secret="abc123"\nhttps://user:pass@example.com/x\neyJabcdefghijk.abcdefghijk.abcdefghijk');
    expect(result.count).toBeGreaterThanOrEqual(4);
    expect(result.text).not.toContain('dXNlcjpwYXNz');
    expect(result.text).not.toContain('abc123');
    expect(result.text).not.toContain('user:pass');
    expect(result.text).not.toContain('eyJabcdefghijk');
  });
});

describe('data-root configuration', () => {
  it('derives the Electron userData/caddy default on Linux', () => {
    const roots = resolveDataRoots({ env: { HOME: '/home/dev', XDG_CONFIG_HOME: '/home/dev/.config' }, platform: 'linux', home: '/home/dev' });
    expect(roots.dataRoot).toBe('/home/dev/.config/StackManage/caddy');
    expect(roots.nginxRoot).toBe('/home/dev/.config/StackManage/nginx');
    expect(roots.nodeRoot).toBe('/home/dev/.config/StackManage/node/runtime');
  });

  it('rejects relative, empty and filesystem-root overrides', () => {
    expect(() => resolveDataRoots({ env: { STACKMANAGE_DATA_HOME: 'relative/path' }, platform: 'linux', home: '/home/dev' })).toThrow(/absolute/);
    expect(() => resolveDataRoots({ env: { STACKMANAGE_DATA_HOME: '   ' }, platform: 'linux', home: '/home/dev' })).toThrow(/empty/);
    expect(() => resolveDataRoots({ env: { STACKMANAGE_DATA_HOME: '/' }, platform: 'linux', home: '/home/dev' })).toThrow(/filesystem root/);
  });
});
