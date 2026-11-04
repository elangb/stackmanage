import { reactiveBind } from '@stackmanage/ui';
import type { DesktopBridgeV1, Snapshot } from '@stackmanage/core';

export class BootstrapController {
  readonly state = reactiveBind<{ status: 'idle' | 'pending' | 'ready' | 'failed'; snapshot: Snapshot | undefined }>({ status: 'idle', snapshot: undefined });
  private inFlight: Promise<void> | undefined;
  constructor(private readonly bridge: () => DesktopBridgeV1) {}

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.state.status = 'pending';
    this.inFlight = Promise.resolve().then(() => this.bridge().snapshot()).then(response => {
      if (!response.ok) { this.state.status = 'failed'; return; }
      this.state.snapshot = response.data;
      this.state.status = 'ready';
    }).catch(() => { this.state.status = 'failed'; }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
}
export const bootstrapController = new BootstrapController(() => window.stackmanage);
