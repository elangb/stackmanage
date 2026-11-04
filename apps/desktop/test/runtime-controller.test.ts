import { describe, expect, it } from 'vitest';
import type { BridgeEventPayload, BridgeResponse, DesktopBridgeV1, EventSubscriptionHandle } from '@stackmanage/core';
import { RuntimeController, runtimeNoticeFor } from '../src/renderer/runtime/controller';

const INSTALL = { operationId: 'op-install', moduleId: 'node', version: '24.22.2', platform: 'linux' as const, architecture: 'x64' as const };

function completed(method: 'runtime.install' | 'runtime.uninstall' = 'runtime.install', operationId = 'op-install'): BridgeResponse {
  return { ok: true, data: { method, data: { operationId, status: 'completed', items: [{ id: 'node-24.22.2-linux-x64', status: 'completed' }], warnings: [] } } } as unknown as BridgeResponse;
}

function failed(messageKey: string, code = 'IO_ERROR'): BridgeResponse {
  return {
    ok: true,
    data: {
      method: 'runtime.install',
      data: { operationId: 'op-install', status: 'failed', items: [{ id: 'node', status: 'failed', error: { code, messageKey, retryable: false } }], warnings: [] }
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
    snapshot: async () => ({ ok: true, data: {} }) as never,
    runtimeVersions: () => method('runtimeVersions'),
    runtimeInstall: () => method('runtimeInstall'),
    runtimeStatus: () => method('runtimeStatus'),
    runtimeList: () => method('runtimeList'),
    runtimeUninstall: () => method('runtimeUninstall'),
    onOperationEvent(cb: (payload: BridgeEventPayload) => void): EventSubscriptionHandle {
      subscriptions += 1;
      listener = cb;
      return { unsubscribe() { listener = undefined; } };
    }
  } as unknown as DesktopBridgeV1;
  return { bridge, calls, emit: payload => listener?.(payload), subscriptions: () => subscriptions };
}

describe('RuntimeController', () => {
  it('deduplicates re-entry and keeps state until the terminal result', async () => {
    let finish!: (value: BridgeResponse) => void;
    const fake = fakeBridge(() => new Promise(resolve => (finish = resolve)));
    const controller = new RuntimeController(() => fake.bridge);
    const first = controller.install(INSTALL);
    expect(controller.state.operation).toBe('install');
    expect(controller.install(INSTALL)).toBe(first);
    await Promise.resolve();
    expect(fake.calls['runtimeInstall']).toBe(1);
    finish(completed());
    await first;
    expect(controller.state.operation).toBeUndefined();
    expect(controller.state.notice).toBeUndefined();
  });

  it('maps a failed operation to a stable key and never raw text', async () => {
    const fake = fakeBridge(async () => failed('runtime.digestMismatch'));
    const controller = new RuntimeController(() => fake.bridge);
    await controller.install(INSTALL);
    expect(controller.state.notice).toEqual({ level: 'error', messageKey: 'runtimeErrorDigestMismatch' });
    expect(JSON.stringify(controller.state)).not.toContain('runtime.digestMismatch');
  });

  it('surfaces a timeout and allows an explicit retry', async () => {
    let attempt = 0;
    const fake = fakeBridge(async () => (++attempt === 1 ? ({ ok: false, error: { code: 'TIMEOUT', messageKey: 'timeout', retryable: true } } as BridgeResponse) : completed()));
    const controller = new RuntimeController(() => fake.bridge);
    await controller.install(INSTALL);
    expect(controller.state.notice).toEqual({ level: 'error', messageKey: 'runtimeErrorTimeout' });
    await controller.install(INSTALL);
    expect(controller.state.notice).toBeUndefined();
    expect(fake.calls['runtimeInstall']).toBe(2);
  });

  it('clears terminal state when the bridge throws without leaking the exception', async () => {
    const fake = fakeBridge(async () => {
      throw new Error('/home/user/secret leaked');
    });
    const controller = new RuntimeController(() => fake.bridge);
    const response = await controller.install(INSTALL);
    expect(response.ok).toBe(false);
    expect(controller.state.notice).toEqual({ level: 'error', messageKey: 'runtimeErrorUnknown' });
    expect(JSON.stringify(controller.state)).not.toContain('/home/user/secret');
  });

  it('subscribes once and cleans up the listener exactly once', () => {
    const fake = fakeBridge(async () => completed());
    const controller = new RuntimeController(() => fake.bridge);
    controller.attach();
    controller.attach();
    expect(fake.subscriptions()).toBe(1);
    controller.detach();
    controller.detach();
    expect(fake.subscriptions()).toBe(1);
  });

  it('drops stale, foreign and replayed progress frames', async () => {
    const fake = fakeBridge(() => new Promise(() => undefined));
    const controller = new RuntimeController(() => fake.bridge);
    controller.attach();
    void controller.install(INSTALL);
    await Promise.resolve();
    fake.emit({ operationId: 'other', sequence: 9 });
    expect(controller.state.lastSequence).toBe(-1);
    fake.emit({ operationId: 'op-install', sequence: 2, stageKey: 'runtime.download', fraction: 0.5 });
    expect(controller.state.progress).toEqual({ stage: 'runtime.download', value: 0.5 });
    fake.emit({ operationId: 'op-install', sequence: 1 });
    expect(controller.state.lastSequence).toBe(2);
  });

  it('keeps reads out of operation state', async () => {
    const fake = fakeBridge(async () => ({ ok: true, data: { method: 'runtime.list', data: { moduleId: 'node', installations: [] } } }) as unknown as BridgeResponse);
    const controller = new RuntimeController(() => fake.bridge);
    await controller.list('node');
    expect(controller.state.operation).toBeUndefined();
    expect(controller.state.notice).toBeUndefined();
  });

  it('reports a checksum-list warning without disguising it as a failure', async () => {
    const response = {
      ok: true,
      data: {
        method: 'runtime.install',
        data: {
          operationId: 'op-install',
          status: 'completed',
          items: [{ id: 'node-24.22.2-linux-x64', status: 'completed' }],
          warnings: [{ code: 'IO_ERROR', messageKey: 'runtime.checksumListUnavailable', retryable: true }]
        }
      }
    } as unknown as BridgeResponse;
    const fake = fakeBridge(async () => response);
    const controller = new RuntimeController(() => fake.bridge);
    await controller.install(INSTALL);
    expect(controller.state.notice).toEqual({ level: 'info', messageKey: 'runtimeNoticeChecksumListUnavailable' });
    expect(controller.state.operation).toBeUndefined();
  });
});

describe('runtimeNoticeFor', () => {
  it('maps known failures and never echoes unknown wire keys', () => {
    expect(runtimeNoticeFor({ code: 'IO_ERROR', messageKey: 'runtime.digestMismatch' }).messageKey).toBe('runtimeErrorDigestMismatch');
    expect(runtimeNoticeFor({ code: 'IO_ERROR', messageKey: 'runtime.privateDetail' }).messageKey).toBe('runtimeErrorUnknown');
    expect(runtimeNoticeFor({ code: 'FORBIDDEN', messageKey: 'x' }).messageKey).toBe('runtimeErrorForbidden');
  });
});
