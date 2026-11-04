import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNEL, parseBounded, SnapshotRequestSchema, SnapshotResponseSchema } from '@stackmanage/core';
import type { DesktopBridge } from '@stackmanage/core';

const bridge: DesktopBridge = Object.freeze({
  async snapshot() {
    const request = SnapshotRequestSchema.parse({ apiVersion: 1 });
    return parseBounded(SnapshotResponseSchema, await ipcRenderer.invoke(IPC_CHANNEL, request));
  }
});
contextBridge.exposeInMainWorld('stackmanage', bridge);
