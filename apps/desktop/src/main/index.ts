import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  API_VERSION,
  BridgeResponseSchema,
  BridgeEventPayloadSchema,
  DEFAULT_LIMITS,
  DESKTOP_METHODS,
  EVENT_CHANNEL,
  IPC_CHANNEL,
  isTrustedSender,
  parseBounded,
  parseBoundedBridgeRequest,
  SnapshotRequestSchema,
  SnapshotResponseSchema,
  type BridgeResponse,
  type DesktopMethodName,
  type ErrorCode,
  type OperationEvent
} from '@stackmanage/core';
import type { SnapshotResponse } from '@stackmanage/core';
import { WorkerClient, WorkerCallError } from '@stackmanage/worker/client';

let worker: WorkerClient | undefined;
let window: BrowserWindow | undefined;
let shutdownComplete = false;
let shutdownStarted = false;

const devUrl = !app.isPackaged ? process.env['STACKMANAGE_DEV_URL'] : undefined;
if (devUrl !== undefined && devUrl !== 'http://127.0.0.1:5179/') throw new Error('Unexpected development origin');
const documentUrl = devUrl ?? pathToFileURL(join(__dirname, 'renderer/index.html')).href;

/** Bridge method → worker management method. Explicit mapping; no caller-supplied method names. */
const METHOD_MAP = Object.freeze({
  install: 'install',
  start: 'service.start',
  stop: 'service.stop',
  restart: 'service.restart',
  status: 'service.status',
  listServices: 'services.list',
  listInstallations: 'installations.list',
  logsTail: 'logs.tail',
  sitesApply: 'sites.apply',
  sitesList: 'sites.list',
  sitesRemove: 'sites.remove',
  certificateStatus: 'certificates.status',
  trustCertificate: 'certificates.trust',
  runtimeVersions: 'runtime.versions',
  runtimeInstall: 'runtime.install',
  runtimeStatus: 'runtime.status',
  runtimeList: 'runtime.list',
  runtimeUninstall: 'runtime.uninstall'
} as const satisfies Record<DesktopMethodName, string>);

class IpcFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly messageKey: string,
    readonly retryable: boolean
  ) {
    super(code);
  }
}

function bridgeError(code: ErrorCode, messageKey: string, retryable: boolean): BridgeResponse {
  return BridgeResponseSchema.parse({ ok: false, error: { code, messageKey, retryable } });
}

function workerFailure(error: unknown): BridgeResponse {
  if (error instanceof WorkerCallError) {
    switch (error.code) {
      case 'TIMEOUT':
        return bridgeError('TIMEOUT', 'operation.timeout', true);
      case 'CONFLICT':
        return bridgeError('CONFLICT', 'operation.conflict', true);
      case 'INVALID_REQUEST':
        return bridgeError('INVALID_REQUEST', 'invalidRequest', false);
      case 'CANCELLED':
        return bridgeError('CANCELLED', 'cancelled', false);
      default:
        return bridgeError('UNAVAILABLE', 'worker.unavailable', true);
    }
  }
  return bridgeError('UNKNOWN', 'unknown', false);
}

/**
 * One trusted sender model for every channel: the exact window, exact document
 * URL and exact main frame. The renderer can never name its own worker method.
 */
function authorize(event: Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return Boolean(
    window !== undefined &&
      event.sender === window.webContents &&
      frame !== null &&
      frame !== undefined &&
      isTrustedSender({ url: frame.url, isMainFrame: frame === event.sender.mainFrame }, documentUrl)
  );
}

function forwardProgress(idempotencyKey: string): (event: OperationEvent) => void {
  return (event: OperationEvent): void => {
    if (event.type !== 'progress') return;
    if (!window || window.isDestroyed()) return;
    const payload = BridgeEventPayloadSchema.safeParse({
      operationId: idempotencyKey,
      sequence: event.sequence,
      stageKey: event.stageKey,
      ...(event.fraction !== undefined ? { fraction: event.fraction } : {})
    });
    if (!payload.success) return;
    window.webContents.send(EVENT_CHANNEL, payload.data);
  };
}

async function handleCall(method: DesktopMethodName, event: Electron.IpcMainInvokeEvent, input: unknown): Promise<BridgeResponse> {
  if (!authorize(event)) return bridgeError('FORBIDDEN', 'forbidden', false);
  let params: unknown;
  try {
    params = parseBoundedBridgeRequest(method, input);
  } catch (error) {
    void error;
    return bridgeError('INVALID_REQUEST', 'invalidRequest', false);
  }
  if (!worker) return bridgeError('UNAVAILABLE', 'worker.unavailable', true);
  const operationId = params !== null && typeof params === 'object' && typeof (params as { operationId?: unknown }).operationId === 'string' ? (params as { operationId: string }).operationId : undefined;
  const noParams = method === 'listServices' || method === 'listInstallations' || method === 'sitesList' || method === 'certificateStatus';
  try {
    const terminal = await worker.call(METHOD_MAP[method], noParams ? undefined : params, operationId !== undefined ? forwardProgress(operationId) : undefined);
    if (!terminal.ok) return BridgeResponseSchema.parse({ ok: false, error: terminal.error });
    return BridgeResponseSchema.parse({ ok: true, data: terminal.result });
  } catch (error) {
    return workerFailure(error);
  }
}

function registerHandlers(): void {
  ipcMain.handle(IPC_CHANNEL, async (event, input: unknown): Promise<SnapshotResponse> => {
    if (!authorize(event)) return { ok: false, error: { code: 'FORBIDDEN', messageKey: 'forbidden', retryable: false } };
    try {
      parseBounded(SnapshotRequestSchema, input);
    } catch {
      return { ok: false, error: { code: 'INVALID_REQUEST', messageKey: 'invalidRequest', retryable: false } };
    }
    try {
      if (!worker) throw new IpcFailure('UNAVAILABLE', 'worker.unavailable', true);
      await worker.health();
      return SnapshotResponseSchema.parse({
        ok: true,
        data: {
          apiVersion: API_VERSION,
          appVersion: app.getVersion(),
          worker: 'ready',
          implementedFeatures: ['bootstrap', 'services.install', 'services.lifecycle', 'sites', 'logs', 'runtimes'],
          limits: DEFAULT_LIMITS,
          platform: process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin' ? process.platform : undefined,
          architecture: process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined,
          sitesRoot: join(app.getPath('userData'), 'caddy', 'sites')
        }
      });
    } catch {
      return { ok: false, error: { code: 'UNAVAILABLE', messageKey: 'worker.unavailable', retryable: true } };
    }
  });

  for (const method of Object.keys(METHOD_MAP) as DesktopMethodName[]) {
    ipcMain.handle(DESKTOP_METHODS[method], async (event, input: unknown) => handleCall(method, event, input));
  }
}

function removeHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNEL);
  for (const method of Object.keys(METHOD_MAP) as DesktopMethodName[]) ipcMain.removeHandler(DESKTOP_METHODS[method]);
}

function createWindow(): void {
  window = new BrowserWindow({
    title: 'StackManage',
    width: 1100,
    height: 780,
    minWidth: 480,
    minHeight: 500,
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false
    }
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = undefined;
  });
  void window.loadURL(documentUrl).catch(error => {
    console.error('Renderer load failed', error);
    process.exitCode = 1;
    app.quit();
  });
}

app
  .whenReady()
  .then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    worker = new WorkerClient({
      entry: join(__dirname, 'worker.cjs'),
      env: {
        STACKMANAGE_DATA_HOME: join(app.getPath('userData'), 'caddy'),
        STACKMANAGE_NODE_HOME: join(app.getPath('userData'), 'node', 'runtime')
      }
    });
    registerHandlers();
    createWindow();
    if (process.env['STACKMANAGE_SMOKE'] === '1') await runSmoke();
  })
  .catch(error => {
    console.error('Bootstrap failed', error);
    process.exitCode = 1;
    app.quit();
  });

async function runSmoke(): Promise<void> {
  try {
    if (!window) throw new Error('Missing window');
    await new Promise<void>((resolve, reject) => {
      window?.webContents.once('did-finish-load', () => resolve());
      window?.webContents.once('did-fail-load', () => reject(new Error('Renderer load failed')));
    });
    const result: unknown = await window.webContents.executeJavaScript(`window.stackmanage.snapshot()`);
    const parsed = SnapshotResponseSchema.parse(result);
    if (!parsed.ok) throw new Error('Bridge health failed');
    const isolated: unknown = await window.webContents.executeJavaScript(
      `typeof require === 'undefined' && typeof process === 'undefined' && Object.keys(window.stackmanage).sort().join(',') === 'certificateStatus,install,listInstallations,listServices,logsTail,onOperationEvent,restart,runtimeInstall,runtimeList,runtimeStatus,runtimeUninstall,runtimeVersions,sitesApply,sitesList,sitesRemove,snapshot,start,status,stop,trustCertificate'`
    );
    if (isolated !== true) throw new Error('Renderer isolation/bridge surface failed');
    const status = await window.webContents.executeJavaScript(`window.stackmanage.status({instanceId:'caddy-18080'})`);
    const statusParsed = BridgeResponseSchema.parse(status);
    if (!statusParsed.ok) throw new Error('Service status bridge failed');
    const runtimeVersions = await window.webContents.executeJavaScript(`window.stackmanage.runtimeVersions({moduleId:'node'})`);
    const runtimeVersionsParsed = BridgeResponseSchema.parse(runtimeVersions);
    if (!runtimeVersionsParsed.ok || runtimeVersionsParsed.data.method !== 'runtime.versions') throw new Error('Runtime versions bridge failed');
    const runtimeStatus = await window.webContents.executeJavaScript(`window.stackmanage.runtimeStatus({moduleId:'node'})`);
    const runtimeStatusParsed = BridgeResponseSchema.parse(runtimeStatus);
    if (!runtimeStatusParsed.ok || runtimeStatusParsed.data.method !== 'runtime.status') throw new Error('Runtime status bridge failed');
    console.log('DESKTOP_SMOKE_OK: renderer → sandbox preload → main → fork worker; typed narrow bridge; runtime reads; Node globals absent');
    app.quit();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    app.quit();
  }
}

app.on('activate', () => {
  if (!window) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  removeHandlers();
  void (worker?.close() ?? Promise.resolve())
    .then(() => {
      shutdownComplete = true;
      app.exit(process.exitCode === 1 ? 1 : 0);
    })
    .catch(error => {
      console.error('Shutdown failed', error);
      app.exit(1);
    });
});
