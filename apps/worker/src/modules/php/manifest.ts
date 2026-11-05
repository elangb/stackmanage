/**
 * PHP module policy.
 *
 * The pinned runtime is produced by `scripts/php/build-php-runtime.sh`. This
 * module never downloads an unofficial binary: it validates a runtime placed
 * under the managed installations directory (or an explicit development
 * override) before it records and runs it.
 */
export const PHP_MODULE_ID = 'php' as const;
export const PHP_VERSION = '8.5.12' as const;
export const PHP_INSTALLATION_ID = 'php-8.5.12' as const;
export const DEFAULT_INSTANCE_ID = 'default' as const;
export const LOOPBACK_ADDRESS = '127.0.0.1' as const;
/** Must match the Caddy module's FastCGI endpoint. */
export const PHP_PORT = 19000 as const;
export const PHP_FASTCGI_ADDRESS = `${LOOPBACK_ADDRESS}:${PHP_PORT}` as const;

export const PHP_LIMITS = Object.freeze({
  maxLogBytes: 1_048_576,
  startTimeoutMs: 10_000,
  stopGraceMs: 5_000,
  stopKillMs: 3_000
});
export type PhpLimits = typeof PHP_LIMITS;
