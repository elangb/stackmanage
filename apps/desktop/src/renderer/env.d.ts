import type { DesktopBridgeV1 } from '@stackmanage/core';

declare global {
  interface Window {
    readonly stackmanage: DesktopBridgeV1 & {
      checkForUpdates(): Promise<{ status: 'unavailable' | 'current' | 'downloaded' | 'failed' }>;
      installUpdate(): Promise<boolean>;
      openReleases(): Promise<boolean>;
      onUpdateReady(listener: () => void): { unsubscribe(): void };
      workflowGroupsList(request: unknown): Promise<unknown>;
      workflowGroupSave(request: unknown): Promise<unknown>;
      workflowGroupRemove(request: unknown): Promise<unknown>;
      workflowGroupRun(request: unknown): Promise<unknown>;
      managedServicesList(request: unknown): Promise<unknown>;
    };
  }
}
