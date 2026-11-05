import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  BridgeEventPayloadSchema,
  BridgeResponseSchema,
  DESKTOP_METHODS,
  EVENT_CHANNEL,
  IPC_CHANNEL,
  parseBounded,
  parseBoundedBridgeRequest,
  SnapshotRequestSchema,
  SnapshotResponseSchema,
  type BridgeEventPayload,
  type BridgeResponse,
  type DesktopBridgeV1,
  type DesktopMethodName,
  type EventSubscriptionHandle
} from '@stackmanage/core';

const MAX_SUBSCRIBERS = 16;
const subscribers = new Set<(event: IpcRendererEvent, raw: unknown) => void>();

/** Bridge methods map 1:1 to fixed main channels; the renderer never supplies a channel name. */
const METHODS = Object.keys(DESKTOP_METHODS) as DesktopMethodName[];

const bridge: DesktopBridgeV1 = Object.freeze({
  async snapshot() {
    const request = SnapshotRequestSchema.parse({ apiVersion: 1 });
    return parseBounded(SnapshotResponseSchema, await ipcRenderer.invoke(IPC_CHANNEL, request));
  },
  async checkForUpdates() {
    return ipcRenderer.invoke('updates:check') as Promise<{ status: 'unavailable' | 'current' | 'downloaded' | 'failed' }>;
  },
  async installUpdate() {
    return ipcRenderer.invoke('updates:install') as Promise<boolean>;
  },
  async openReleases() {
    return ipcRenderer.invoke('updates:open-releases') as Promise<boolean>;
  },
  onUpdateReady(listener: () => void) {
    const handler = (): void => listener();
    ipcRenderer.on('updates:ready', handler);
    return Object.freeze({ unsubscribe: () => ipcRenderer.removeListener('updates:ready', handler) });
  },
  ...(Object.fromEntries(
    METHODS.map(method => [
      method,
      async (request: unknown): Promise<BridgeResponse> => {
        const payload = parseBoundedBridgeRequest(method, request);
        return parseBounded(BridgeResponseSchema, await ipcRenderer.invoke(DESKTOP_METHODS[method], payload));
      }
    ])
  ) as Pick<DesktopBridgeV1, DesktopMethodName>),
  onOperationEvent(listener: (payload: BridgeEventPayload) => void): EventSubscriptionHandle {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (subscribers.size >= MAX_SUBSCRIBERS) throw new Error('CONFLICT');
    const wrapped = (_event: IpcRendererEvent, raw: unknown): void => {
      const parsed = BridgeEventPayloadSchema.safeParse(raw);
      if (!parsed.success) return; // Malformed or unexpected frames never reach the listener.
      listener(parsed.data);
    };
    subscribers.add(wrapped);
    ipcRenderer.on(EVENT_CHANNEL, wrapped);
    return Object.freeze({
      unsubscribe() {
        if (!subscribers.delete(wrapped)) return;
        ipcRenderer.removeListener(EVENT_CHANNEL, wrapped);
      }
    });
  }
});

contextBridge.exposeInMainWorld('stackmanage', bridge);
