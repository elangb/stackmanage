import { describe, expect, it } from 'vitest';
import type { BridgeEventPayload, BridgeResponse, DesktopBridgeV1, EventSubscriptionHandle } from '@stackmanage/core';
import { CaddyController, noticeFor } from '../src/renderer/caddy/controller';

const REF = { moduleId: 'caddy', installationId: 'caddy-2.11.8', instanceId: 'caddy-default' };

function completed(operationId = 'op'): BridgeResponse {
  return { ok: true, data: { method: 'service.start', data: { operationId, status: 'completed', items: [{ id: 'caddy-default', status: 'completed' }], warnings: [] } } } as unknown as BridgeResponse;
}

function failed(messageKey: string, code = 'CONFLICT'): BridgeResponse {
  return {
    ok: true,
    data: {
      method: 'service.start',
      data: { operationId: 'op', status: 'failed', items: [{ id: 'caddy-default', status: 'failed', error: { code, messageKey, retryable: false } }], warnings: [] }
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
  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const method = async (name: string): Promise<BridgeResponse> => {
    count(name);
    return reply();
  };
  const bridge = {
    snapshot: async () => ({ ok: true, data: {} }) as never,
    install: () => method('install'),
    start: () => method('start'),
    stop: () => method('stop'),
    restart: () => method('restart'),
    status: () => method('status'),
    listServices: () => method('listServices'),
    listInstallations: () => method('listInstallations'),
    logsTail: () => method('logsTail'),
    sitesApply: () => method('sitesApply'),
    sitesList: () => method('sitesList'),
    sitesRemove: () => method('sitesRemove'),
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
  return {
    bridge,
    calls,
    emit: payload => listener?.(payload),
    subscriptions: () => subscriptions
  };
}

describe('CaddyController', () => {
  it('deduplicates re-entry and keeps the operation state until it settles', async () => {
    let finish!: (value: BridgeResponse) => void;
    const fake = fakeBridge(() => new Promise(resolve => (finish = resolve)));
    const controller = new CaddyController(() => fake.bridge);
    const first = controller.start({ operationId: 'op', ref: REF });
    expect(controller.state.operation).toBe('start');
    expect(controller.start({ operationId: 'op', ref: REF })).toBe(first);
    await Promise.resolve();
    expect(fake.calls['start']).toBe(1);
    finish(completed());
    await first;
    expect(controller.state.operation).toBeUndefined();
    expect(controller.state.notice).toBeUndefined();
  });

  it('maps a failed result to a stable message key and never raw text', async () => {
    const fake = fakeBridge(async () => failed('service.portInUse'));
    const controller = new CaddyController(() => fake.bridge);
    await controller.start({ operationId: 'op', ref: REF });
    expect(controller.state.notice).toEqual({ level: 'error', messageKey: 'caddy.service.portInUse' });
    expect(controller.state.operation).toBeUndefined();
  });

  it('surfaces a transport error and allows a clean retry', async () => {
    let attempt = 0;
    const fake = fakeBridge(async () => (++attempt === 1 ? ({ ok: false, error: { code: 'TIMEOUT', messageKey: 'timeout', retryable: true } } as BridgeResponse) : completed()));
    const controller = new CaddyController(() => fake.bridge);
    await controller.stop({ operationId: 'op', ref: REF });
    expect(controller.state.notice).toEqual({ level: 'error', messageKey: 'caddy.error.timeout' });
    await controller.stop({ operationId: 'op', ref: REF });
    expect(controller.state.notice).toBeUndefined();
    expect(fake.calls['stop']).toBe(2);
  });

  it('clears terminal state when the bridge throws', async () => {
    const fake = fakeBridge(async () => {
      throw new Error('/home/user/secret leaked');
    });
    const controller = new CaddyController(() => fake.bridge);
    const response = await controller.install({ operationId: 'op', moduleId: 'caddy', version: '2.11.8', platform: 'linux', architecture: 'x64' });
    expect(response.ok).toBe(false);
    expect(controller.state.notice).toEqual({ level: 'error', messageKey: 'caddy.error.unknown' });
    expect(JSON.stringify(controller.state)).not.toContain('/home/user/secret');
  });

  it('subscribes once and unsubscribes exactly once', () => {
    const fake = fakeBridge(async () => completed());
    const controller = new CaddyController(() => fake.bridge);
    controller.attach();
    controller.attach();
    expect(fake.subscriptions()).toBe(1);
    controller.detach();
    controller.detach();
    expect(fake.subscriptions()).toBe(1);
  });

  it('drops stale and replayed progress frames', () => {
    const fake = fakeBridge(async () => completed());
    const controller = new CaddyController(() => fake.bridge);
    controller.attach();
    fake.emit({ operationId: 'op', sequence: 3, lastSequence: 3 });
    expect(controller.state.lastSequence).toBe(3);
    fake.emit({ operationId: 'op', sequence: 2, lastSequence: 3 });
    expect(controller.state.lastSequence).toBe(3);
  });

  it('keeps reads out of the operation state', async () => {
    const fake = fakeBridge(async () => ({ ok: true, data: { method: 'services.list', data: { services: [] } } }) as unknown as BridgeResponse);
    const controller = new CaddyController(() => fake.bridge);
    await controller.listServices();
    expect(controller.state.operation).toBeUndefined();
    expect(controller.state.notice).toBeUndefined();
  });
});

describe('noticeFor', () => {
  it('never echoes the wire message key verbatim for unknown errors', () => {
    expect(noticeFor({ code: 'IO_ERROR', messageKey: 'install.commitFailed' }).messageKey).toBe('caddy.error.unknown');
    expect(noticeFor({ code: 'IO_ERROR', messageKey: 'install.digestMismatch' }).messageKey).toBe('caddy.install.digestMismatch');
  });
});
