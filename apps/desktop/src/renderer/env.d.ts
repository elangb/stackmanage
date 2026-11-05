import type { DesktopBridgeV1 } from '@stackmanage/core';

declare global {
  interface Window {
    readonly stackmanage: DesktopBridgeV1 & {
      checkForUpdates(): Promise<{ status: 'unavailable' | 'current' | 'downloaded' | 'failed' }>;
      installUpdate(): Promise<boolean>;
      openReleases(): Promise<boolean>;
      onUpdateReady(listener: () => void): { unsubscribe(): void };
    };
  }
}
