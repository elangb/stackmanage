import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, HostsEntrySchema, isTrustedSender, McpPermissionSchema, ModuleDefinitionSchema, OperationResultSchema, parseBounded, PluginManifestSchema, ScheduleSchema, SnapshotRequestSchema, StartupGroupSchema, VersionRecordSchema, WorkerRequestSchema, WorkerResponseSchema } from '../src';

describe('v1 trust boundaries', () => {
  it('accepts only the narrow IPC operation and API version', () => {
    expect(WorkerRequestSchema.parse({ apiVersion: 1, id: 'request-1', method: 'health' }).method).toBe('health');
    for (const input of [{ apiVersion: 2, id: 'x', method: 'health' }, { apiVersion: 1, id: 'x', method: 'exec', command: 'whoami' }, { apiVersion: 1, id: 'x', method: 'health', command: 'whoami' }]) expect(WorkerRequestSchema.safeParse(input).success).toBe(false);
    expect(SnapshotRequestSchema.safeParse({ apiVersion: 1, path: '/etc/hosts' }).success).toBe(false);
    expect(WorkerResponseSchema.safeParse({ apiVersion: 1, id: 'x', status: 'ready', pid: -1 }).success).toBe(false);
  });
  it('rejects oversized multibyte payloads before dispatch', () => {
    expect(() => parseBounded(SnapshotRequestSchema, { apiVersion: 1, data: '界'.repeat(DEFAULT_LIMITS.maxIpcBytes / 2) })).toThrow('INVALID_REQUEST');
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    expect(() => parseBounded(SnapshotRequestSchema, cycle)).toThrow();
  });
  it('rejects child frames, prefix attacks and alternate origins', () => {
    const expected = 'http://127.0.0.1:5179/';
    expect(isTrustedSender({ url: expected, isMainFrame: true }, expected)).toBe(true);
    for (const url of ['http://127.0.0.1:5179.evil/', 'https://evil.test', `${expected}evil`, `${expected}?redirect=evil`]) expect(isTrustedSender({ url, isMainFrame: true }, expected)).toBe(false);
    expect(isTrustedSender({ url: expected, isMainFrame: false }, expected)).toBe(false);
  });
  it('requires evidence for supported vendors and authenticated artifact digests', () => {
    const module = { apiVersion: 1, id: 'node', nameKey: 'modules.node', category: 'runtime', capabilities: ['versions'], dependencies: [], availability: [{ platform: 'win32', architecture: 'x64', status: 'supported' }] };
    expect(ModuleDefinitionSchema.safeParse(module).success).toBe(false);
    expect(ModuleDefinitionSchema.safeParse({ ...module, availability: [{ platform: 'win32', architecture: 'x64', status: 'unverified' }] }).success).toBe(true);
    const version = { moduleId: 'node', version: '24.0.0', platform: 'linux', architecture: 'x64', source: 'https://example.test/node.tar.gz', sha256: 'a'.repeat(64) };
    expect(VersionRecordSchema.safeParse(version).success).toBe(true);
    expect(VersionRecordSchema.safeParse({ ...version, source: 'http://example.test/file' }).success).toBe(false);
    expect(VersionRecordSchema.safeParse({ ...version, sha256: '' }).success).toBe(false);
  });
  it('does not hide partial or unknown results behind success', () => {
    const result = { operationId: 'op', status: 'completed', items: [{ id: 'service', status: 'failed', error: { code: 'IO_ERROR', messageKey: 'failed', retryable: false } }], warnings: [] };
    expect(OperationResultSchema.safeParse(result).success).toBe(false);
    expect(OperationResultSchema.safeParse({ ...result, status: 'partial' }).success).toBe(true);
    expect(OperationResultSchema.safeParse({ ...result, items: [{ id: 'service', status: 'unknown' }] }).success).toBe(false);
    expect(OperationResultSchema.safeParse({ ...result, items: [{ id: 'hosts', status: 'completed' }], warnings: [{ code: 'IO_ERROR', messageKey: 'dns.refreshFailed', retryable: true }] }).success).toBe(true);
  });
  it('rejects unsafe hostname content, invalid timezone and cyclic startup ordering', () => {
    expect(HostsEntrySchema.safeParse({ hostname: 'a.test\n127.0.0.1 evil.test', address: '127.0.0.1' }).success).toBe(false);
    expect(ScheduleSchema.safeParse({ id: 'cron', cron: '* * * * *', timezone: 'Invalid/Zone', groupId: 'group', enabled: true, overlap: 'skip', missed: 'skip' }).success).toBe(false);
    const service = { moduleId: 'test', installationId: 'test', instanceId: 'a' };
    expect(StartupGroupSchema.safeParse({ id: 'group', name: 'Group', execution: 'ordered', onFailure: 'skip-dependents', entries: [{ service, dependsOn: ['a'], required: true }] }).success).toBe(false);
  });
  it('rejects wildcard capabilities and plugin path traversal', () => {
    expect(McpPermissionSchema.safeParse({ principalId: 'client', tools: ['*'], resources: ['*'], expiresAt: '2026-01-01T00:00:00.000Z' }).success).toBe(false);
    expect(PluginManifestSchema.safeParse({ apiVersion: 1, id: 'plugin', version: '1.0.0', entry: '../escape.mjs', permissions: [], modules: [] }).success).toBe(false);
  });
});
