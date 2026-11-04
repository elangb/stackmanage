import { ErrorSchema, OperationResultSchema } from '@stackmanage/core';
import type { ErrorCode, OperationResult } from '@stackmanage/core';

export type PluginHostErrorCode =
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_API'
  | 'INVALID_HOST_VERSION'
  | 'INCOMPATIBLE_HOST'
  | 'SIGNATURE_REQUIRED'
  | 'UNSUPPORTED_PERMISSION'
  | 'SIGNATURE_INVALID'
  | 'TRUSTED_KEY_UNKNOWN'
  | 'REGISTRY_INVALID'
  | 'REGISTRY_SIGNATURE_INVALID'
  | 'PACKAGE_DIGEST_MISMATCH'
  | 'MANIFEST_DIGEST_MISMATCH'
  | 'UNSAFE_PACKAGE_PATH'
  | 'PACKAGE_TOO_LARGE'
  | 'DUPLICATE_PLUGIN'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_ENABLED'
  | 'PLUGIN_NOT_RUNNING'
  | 'PROTOCOL_ERROR'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'FORBIDDEN'
  | 'IO_ERROR'
  | 'UNKNOWN';

/** Fixed-code internal error. `detail` is for local tests/logs and never crosses a transport. */
export class PluginHostError extends Error {
  constructor(
    readonly code: PluginHostErrorCode,
    readonly detail?: string
  ) {
    super(code);
    this.name = 'PluginHostError';
  }
}

const MESSAGE_KEYS: Record<PluginHostErrorCode, string> = {
  INVALID_MANIFEST: 'plugin.invalidManifest',
  UNSUPPORTED_API: 'plugin.unsupportedApi',
  INVALID_HOST_VERSION: 'plugin.invalidHostVersion',
  INCOMPATIBLE_HOST: 'plugin.incompatibleHost',
  SIGNATURE_REQUIRED: 'plugin.signatureRequired',
  UNSUPPORTED_PERMISSION: 'plugin.unsupportedPermission',
  SIGNATURE_INVALID: 'plugin.signatureInvalid',
  TRUSTED_KEY_UNKNOWN: 'plugin.trustedKeyUnknown',
  REGISTRY_INVALID: 'plugin.registryInvalid',
  REGISTRY_SIGNATURE_INVALID: 'plugin.registrySignatureInvalid',
  PACKAGE_DIGEST_MISMATCH: 'plugin.packageDigestMismatch',
  MANIFEST_DIGEST_MISMATCH: 'plugin.manifestDigestMismatch',
  UNSAFE_PACKAGE_PATH: 'plugin.unsafePackagePath',
  PACKAGE_TOO_LARGE: 'plugin.packageTooLarge',
  DUPLICATE_PLUGIN: 'plugin.duplicate',
  PLUGIN_NOT_FOUND: 'plugin.notFound',
  PLUGIN_ENABLED: 'plugin.enabled',
  PLUGIN_NOT_RUNNING: 'plugin.notRunning',
  PROTOCOL_ERROR: 'plugin.protocolError',
  TIMEOUT: 'plugin.timeout',
  UNAVAILABLE: 'plugin.unavailable',
  FORBIDDEN: 'plugin.forbidden',
  IO_ERROR: 'plugin.ioError',
  UNKNOWN: 'plugin.unknown'
};

const ERROR_CODES: Record<PluginHostErrorCode, ErrorCode> = {
  INVALID_MANIFEST: 'INVALID_REQUEST',
  UNSUPPORTED_API: 'INVALID_REQUEST',
  INVALID_HOST_VERSION: 'INVALID_REQUEST',
  INCOMPATIBLE_HOST: 'FORBIDDEN',
  SIGNATURE_REQUIRED: 'FORBIDDEN',
  UNSUPPORTED_PERMISSION: 'FORBIDDEN',
  SIGNATURE_INVALID: 'FORBIDDEN',
  TRUSTED_KEY_UNKNOWN: 'FORBIDDEN',
  REGISTRY_INVALID: 'FORBIDDEN',
  REGISTRY_SIGNATURE_INVALID: 'FORBIDDEN',
  PACKAGE_DIGEST_MISMATCH: 'FORBIDDEN',
  MANIFEST_DIGEST_MISMATCH: 'FORBIDDEN',
  UNSAFE_PACKAGE_PATH: 'FORBIDDEN',
  PACKAGE_TOO_LARGE: 'FORBIDDEN',
  DUPLICATE_PLUGIN: 'CONFLICT',
  PLUGIN_NOT_FOUND: 'UNAVAILABLE',
  PLUGIN_ENABLED: 'CONFLICT',
  PLUGIN_NOT_RUNNING: 'UNAVAILABLE',
  PROTOCOL_ERROR: 'UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE',
  FORBIDDEN: 'FORBIDDEN',
  IO_ERROR: 'IO_ERROR',
  UNKNOWN: 'UNKNOWN'
};

export function pluginErrorMessage(code: PluginHostErrorCode): { code: ErrorCode; messageKey: string; retryable: boolean } {
  return {
    code: ERROR_CODES[code],
    messageKey: MESSAGE_KEYS[code],
    retryable: code === 'TIMEOUT' || code === 'UNAVAILABLE' || code === 'IO_ERROR'
  };
}

export function normalizePluginError(error: unknown, signal?: AbortSignal): PluginHostError {
  if (signal?.aborted === true) return new PluginHostError('UNAVAILABLE', 'cancelled');
  if (error instanceof PluginHostError) return error;
  return new PluginHostError('UNKNOWN');
}

export function failedResult(operationId: string, itemId: string, error: PluginHostError): OperationResult {
  const mapped = pluginErrorMessage(error.code);
  return OperationResultSchema.parse({
    operationId,
    status: 'failed',
    items: [{ id: itemId, status: 'failed', error: ErrorSchema.parse(mapped) }],
    warnings: []
  });
}

export function completedResult(operationId: string, itemId: string, warnings: OperationResult['warnings'] = []): OperationResult {
  return OperationResultSchema.parse({
    operationId,
    status: warnings.length > 0 ? 'partial' : 'completed',
    items: [{ id: itemId, status: 'completed' }],
    warnings
  });
}

export function stateWriteWarning(): OperationResult['warnings'][number] {
  return ErrorSchema.parse(pluginErrorMessage('IO_ERROR'));
}
