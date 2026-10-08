'use strict';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const START_DELAY_MS = 5000;

function createSelfUpdater({ autoUpdater, enabled, send, isBusy, setTimer = setTimeout, setRepeat = setInterval }) {
  let last = enabled ? null : { phase: 'disabled' };
  let ready = false;

  const publish = (event) => {
    last = event;
    send('app-update', event);
  };

  if (enabled) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on('checking-for-update', () => publish({ phase: 'checking' }));
    autoUpdater.on('update-available', (info) => publish({ phase: 'available', version: info.version }));
    autoUpdater.on('update-not-available', () => publish({ phase: 'current' }));
    autoUpdater.on('download-progress', (progress) => publish({ phase: 'downloading', percent: Math.floor(progress.percent ?? 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      ready = true;
      publish({ phase: 'ready', version: info.version });
    });
    autoUpdater.on('error', (error) => publish({ phase: 'error', message: String(error?.message ?? error) }));
  }

  async function check() {
    if (!enabled) return { status: 'disabled' };
    if (ready) return { status: 'ready' };
    try {
      await autoUpdater.checkForUpdates();
      return { status: 'checked' };
    } catch (error) {
      publish({ phase: 'error', message: String(error?.message ?? error) });
      return { status: 'error' };
    }
  }

  function install() {
    if (!enabled || !ready) return { ok: false, reason: 'not-ready' };
    if (isBusy()) return { ok: false, reason: 'game-running' };
    autoUpdater.quitAndInstall();
    return { ok: true };
  }

  function start() {
    if (!enabled) return () => {};
    const first = setTimer(check, START_DELAY_MS);
    const repeat = setRepeat(check, CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(repeat);
    };
  }

  return { check, install, start, last: () => last };
}

module.exports = { createSelfUpdater, CHECK_INTERVAL_MS, START_DELAY_MS };
