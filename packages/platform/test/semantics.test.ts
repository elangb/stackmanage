import { OperationResultSchema } from '@stackmanage/core';
import { describe, expect, it } from 'vitest';
import { buildResult, emitTerminal, operationError, unsupportedResult } from '../src/results';
import { availabilityRows, buildCapabilityMatrix } from '../src/capabilities';
import { composePlatform, unimplementedCertManager } from '../src/composition';
import { ModuleDefinitionSchema } from '@stackmanage/core';
import { FakeRunner, MemoryFileSystem, recordingContext } from './fakes';

describe('terminal result semantics', () => {
  it('derives partial from mixed outcomes and never hides failure behind completed', () => {
    const mixed = buildResult('op', [{ id: 'a', status: 'completed' }, { id: 'b', status: 'failed', error: operationError('IO_ERROR', 'x') }]);
    expect(mixed.status).toBe('partial');
    expect(OperationResultSchema.safeParse(mixed).success).toBe(true);
  });

  it('maps unknown and cancelled truthfully', () => {
    expect(buildResult('op', [{ id: 'a', status: 'unknown' }]).status).toBe('unknown');
    expect(buildResult('op', [{ id: 'a', status: 'failed', error: operationError('IO_ERROR', 'x') }]).status).toBe('failed');
    expect(buildResult('op', [{ id: 'a', status: 'skipped', error: operationError('UNAVAILABLE', 'x') }]).status).toBe('failed');
    expect(buildResult('op', []).status).toBe('completed');
  });

  it('supplies an explicit reason for every non-completed item', () => {
    const result = buildResult('op', [{ id: 'a', status: 'skipped' }]);
    expect(result.items[0]?.error?.code).toBe('UNKNOWN');
    expect(OperationResultSchema.safeParse(result).success).toBe(true);
  });

  it('keeps supplementary warnings separate from the item outcome', () => {
    const result = buildResult('op', [{ id: 'hosts', status: 'completed' }], [operationError('IO_ERROR', 'dns.refreshFailed', true)]);
    expect(result.status).toBe('completed');
    expect(result.warnings.length).toBe(1);
    expect(OperationResultSchema.safeParse(result).success).toBe(true);
  });

  it('emits exactly one terminal per call and validates against the frozen schema', () => {
    const context = recordingContext();
    const result = buildResult('op-9', [{ id: 'x', status: 'completed' }]);
    emitTerminal(context, result);
    emitTerminal(context, result);
    expect(context.events.filter(e => e.type === 'terminal').length).toBe(2);
    expect(OperationResultSchema.safeParse(result).success).toBe(true);
  });

  it('reports unsupported operations as skipped, not completed', () => {
    const result = unsupportedResult('op', 'feat', 'feat.notImplemented');
    expect(result.items[0]).toMatchObject({ status: 'skipped', error: { code: 'NOT_IMPLEMENTED' } });
  });
});

describe('capability matrix', () => {
  it('never claims verified without supplied evidence', () => {
    const matrix = buildCapabilityMatrix({ platform: 'linux', arch: 'x64', commands: { pkexec: true, setcap: true, 'update-ca-certificates': true } });
    for (const status of Object.values(matrix)) expect(status.status).not.toBe('verified');
  });

  it('marks Windows capabilities unverified and Linux privilege gaps unsupported', () => {
    const windows = buildCapabilityMatrix({ platform: 'win32', arch: 'x64', commands: {} });
    expect(Object.values(windows).every(s => s.status === 'unverified')).toBe(true);
    const linux = buildCapabilityMatrix({ platform: 'linux', arch: 'arm64', commands: {} });
    expect(linux['trust-store'].status).toBe('unsupported');
    expect(linux.elevation.status).toBe('unsupported');
    expect(linux['hosts-write'].status).toBe('unverified');
  });

  it('accepts explicit evidence without touching frozen contracts', () => {
    const matrix = buildCapabilityMatrix({ platform: 'linux', arch: 'x64', commands: {} }, { 'port-probe': 'packages/platform/test/process-health.test.ts loopback probe' });
    expect(matrix['port-probe']).toMatchObject({ status: 'verified' });
  });

  it('builds availability rows that satisfy ModuleDefinitionSchema without claiming support', () => {
    const rows = availabilityRows('x64', 'linux');
    const definition = { apiVersion: 1, id: 'node', nameKey: 'modules.node', category: 'runtime', capabilities: ['versions'], dependencies: [], availability: rows };
    expect(ModuleDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(rows.every(row => row.status === 'unverified')).toBe(true);
  });
});

describe('composition', () => {
  it('wires a Linux composition with roots and a hosts manager', () => {
    const composition = composePlatform({ env: { HOME: '/home/dev' }, runner: new FakeRunner(), hostFacts: { platform: 'linux', arch: 'x64' }, fs: new MemoryFileSystem() });
    expect(composition.detection.supported).toBe(true);
    expect(composition.roots.ok).toBe(true);
    expect(composition.hosts).toBeDefined();
    expect(composition.autostart?.target()).toBe('/home/dev/.config/StackManage/autostart/stackmanage.desktop');
  });

  it('returns no hosts adapter on an unsupported host', () => {
    const composition = composePlatform({ env: { HOME: '/home/dev' }, runner: new FakeRunner(), hostFacts: { platform: 'darwin', arch: 'arm64' }, fs: new MemoryFileSystem() });
    expect(composition.detection.supported).toBe(false);
    expect(composition.hosts).toBeUndefined();
  });

  it('wires a Windows composition whose hosts adapter is plan-only', () => {
    const composition = composePlatform({ env: { LOCALAPPDATA: 'C:\\Local', APPDATA: 'C:\\Roaming' }, runner: new FakeRunner(), hostFacts: { platform: 'win32', arch: 'arm64' }, fs: new MemoryFileSystem() });
    expect(composition.detection.supported).toBe(true);
    expect(composition.hosts?.constructor.name).toBe('WindowsHostsManager');
  });

  it('certificate manager reports NOT_IMPLEMENTED and emits one terminal', async () => {
    const context = recordingContext('cert-op');
    const result = await unimplementedCertManager().trust(context);
    expect(result.items[0]?.error?.code).toBe('NOT_IMPLEMENTED');
    expect(context.events.filter(e => e.type === 'terminal').length).toBe(1);
    expect(await unimplementedCertManager().list()).toEqual([]);
  });
});
