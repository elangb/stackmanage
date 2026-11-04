/**
 * Plugin child-process runner.
 *
 * This file is intentionally plain ESM with no imports from the host workspace. It is
 * forked by PluginRuntime with an argument array, a minimal environment and `cwd` set to
 * the installed plugin directory. It loads exactly one entry file and speaks JSON-RPC over
 * the Node IPC channel. stdout/stderr are diagnostics only.
 *
 * A Node child process is NOT an OS sandbox. The loaded plugin has the same OS user
 * privileges as this process; Phase 1 only avoids handing it host objects or host functions.
 */
/* global Buffer */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const MAX_MESSAGE_BYTES = 65_536;
const REQUEST_METHODS = new Set(['plugin.ping', 'plugin.status', 'plugin.shutdown']);
const startedAt = Date.now();
let pluginModule;
let deactivating = false;

const pluginId = process.env.STACKMANAGE_PLUGIN_ID;
const entry = process.env.STACKMANAGE_PLUGIN_ENTRY;
const apiVersion = Number(process.env.STACKMANAGE_PLUGIN_API_VERSION);

function serialize(value) {
  return JSON.stringify(value);
}

function send(message, after) {
  if (process.send === undefined || !process.connected) {
    if (typeof after === 'function') after();
    return;
  }
  let encoded;
  try {
    encoded = serialize(message);
  } catch {
    encoded = undefined;
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES) {
    if (typeof after === 'function') after();
    return;
  }
  try {
    process.send(message, undefined, undefined, () => {
      if (typeof after === 'function') after();
    });
  } catch {
    if (typeof after === 'function') after();
  }
}

function fatal(reason) {
  send({ jsonrpc: '2.0', method: 'plugin.fatal', params: { reason } }, () => process.exit(1));
}

function response(id, result) {
  let encoded;
  try {
    encoded = serialize({ jsonrpc: '2.0', id, result });
  } catch {
    encoded = undefined;
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_MESSAGE_BYTES) {
    fatal('protocol');
    return;
  }
  send({ jsonrpc: '2.0', id, result });
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function validId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 64) || (Number.isInteger(value) && value >= 0);
}

async function handle(message) {
  if (typeof message !== 'object' || message === null || message.jsonrpc !== '2.0') return;
  if (!validId(message.id) || typeof message.method !== 'string' || !REQUEST_METHODS.has(message.method)) {
    if (validId(message.id)) failure(message.id, -32601, 'method not found');
    return;
  }
  const id = message.id;

  if (message.method === 'plugin.shutdown') {
    if (deactivating) {
      response(id, { stopped: true });
      return;
    }
    deactivating = true;
    try {
      if (typeof pluginModule?.deactivate === 'function') await pluginModule.deactivate();
      response(id, { stopped: true });
      setTimeout(() => process.exit(0), 5);
    } catch {
      failure(id, -32603, 'shutdown failed');
      fatal('shutdown-failed');
    }
    return;
  }

  try {
    if (message.method === 'plugin.ping') {
      const result = typeof pluginModule?.ping === 'function' ? await pluginModule.ping() : { pong: true, pluginId };
      response(id, result);
      return;
    }
    const result =
      typeof pluginModule?.status === 'function'
        ? await pluginModule.status()
        : { pluginId, apiVersion, pid: process.pid, uptimeMs: Date.now() - startedAt };
    response(id, result);
  } catch {
    failure(id, -32603, 'plugin handler failed');
  }
}

async function boot() {
  if (typeof pluginId !== 'string' || pluginId.length === 0 || typeof entry !== 'string' || entry.length === 0) {
    fatal('activation-failed');
    return;
  }
  if (apiVersion !== 1) {
    fatal('activation-failed');
    return;
  }
  const root = path.resolve(process.cwd());
  const resolvedEntry = path.resolve(root, entry);
  if (resolvedEntry !== root && !resolvedEntry.startsWith(`${root}${path.sep}`)) {
    fatal('activation-failed');
    return;
  }
  try {
    pluginModule = await import(pathToFileURL(resolvedEntry).href);
    // Deliberately JSON-only and function-free: no fs/net/shell/exec host bridge.
    const context = Object.freeze({ pluginId, apiVersion: 1 });
    if (typeof pluginModule.activate === 'function') await pluginModule.activate(context);
    send({ jsonrpc: '2.0', method: 'plugin.ready', params: { pluginId, apiVersion: 1, pid: process.pid } });
    process.on('message', message => {
      void handle(message);
    });
  } catch {
    fatal('activation-failed');
  }
}

process.on('uncaughtException', () => fatal('uncaught'));
process.on('unhandledRejection', () => fatal('uncaught'));
process.on('disconnect', () => process.exit(0));

void boot();
