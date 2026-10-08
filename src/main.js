'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { LauncherCore } = require('./core/manager');
const { createSelfUpdater } = require('./selfupdate');

let core;
let win;
let selfUpdater;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function describeError(error) {
  return { message: error.message, output: error.output };
}

async function snapshot() {
  return {
    settings: core.settings.get(),
    platform: process.platform,
    runtime: core.runtime ? { tag: core.runtime.tag } : null,
    gpus: [...core.gpuNames],
    runtimeEvent: core.lastRuntimeEvent,
    app: { version: app.getVersion(), update: selfUpdater.last() },
  };
}

function registerIpc() {
  ipcMain.handle('state:get', snapshot);
  ipcMain.handle('library:scan', () => core.library());
  ipcMain.handle('roots:add', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Select a folder with PS5 game dumps' });
    if (result.canceled || result.filePaths.length === 0) return snapshot();
    await core.addRoot(result.filePaths[0]);
    return snapshot();
  });
  ipcMain.handle('roots:remove', async (_event, dir) => {
    await core.removeRoot(String(dir));
    return snapshot();
  });
  ipcMain.handle('settings:update', async (_event, patch) => {
    const allowed = ['autoUpdate', 'toIntel', 'unusedFilter', 'resourceMode', 'gpu'];
    const filtered = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key)));
    await core.settings.update(filtered);
    return snapshot();
  });
  ipcMain.handle('runtime:check', async () => {
    await core.startUp();
    return snapshot();
  });
  ipcMain.handle('game:play', async (_event, id) => {
    try {
      const result = await core.play(String(id));
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });
  ipcMain.handle('app:update-check', () => selfUpdater.check());
  ipcMain.handle('app:update-install', () => selfUpdater.install());
  ipcMain.handle('game:stop', (_event, id) => core.stop(String(id)));
  ipcMain.handle('game:rebuild', async (_event, id) => {
    try {
      await core.prepare(String(id), { force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  });
  ipcMain.handle('game:executable', async (_event, id, executable) => {
    const game = core.requireGame(String(id));
    if (!game.executables.includes(executable)) throw new Error('Unknown executable');
    await core.settings.setGame(game.id, { executable });
    return true;
  });
  ipcMain.handle('game:open', async (_event, id, which) => {
    const game = core.requireGame(String(id));
    const target = which === 'converted' ? path.join(core.workRoot, game.id) : game.dir;
    const error = await shell.openPath(target);
    return error || null;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0f1115',
    title: 'AnyPS5 Launcher',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  const dev = app.isPackaged ? {} : {
    dataDir: process.env.ANYPS5_LAUNCHER_DATA_DIR,
    apiBase: process.env.ANYPS5_LAUNCHER_API_BASE,
    webBase: process.env.ANYPS5_LAUNCHER_WEB_BASE,
  };
  core = new LauncherCore({ ...dev, dataDir: dev.dataDir || app.getPath('userData') });
  await core.init();
  for (const channel of ['log', 'runtime', 'game-state', 'gpus']) core.on(channel, (payload) => send(channel, payload));
  const selfUpdateEnabled = app.isPackaged && (process.platform === 'win32' || Boolean(process.env.APPIMAGE));
  selfUpdater = createSelfUpdater({
    autoUpdater: selfUpdateEnabled ? require('electron-updater').autoUpdater : null,
    enabled: selfUpdateEnabled,
    send,
    isBusy: () => core.running.size > 0,
  });
  registerIpc();
  createWindow();
  if (!app.isPackaged && process.env.ANYPS5_LAUNCHER_SCREENSHOT) require('./devtools').screenshotAndQuit(win, process.env.ANYPS5_LAUNCHER_SCREENSHOT);
  core.startUp().catch((error) => send('runtime', { phase: 'error', error: error.message }));
  selfUpdater.start();
  app.on('second-instance', () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.on('before-quit', () => core.stopAll());
  app.on('window-all-closed', () => app.quit());
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
