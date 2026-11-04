export { PluginManifestSchema, API_VERSION } from '@stackmanage/core';
export type { PluginManifest, PluginHost, ModuleDefinition, OperationContext, OperationResult } from '@stackmanage/core';

/** Host runtime/isolation implementation is a later phase. */
export const pluginRuntimeStatus = 'not-implemented' as const;
