import type { CertManager, HostsManager, ModuleStorage } from '@stackmanage/core';

/** Contract only: privileged adapters must report unsupported until implemented and tested. */
export interface PlatformAdapter {
  readonly platform: 'win32' | 'linux' | 'darwin';
  readonly hosts: HostsManager;
  readonly certificates: CertManager;
  readonly storage: ModuleStorage;
}
export const platformImplementationStatus = 'not-implemented' as const;
