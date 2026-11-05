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

const REF = { moduleId: 'caddy', installationId: 'caddy-2.11.8', instanceId: 'default' };

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
      status: { instanceId: 'default' },
      listServices: {},
      listInstallations: {},
      logsTail: { instanceId: 'default', maxBytes: 4096 },
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
      sitesRemove: { operationId: 'op-5', siteId: 'default' },
      certificateStatus: {},
      trustCertificate: { operationId: 'op-6' },
      runtimeVersions: { moduleId: 'node' },
      runtimeInstall: { operationId: 'op-7', moduleId: 'node', version: '24.22.2', platform: 'linux', architecture: 'x64' },
      runtimeStatus: { moduleId: 'node' },
      runtimeList: { moduleId: 'node' },
      runtimeUninstall: { operationId: 'op-8', installationId: 'node-24.22.2-linux-x64' },
      nginxVersions: { moduleId: 'nginx' },
      nginxInstall: { operationId: 'op-9', moduleId: 'nginx', version: '1.30.6', platform: 'linux', architecture: 'x64' },
      nginxStatus: { moduleId: 'nginx' },
      nginxList: { moduleId: 'nginx' },
      nginxUninstall: { operationId: 'op-10', installationId: 'nginx-1.30.6-linux-x64' },
      nginxStart: { operationId: 'op-11' },
      nginxStop: { operationId: 'op-12' },
      nginxReload: { operationId: 'op-13' },
      nginxLogs: { maxBytes: 4096 },
      nginxConfig: {},
      redisVersions: { moduleId: 'redis' },
      redisInstall: { operationId: 'op-14', moduleId: 'redis', version: '7.2.7', platform: 'linux', architecture: 'x64' },
      redisStatus: { moduleId: 'redis' },
      redisList: { moduleId: 'redis' },
      redisUninstall: { operationId: 'op-15', installationId: 'redis-7.2.7-linux-x64' },
      redisStart: { operationId: 'op-16' },
      redisStop: { operationId: 'op-17' },
      redisLogs: { maxBytes: 4096 },
      phpVersions: { moduleId: 'php' },
      phpInstall: { operationId: 'op-18', moduleId: 'php', version: '8.5.12', platform: 'linux', architecture: 'x64' },
      phpStatus: { moduleId: 'php' },
      phpList: { moduleId: 'php' },
      phpUninstall: { operationId: 'op-19', installationId: 'php-8.5.12' },
      phpStart: { operationId: 'op-20' },
      phpStop: { operationId: 'op-21' },
      phpLogs: { maxBytes: 4096 }
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(DESKTOP_METHODS).sort());
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
    // Runtime install reuses the same closed shape: no URL/digest/path/command can be supplied.
    for (const injected of [{ url: 'https://evil.test/node.tar.gz' }, { sha256: 'a'.repeat(64) }, { path: '/etc/passwd' }, { command: 'sh' }]) {
      expect(BRIDGE_REQUEST_SCHEMAS.runtimeInstall.safeParse({ operationId: 'op', moduleId: 'node', version: '24.22.2', platform: 'linux', architecture: 'x64', ...injected }).success).toBe(false);
    }
    expect(() => parseBoundedBridgeRequest('runtimeUninstall', { operationId: 'op', installationId: '../../etc' })).toThrow();
    for (const injected of [{ url: 'https://evil.test/nginx.tar.gz' }, { sha256: 'a'.repeat(64) }, { configure: '--prefix=/usr' }, { path: '/etc/passwd' }, { command: 'sh' }]) {
      expect(BRIDGE_REQUEST_SCHEMAS.nginxInstall.safeParse({ operationId: 'op', moduleId: 'nginx', version: '1.30.6', platform: 'linux', architecture: 'x64', ...injected }).success).toBe(false);
    }
    expect(() => parseBoundedBridgeRequest('nginxUninstall', { operationId: 'op', installationId: '../../etc' })).toThrow();
    expect(() => parseBoundedBridgeRequest('nginxStart', { operationId: 'op', command: 'sh' })).toThrow();
    expect(() => parseBoundedBridgeRequest('nginxVersions', { moduleId: 'caddy' })).toThrow();
    expect(() => parseBoundedBridgeRequest('nginxLogs', { maxBytes: 0 })).toThrow();
    for (const injected of [{ url: 'https://evil.test/redis.tar.gz' }, { sha256: 'a'.repeat(64) }, { path: '/etc/passwd' }, { command: 'sh' }, { port: 6379 }]) {
      expect(BRIDGE_REQUEST_SCHEMAS.redisInstall.safeParse({ operationId: 'op', moduleId: 'redis', version: '7.2.7', platform: 'linux', architecture: 'x64', ...injected }).success).toBe(false);
    }
    expect(() => parseBoundedBridgeRequest('redisUninstall', { operationId: 'op', installationId: '../../etc' })).toThrow();
    expect(() => parseBoundedBridgeRequest('redisStart', { operationId: 'op', command: 'sh' })).toThrow();
    expect(() => parseBoundedBridgeRequest('redisVersions', { moduleId: 'nginx' })).toThrow();
    expect(() => parseBoundedBridgeRequest('redisLogs', { maxBytes: 0 })).toThrow();
    expect(SitesApplyRequestSchema.safeParse({ operationId: 'op', sites: [] }).success).toBe(false);
    expect(() => parseBoundedBridgeRequest('sitesRemove', { operationId: 'op', siteId: '../../etc' })).toThrow();
    expect(() => parseBoundedBridgeRequest('start', { operationId: 'op', ref: REF, command: 'sh' })).toThrow();
    expect(() => parseBoundedBridgeRequest('unknown-method' as never, {})).toThrow();
  });

  it('derives a finite operation deadline for every method', () => {
    expect(Object.values(OPERATION_TIMEOUTS).every(value => Number.isFinite(value) && value > 0)).toBe(true);
    // Every method names a bounded operation class; nothing waits forever.
    for (const method of Object.keys(DESKTOP_METHODS)) {
      const cls = method === 'install' || method === 'nginxInstall' || method === 'redisInstall' ? 'install' : method === 'runtimeInstall' ? 'runtimeInstall' : method.startsWith('list') || method === 'status' || method === 'logsTail' || method === 'runtimeStatus' || method === 'runtimeList' || method === 'runtimeVersions' || method === 'nginxStatus' || method === 'nginxList' || method === 'nginxVersions' || method === 'nginxLogs' || method === 'nginxConfig' || method === 'redisStatus' || method === 'redisList' || method === 'redisVersions' || method === 'redisLogs' ? 'read' : method.startsWith('sites') ? 'sites' : 'service';
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

  it('accepts only bounded progress frames', () => {
    const frame = { operationId: 'op-1', sequence: 1, stageKey: 'install.download', fraction: 0.5 };
    expect(BridgeEventPayloadSchema.safeParse(frame).success).toBe(true);
    expect(BridgeEventPayloadSchema.safeParse({ ...frame, sequence: -1 }).success).toBe(false);
    expect(BridgeEventPayloadSchema.safeParse({ ...frame, fraction: 1.1 }).success).toBe(false);
    expect(BridgeEventPayloadSchema.safeParse({ ...frame, stack: 'at x' }).success).toBe(false);
    expect(BridgeEventPayloadSchema.safeParse({ operationId: 'op-1' }).success).toBe(false);
  });

  it('rejects a completed result that hides a failed item', () => {
    const failedItem = { id: 'default', status: 'failed', error: { code: 'CONFLICT', messageKey: 'service.portInUse', retryable: false } };
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
