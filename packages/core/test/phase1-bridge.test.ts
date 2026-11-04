import { describe, expect, it } from 'vitest';
import {
  BRIDGE_REQUEST_SCHEMAS,
  BridgeEventPayloadSchema,
  BridgeResponseSchema,
  DESKTOP_METHODS,
  EVENT_CHANNEL,
  IPC_CHANNEL,
  InstallRequestSchema,
  OPERATION_TIMEOUTS,
  OperationResultSchema,
  ServiceRequestSchema,
  SitesApplyRequestSchema,
  parseBoundedBridgeRequest,
  safeSerialize
} from '../src';

const REF = { moduleId: 'caddy', installationId: 'caddy-2.11.8', instanceId: 'caddy-default' };

describe('Phase 1 bridge contract', () => {
  it('exposes one fixed channel per method and none is a generic exec surface', () => {
    const channels = Object.values(DESKTOP_METHODS);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.every(channel => channel.startsWith('stackmanage:v1:'))).toBe(true);
    expect(channels).not.toContain(IPC_CHANNEL);
    expect(EVENT_CHANNEL).not.toBe(IPC_CHANNEL);
    expect(Object.keys(DESKTOP_METHODS)).not.toContain('exec');
  });

  it('accepts a well-formed request for every method', () => {
    const samples: Record<keyof typeof BRIDGE_REQUEST_SCHEMAS, unknown> = {
      install: { operationId: 'op-install', moduleId: 'caddy', version: '2.11.8', platform: 'linux', architecture: 'x64' },
      start: { operationId: 'op-1', ref: REF },
      stop: { operationId: 'op-2', ref: REF },
      restart: { operationId: 'op-3', ref: REF },
      status: { instanceId: 'caddy-default' },
      listServices: {},
      listInstallations: {},
      logsTail: { instanceId: 'caddy-default', maxBytes: 4096 },
      sitesApply: {
        operationId: 'op-4',
        sites: [
          {
            id: 'default',
            hostname: 'localhost',
            aliases: [],
            server: REF,
            root: '/home/user/.local/share/StackManage/caddy/sites/default',
            port: 18080,
            tls: false
          }
        ]
      },
      sitesList: {},
      sitesRemove: { operationId: 'op-5', siteId: 'default' }
    };
    for (const [method, sample] of Object.entries(samples)) {
      expect(() => parseBoundedBridgeRequest(method as keyof typeof BRIDGE_REQUEST_SCHEMAS, sample), method).not.toThrow();
    }
  });

  it('rejects envelope tampering, unknown methods and injectable fields', () => {
    // The bridge request is a strict object: no smuggled transport keys.
    expect(ServiceRequestSchema.safeParse({ operationId: 'op', ref: REF, extra: true }).success).toBe(false);
    // Install stays module-agnostic: no caller-supplied URL, digest or destination path.
    expect(InstallRequestSchema.safeParse({ operationId: 'op', moduleId: 'caddy', version: '2.11.8', platform: 'linux', architecture: 'x64' }).success).toBe(true);
    for (const injected of [{ url: 'https://evil.test/x' }, { sha256: 'a'.repeat(64) }, { path: '/etc/passwd' }, { command: 'sh' }]) {
      expect(InstallRequestSchema.safeParse({ operationId: 'op', moduleId: 'caddy', version: '2.11.8', platform: 'linux', architecture: 'x64', ...injected }).success).toBe(false);
    }
    expect(InstallRequestSchema.safeParse({ operationId: 'op', moduleId: 'caddy', version: '2.11.8', platform: 'freebsd', architecture: 'x64' }).success).toBe(false);
    expect(SitesApplyRequestSchema.safeParse({ operationId: 'op', sites: [] }).success).toBe(false);
    expect(() => parseBoundedBridgeRequest('sitesRemove', { operationId: 'op', siteId: '../../etc' })).toThrow();
    expect(() => parseBoundedBridgeRequest('start', { operationId: 'op', ref: REF, command: 'sh' })).toThrow();
    expect(() => parseBoundedBridgeRequest('unknown-method' as never, {})).toThrow();
  });

  it('derives a finite operation deadline for every method', () => {
    expect(Object.values(OPERATION_TIMEOUTS).every(value => Number.isFinite(value) && value > 0)).toBe(true);
    // Every method names a bounded operation class; nothing waits forever.
    for (const method of Object.keys(DESKTOP_METHODS)) {
      const cls = method === 'install' ? 'install' : method.startsWith('list') || method === 'status' || method === 'logsTail' ? 'read' : method.startsWith('sites') ? 'sites' : 'service';
      expect(OPERATION_TIMEOUTS[cls as keyof typeof OPERATION_TIMEOUTS], method).toBeGreaterThan(0);
    }
  });
});

describe('wire responses', () => {
  it('keeps transport errors distinct from operation results', () => {
    expect(BridgeResponseSchema.safeParse({ ok: false, error: { code: 'TIMEOUT', messageKey: 'timeout', retryable: true } }).success).toBe(true);
    // A transport failure cannot smuggle a stack trace or a raw message.
    expect(BridgeResponseSchema.safeParse({ ok: false, error: { code: 'IO_ERROR', messageKey: 'x', retryable: false, stack: 'at x' } }).success).toBe(false);
    expect(BridgeResponseSchema.safeParse({ ok: false, error: { code: 'IO_ERROR', message: '/home/user/secret', retryable: false } }).success).toBe(false);
  });

  it('accepts only monotonic progress frames', () => {
    const frame = { operationId: 'op-1', sequence: 1, lastSequence: 1 };
    expect(BridgeEventPayloadSchema.safeParse(frame).success).toBe(true);
    expect(BridgeEventPayloadSchema.safeParse({ ...frame, sequence: -1 }).success).toBe(false);
    expect(BridgeEventPayloadSchema.safeParse({ ...frame, stack: 'at x' }).success).toBe(false);
    expect(BridgeEventPayloadSchema.safeParse({ operationId: 'op-1' }).success).toBe(false);
  });

  it('rejects a completed result that hides a failed item', () => {
    const failedItem = { id: 'caddy-default', status: 'failed', error: { code: 'CONFLICT', messageKey: 'service.portInUse', retryable: false } };
    expect(OperationResultSchema.safeParse({ operationId: 'op', status: 'completed', items: [failedItem], warnings: [] }).success).toBe(false);
    expect(OperationResultSchema.safeParse({ operationId: 'op', status: 'partial', items: [failedItem], warnings: [] }).success).toBe(true);
  });
});

describe('safeSerialize', () => {
  it('refuses cycles and non-wire values instead of emitting raw errors', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => safeSerialize(cycle)).toThrow('INVALID_REQUEST');
    expect(() => safeSerialize({ fn: () => undefined })).toThrow('INVALID_REQUEST');
    expect(() => safeSerialize({ big: 1n })).toThrow('INVALID_REQUEST');
    expect(safeSerialize({ ok: true })).toBe('{"ok":true}');
  });
});
