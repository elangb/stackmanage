import { describe, expect, it } from 'vitest';
import type { BridgeEventPayload, BridgeResponse, DesktopBridgeV1, EventSubscriptionHandle } from '@stackmanage/core';
import { NginxController, nginxNoticeFor } from '../src/renderer/nginx/controller';

const INSTALL = { operationId: 'nginx-op', moduleId: 'nginx' as const, version: '1.30.6', platform: 'linux' as const, architecture: 'x64' as const };

function completed(method: 'nginx.install' | 'nginx.uninstall' | 'nginx.start' | 'nginx.stop' | 'nginx.reload' = 'nginx.install'): BridgeResponse {
  return {
    ok: true,
    data: { method, data: { operationId: 'nginx-op', status: 'completed', items: [{ id: 'default', status: 'completed' }], warnings: [] } }
  } as unknown as BridgeResponse;
}

function failed(messageKey: string, code = 'UNAVAILABLE'): BridgeResponse {
  return {
    ok: true,
    data: {
      method: 'nginx.install',
      data: { operationId: 'nginx-op', status: 'failed', items: [{ id: 'nginx', status: 'failed', error: { code, messageKey, retryable: false } }], warnings: [] }
    }
  } as unknown as BridgeResponse;
}

interface Fake {
  bridge: DesktopBridgeV1;
  calls: Record<string, number>;
  emit: (payload: BridgeEventPayload) => void;
  subscriptions: () => number;
}

function fakeBridge(reply: () => Promise<BridgeResponse>): Fake {
  const calls: Record<string, number> = {};
  let listener: ((payload: BridgeEventPayload) => void) | undefined;
  let subscriptions = 0;
  const method = async (name: string): Promise<BridgeResponse> => {
    calls[name] = (calls[name] ?? 0) + 1;
    return reply();
  };
  const bridge = {
    snapshot: async () => ({ ok: true, data: {} }),
    nginxVersions: () => method('nginxVersions'),
    nginxInstall: () => method('nginxInstall'),
    nginxStatus: () => method('nginxStatus'),
    nginxList: () => method('nginxList'),
    nginxUninstall: () => method('nginxUninstall'),
    nginxStart: () => method('nginxStart'),
    nginxStop: () => method('nginxStop'),
    nginxReload: () => method('nginxReload'),
    nginxLogs: () => method('nginxLogs'),
    nginxConfig: () => method('nginxConfig'),
    onOperationEvent(cb: (payload: BridgeEventPayload) => void): EventSubscriptionHandle {
      subscriptions += 1;
      listener = cb;
      return {
        unsubscribe() {
          listener = undefined;
        }
      };
    }
  } as unknown as DesktopBridgeV1;
  return { bridge, calls, emit: payload => listener?.(payload), subscriptions: () => subscriptions };
}

describe('NginxController', () => {
  it('deduplicates re-entry and clears terminal state', async () => {
    let finish!: (value: BridgeResponse) => void;
    const fake = fakeBridge(() => new Promise(resolve => (finish = resolve)));
    const controller = new NginxController(() => fake.bridge);
    const first = controller.install(INSTALL);
    expect(controller.state.operation).toBe('install');
    expect(controller.install(INSTALL)).toBe(first);
    await Promise.resolve();
    expect(fake.calls['nginxInstall']).toBe(1);
    finish(completed());
    await first;
    expect(controller.state.operation).toBeUndefined();
    expect(controller.state.notice).toBeUndefined();
  });

  it('maps wire failures to stable keys without echoing raw keys', async () => {
    const fake = fakeBridge(async () => failed('nginx.dependenciesMissing'));
    const controller = new NginxController(() => fake.bridge);
    await controller.install(INSTALL);
    expect(controller.state.notice).toEqual({ level: 'error', messageKey: 'nginxErrorDependencies' });
    expect(JSON.stringify(controller.state)).not.toContain('nginx.dependenciesMissing');
  });

  it('reports a signature warning as information, not failure', async () => {
    const response = {
      ok: true,
      data: {
        method: 'nginx.install',
        data: {
          operationId: 'nginx-op',
          status: 'completed',
          items: [{ id: 'nginx', status: 'completed' }],
          warnings: [{ code: 'UNAVAILABLE', messageKey: 'nginx.signatureUnavailable', retryable: true }]
        }
      }
    } as unknown as BridgeResponse;
    const fake = fakeBridge(async () => response);
    const controller = new NginxController(() => fake.bridge);
    await controller.install(INSTALL);
    expect(controller.state.notice).toEqual({ level: 'info', messageKey: 'nginxNoticeSignatureUnavailable' });
  });

  it('subscribes once, drops stale/foreign progress and detaches once', async () => {
    const fake = fakeBridge(() => new Promise(() => undefined));
    const controller = new NginxController(() => fake.bridge);
    controller.attach();
    controller.attach();
    expect(fake.subscriptions()).toBe(1);
    void controller.start({ operationId: 'nginx-op' });
    await Promise.resolve();
    fake.emit({ operationId: 'other', sequence: 9 });
    expect(controller.state.lastSequence).toBe(-1);
    fake.emit({ operationId: 'nginx-op', sequence: 2, stageKey: 'nginx.build', fraction: 0.7 });
    expect(controller.state.progress).toEqual({ stage: 'nginx.build', value: 0.7 });
    fake.emit({ operationId: 'nginx-op', sequence: 1 });
    expect(controller.state.lastSequence).toBe(2);
    controller.detach();
    controller.detach();
    expect(fake.subscriptions()).toBe(1);
  });

  it('keeps reads out of operation state', async () => {
    const fake = fakeBridge(async () => ({ ok: true, data: { method: 'nginx.list', data: { moduleId: 'nginx', installations: [] } } }) as unknown as BridgeResponse);
    const controller = new NginxController(() => fake.bridge);
    await controller.list();
    expect(controller.state.operation).toBeUndefined();
    expect(controller.state.notice).toBeUndefined();
  });

  it('maps known and unknown errors without leaking details', () => {
    expect(nginxNoticeFor({ code: 'CONFLICT', messageKey: 'nginx.portInUse' }).messageKey).toBe('nginxErrorPortInUse');
    expect(nginxNoticeFor({ code: 'FORBIDDEN', messageKey: 'nginx.privateDetail' }).messageKey).toBe('nginxErrorForbidden');
    expect(nginxNoticeFor({ code: 'NOT_IMPLEMENTED', messageKey: 'nginx.privateDetail' }).messageKey).toBe('nginxErrorPlatformUnsupported');
  });
});
