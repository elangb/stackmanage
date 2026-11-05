/**
 * Deterministic PHP-FPM configuration for the managed per-user service.
 * Every path is absolute, inside the module tree, and free of characters that
 * could terminate a quoted token. The pool binds loopback only.
 */
import { isAbsolute } from 'node:path';
import { LOOPBACK_ADDRESS } from './manifest';

export interface PhpFpmPaths {
  configPath: string;
  poolPath: string;
  pidPath: string;
  logPath: string;
  accessLogPath: string;
  errorLogPath: string;
  sessionsDir: string;
  tmpDir: string;
}

export interface PhpFpmOptions extends PhpFpmPaths {
  port: number;
}

const UNSAFE = /["'`{}$\\\r\n\0;]/;

export function assertSafePath(path: string): void {
  if (!isAbsolute(path)) throw new Error('path must be absolute');
  if (UNSAFE.test(path)) throw new Error('path contains unsafe characters');
}

export function assertSafePort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid port');
}

export function renderPhpFpmConfig(options: PhpFpmOptions): string {
  assertSafePort(options.port);
  for (const path of [
    options.configPath,
    options.poolPath,
    options.pidPath,
    options.logPath,
    options.accessLogPath,
    options.errorLogPath,
    options.sessionsDir,
    options.tmpDir
  ]) {
    assertSafePath(path);
  }
  return [
    '[global]',
    `pid = "${options.pidPath}"`,
    `error_log = "${options.logPath}"`,
    'log_level = notice',
    'daemonize = no',
    '',
    `include = "${options.poolPath}"`,
    ''
  ].join('\n');
}

export function renderPhpPoolConfig(options: PhpFpmOptions): string {
  assertSafePort(options.port);
  for (const path of [options.accessLogPath, options.errorLogPath, options.sessionsDir, options.tmpDir]) assertSafePath(path);
  return [
    '[www]',
    `listen = ${LOOPBACK_ADDRESS}:${options.port}`,
    `listen.allowed_clients = ${LOOPBACK_ADDRESS}`,
    'listen.backlog = 511',
    '',
    'pm = dynamic',
    'pm.max_children = 5',
    'pm.start_servers = 2',
    'pm.min_spare_servers = 1',
    'pm.max_spare_servers = 3',
    'pm.max_requests = 500',
    '',
    'pm.status_path = /status',
    'ping.path = /ping',
    'ping.response = pong',
    '',
    `access.log = "${options.accessLogPath}"`,
    'catch_workers_output = yes',
    'clear_env = yes',
    'security.limit_extensions = .php',
    '',
    `env[TMP] = "${options.tmpDir}"`,
    `env[TMPDIR] = "${options.tmpDir}"`,
    `env[TEMP] = "${options.tmpDir}"`,
    '',
    `php_admin_value[session.save_path] = "${options.sessionsDir}"`,
    `php_admin_value[upload_tmp_dir] = "${options.tmpDir}"`,
    `php_admin_value[error_log] = "${options.errorLogPath}"`,
    'php_admin_flag[log_errors] = on',
    ''
  ].join('\n');
}

/** Fallback php.ini used only when the validated runtime does not ship one. */
export function renderPhpIni(options: { errorLogPath: string; sessionsDir: string; tmpDir: string }): string {
  for (const path of [options.errorLogPath, options.sessionsDir, options.tmpDir]) assertSafePath(path);
  return [
    '[PHP]',
    'engine = On',
    'short_open_tag = Off',
    'expose_php = Off',
    'memory_limit = 256M',
    'max_execution_time = 30',
    'display_errors = Off',
    'log_errors = On',
    `error_log = "${options.errorLogPath}"`,
    'post_max_size = 64M',
    'upload_max_filesize = 64M',
    `upload_tmp_dir = "${options.tmpDir}"`,
    `sys_temp_dir = "${options.tmpDir}"`,
    'cgi.fix_pathinfo = 0',
    'default_charset = "UTF-8"',
    'date.timezone = UTC',
    '',
    '[Session]',
    'session.save_handler = files',
    `session.save_path = "${options.sessionsDir}"`,
    'session.use_strict_mode = 1',
    'session.cookie_httponly = 1',
    'session.cookie_samesite = Lax',
    '',
    '[opcache]',
    'opcache.enable = 1',
    'opcache.enable_cli = 0',
    'opcache.validate_timestamps = 1',
    ''
  ].join('\n');
}
