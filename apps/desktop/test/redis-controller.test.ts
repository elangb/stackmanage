import { describe, expect, it } from 'vitest';
import type { BridgeEventPayload, BridgeResponse, DesktopBridgeV1, EventSubscriptionHandle } from '@stackmanage/core';
import { RedisController, redisNoticeFor } from '../src/renderer/redis/controller';

const INSTALL = { operationId: 'redis-op', moduleId: 'redis' as const, version: '7.2.7', platform: 'linux' as const, architecture: 'x64' as const };

function completed(method: 'redis.install' | 'redis.uninstall' | 'redis.start' | 'redis.stop' = 'redis.install'): BridgeResponse {
  return {
    ok: true,
    data: { method, data: { operationId: 'redis-op', status: 'completed', items: [{ id: 'default', status: 'completed' }], warnings: [] } }
  } as unknown as BridgeResponse;
}

function failed(messageKey: string, code = 'UNAVAILABLE'): BridgeResponse {
  return {
    ok: true,
    data: {
      method: 'redis.install',
      data: { operationId: 'redis-op', status: 'failed', items: [{ id: 'redis', status: 'failed', error: { code, messageKey, retryable: false } }], warnings: [] }
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
    redisVersions: () => method('redisVersions'),
    redisInstall: () => method('redisInstall'),
    redisStatus: () => method('redisStatus'),
    redisList: () => method('redisList'),
    redisUninstall: () => method('redisUninstall'),
    redisStart: () => method('redisStart'),
    redisStop: () => method('redisStop'),
    redisLogs: () => method('redisLogs'),
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

describe('RedisController', () => {
  it('deduplicates re-entry and clears terminal state', async () => {
    let finish!: (value: BridgeResponse) => void;
    const fake = fakeBridge(() => new Promise(resolve => (finish = resolve)));
    const controller = new RedisController(() => fake.bridge);
    const first = controller.install(INSTALL);
    expect(controller.state.operation).toBe('install');
    expect(controller.install(INSTALL)).toBe(first);
    await Promise.resolve();
    expect(fake.calls['redisInstall']).toBe(1);
    finish(completed());
    await first;
    expect(controller.state.operation).toBeUndefined();
    expect(controller.state.notice).toBeUndefined();
  });

  it('maps wire failures to stable keys without echoing raw keys', async () => {
    const fake = fakeBridge(async () => failed('redis.dependenciesMissing'));
    const controller = new RedisController(() => fake.bridge);
    await controller.install(INSTALL);
    expect(controller.state.notice).toEqual({ level: 'error', messageKey: 'redisErrorDependencies' });
    expect(JSON.stringify(controller.state)).not.toContain('redis.dependenciesMissing');
  });

  it('subscribes once, drops stale/foreign progress and detaches once', async () => {
    const fake = fakeBridge(() => new Promise(() => undefined));
    const controller = new RedisController(() => fake.bridge);
    controller.attach();
    controller.attach();
    expect(fake.subscriptions()).toBe(1);
    void controller.start({ operationId: 'redis-op' });
    await Promise.resolve();
    fake.emit({ operationId: 'other', sequence: 9 });
    expect(controller.state.lastSequence).toBe(-1);
    fake.emit({ operationId: 'redis-op', sequence: 2, stageKey: 'redis.build', fraction: 0.7 });
    expect(controller.state.progress).toEqual({ stage: 'redis.build', value: 0.7 });
    fake.emit({ operationId: 'redis-op', sequence: 1 });
    expect(controller.state.lastSequence).toBe(2);
    controller.detach();
    controller.detach();
    expect(fake.subscriptions()).toBe(1);
  });

  it('keeps reads out of operation state', async () => {
    const fake = fakeBridge(async () => ({ ok: true, data: { method: 'redis.list', data: { moduleId: 'redis', installations: [] } } }) as unknown as BridgeResponse);
    const controller = new RedisController(() => fake.bridge);
    await controller.list();
    expect(controller.state.operation).toBeUndefined();
    expect(controller.state.notice).toBeUndefined();
  });

  it('maps known and unknown errors without leaking details', () => {
    expect(redisNoticeFor({ code: 'CONFLICT', messageKey: 'redis.portInUse' }).messageKey).toBe('redisErrorPortInUse');
    expect(redisNoticeFor({ code: 'FORBIDDEN', messageKey: 'redis.privateDetail' }).messageKey).toBe('redisErrorForbidden');
    expect(redisNoticeFor({ code: 'NOT_IMPLEMENTED', messageKey: 'redis.privateDetail' }).messageKey).toBe('redisErrorPlatformUnsupported');
  });
});
