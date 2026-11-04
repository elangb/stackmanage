import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_LIMITS, IPC_CHANNEL, isTrustedSender, parseBounded, SnapshotRequestSchema, SnapshotResponseSchema } from '@stackmanage/core';
import type { SnapshotResponse } from '@stackmanage/core';
import { WorkerClient } from '@stackmanage/worker/client';

let worker: WorkerClient | undefined;
let window: BrowserWindow | undefined;
let shutdownComplete = false;
let shutdownStarted = false;
const devUrl = !app.isPackaged ? process.env['STACKMANAGE_DEV_URL'] : undefined;
if (devUrl !== undefined && devUrl !== 'http://127.0.0.1:5179/') throw new Error('Unexpected development origin');
const documentUrl = devUrl ?? pathToFileURL(join(__dirname, 'renderer/index.html')).href;

function createWindow(): void {
  window = new BrowserWindow({
    title: 'StackManage', width: 1100, height: 780, minWidth: 480, minHeight: 500, show: false,
    backgroundColor: '#0f172a', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false }
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = undefined; });
  void window.loadURL(documentUrl).catch(error => { console.error('Renderer load failed', error); process.exitCode = 1; app.quit(); });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  worker = new WorkerClient(join(__dirname, 'worker.cjs'));
  ipcMain.handle(IPC_CHANNEL, async (event, input: unknown): Promise<SnapshotResponse> => {
    const frame = event.senderFrame;
    if (!window || event.sender !== window.webContents || !frame || !isTrustedSender({ url: frame.url, isMainFrame: frame === event.sender.mainFrame }, documentUrl)) {
      return { ok: false, error: { code: 'FORBIDDEN', messageKey: 'failed', retryable: false } };
    }
    try { parseBounded(SnapshotRequestSchema, input); }
    catch { return { ok: false, error: { code: 'INVALID_REQUEST', messageKey: 'failed', retryable: false } }; }
    try {
      if (!worker) throw new Error('UNAVAILABLE');
      await worker.health();
      return SnapshotResponseSchema.parse({ ok: true, data: { apiVersion: 1, appVersion: app.getVersion(), worker: 'ready', implementedFeatures: ['bootstrap'], limits: DEFAULT_LIMITS } });
    } catch {
      return { ok: false, error: { code: 'UNAVAILABLE', messageKey: 'failed', retryable: true } };
    }
  });
  createWindow();
  if (process.env['STACKMANAGE_SMOKE'] === '1') {
    try {
      if (!window) throw new Error('Missing window');
      await new Promise<void>((resolve, reject) => {
        window?.webContents.once('did-finish-load', () => resolve());
        window?.webContents.once('did-fail-load', () => reject(new Error('Renderer load failed')));
      });
      const result: unknown = await window.webContents.executeJavaScript(`window.stackmanage.snapshot()`);
      const parsed = SnapshotResponseSchema.parse(result);
      if (!parsed.ok) throw new Error('Bridge health failed');
      const isolated: unknown = await window.webContents.executeJavaScript(`typeof require === 'undefined' && typeof process === 'undefined' && Object.keys(window.stackmanage).join(',') === 'snapshot'`);
      if (isolated !== true) throw new Error('Renderer isolation failed');
      console.log('DESKTOP_SMOKE_OK: renderer → sandbox preload → main → fork worker; Node globals absent');
      app.quit();
    } catch (error) { console.error(error); process.exitCode = 1; app.quit(); }
  }
}).catch(error => { console.error('Bootstrap failed', error); process.exitCode = 1; app.quit(); });

app.on('activate', () => { if (!window) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  ipcMain.removeHandler(IPC_CHANNEL);
  void (worker?.close() ?? Promise.resolve()).then(() => {
    shutdownComplete = true;
    app.exit(process.exitCode === 1 ? 1 : 0);
  }).catch(error => { console.error('Shutdown failed', error); app.exit(1); });
});
