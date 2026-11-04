import type { DesktopBridge } from '@stackmanage/core';
declare global { interface Window { readonly stackmanage: DesktopBridge } }
