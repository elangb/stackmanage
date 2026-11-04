import { expect, it } from 'vitest';
import { BootstrapController } from '../src/renderer/bootstrap/controller';
import { DEFAULT_LIMITS } from '@stackmanage/core';
import type { SnapshotResponse } from '@stackmanage/core';

const ready: SnapshotResponse = { ok: true, data: { apiVersion: 1, appVersion: '0.1.0', worker: 'ready', implementedFeatures: ['bootstrap'], limits: DEFAULT_LIMITS } };
it('retains in-flight state across view re-entry and deduplicates refresh', async () => {
  let finish!: (value: SnapshotResponse) => void;
  let calls = 0;
  const controller = new BootstrapController(() => ({ snapshot: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }));
  const first = controller.refresh();
  const remountedView = controller;
  expect(remountedView.refresh()).toBe(first);
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(remountedView.state.status).toBe('pending');
  finish(ready);
  await first;
  expect(remountedView.state.status).toBe('ready');
  expect(remountedView.state.snapshot?.worker).toBe('ready');
});
it('cleans terminal failures and permits explicit retry', async () => {
  let calls = 0;
  const controller = new BootstrapController(() => ({ async snapshot() { if (++calls === 1) throw new Error('Disconnected'); return ready; } }));
  await controller.refresh();
  expect(controller.state.status).toBe('failed');
  await controller.refresh();
  expect(controller.state.status).toBe('ready');
  expect(calls).toBe(2);
});
