import type { DesktopBridgeV1 } from '@stackmanage/core';

declare global {
  interface Window {
    readonly stackmanage: DesktopBridgeV1;
  }
}
