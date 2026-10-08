'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSelfUpdater } = require('../src/selfupdate');

function fakeUpdater() {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = 0;
  updater.checkForUpdates = async () => { updater.checks += 1; };
  updater.quitAndInstall = () => { updater.installs += 1; };
  return updater;
}

function setup({ enabled = true, busy = false } = {}) {
  const autoUpdater = fakeUpdater();
  const events = [];
  const self = createSelfUpdater({ autoUpdater, enabled, send: (channel, event) => events.push([channel, event]), isBusy: () => busy, setTimer: () => 0, setRepeat: () => 0 });
  return { autoUpdater, events, self };
}

test('translates updater events for the window', () => {
  const { autoUpdater, events } = setup();
  autoUpdater.emit('checking-for-update');
  autoUpdater.emit('update-available', { version: '0.2.0' });
  autoUpdater.emit('download-progress', { percent: 41.7 });
  autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  assert.deepEqual(events.map(([, event]) => event.phase), ['checking', 'available', 'downloading', 'ready']);
  assert.equal(events[2][1].percent, 41);
  assert.ok(events.every(([channel]) => channel === 'app-update'));
});

test('downloads automatically and installs on quit', () => {
  const { autoUpdater } = setup();
  assert.equal(autoUpdater.autoDownload, true);
  assert.equal(autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(autoUpdater.allowPrerelease, false);
});

test('install is refused before the download finished', () => {
  const { self, autoUpdater } = setup();
  assert.deepEqual(self.install(), { ok: false, reason: 'not-ready' });
  assert.equal(autoUpdater.installs, 0);
});

test('install restarts the app once an update is ready', () => {
  const { self, autoUpdater } = setup();
  autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  assert.deepEqual(self.install(), { ok: true });
  assert.equal(autoUpdater.installs, 1);
});

test('install never interrupts a running game', () => {
  const { self, autoUpdater } = setup({ busy: true });
  autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  assert.deepEqual(self.install(), { ok: false, reason: 'game-running' });
  assert.equal(autoUpdater.installs, 0);
});

test('check errors are reported instead of thrown', async () => {
  const { self, autoUpdater, events } = setup();
  autoUpdater.checkForUpdates = async () => { throw new Error('404 Not Found'); };
  assert.deepEqual(await self.check(), { status: 'error' });
  assert.equal(events.at(-1)[1].phase, 'error');
  assert.match(events.at(-1)[1].message, /404/);
});

test('a ready update is not downloaded again', async () => {
  const { self, autoUpdater } = setup();
  autoUpdater.emit('update-downloaded', { version: '0.2.0' });
  assert.deepEqual(await self.check(), { status: 'ready' });
  assert.equal(autoUpdater.checks, 0);
});

test('disabled in development builds and unsupported package types', async () => {
  const { self, events } = setup({ enabled: false });
  assert.deepEqual(await self.check(), { status: 'disabled' });
  assert.deepEqual(self.install(), { ok: false, reason: 'not-ready' });
  assert.deepEqual(self.last(), { phase: 'disabled' });
  assert.equal(events.length, 0);
});
