'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Updater, assertTag, assetNames } = require('../src/core/updater');
const { startReleaseServer, tmp, makeLibsArchive, makeTar } = require('./helpers');
const zlib = require('node:zlib');

async function setup(options = {}) {
  const server = await startReleaseServer({ platform: 'linux' });
  const dir = tmp();
  const events = [];
  const updater = new Updater({
    runtimeDir: path.join(dir, 'runtime'),
    platform: 'linux',
    apiBase: server.base,
    webBase: server.base,
    onStatus: (event) => events.push(event),
    ...options,
  });
  return { server, dir, updater, events };
}

test('asset names match the official release workflow', () => {
  assert.deepEqual(assetNames('v0.1.1', 'linux'), { relinker: 'relinker-v0.1.1', prx: 'prx-linux-v0.1.1.tar.gz' });
  assert.deepEqual(assetNames('v0.1.1', 'win32'), { relinker: 'relinker-v0.1.1.exe', prx: 'prx-windows-v0.1.1.tar.gz' });
});

test('rejects tags that could escape the runtime directory', () => {
  for (const tag of ['../x', 'v1/../../etc', 'v1.', '', 'latest', undefined]) assert.throws(() => assertTag(tag));
  assert.equal(assertTag('v0.1.1'), 'v0.1.1');
});

test('first start downloads and activates the latest release', async (t) => {
  const { server, updater } = await setup();
  t.after(() => server.close());
  const result = await updater.ensure();
  assert.equal(result.status, 'updated');
  assert.equal(result.runtime.tag, 'v1.0.0');
  assert.ok(fs.statSync(result.runtime.relinker).mode & 0o111, 'relinker is executable');
  assert.equal(fs.readFileSync(path.join(result.runtime.libsDir, 'libSceTest.prx'), 'utf8'), 'libs-v1.0.0');
  assert.equal((await updater.installed()).tag, 'v1.0.0');
});

test('does not download again while the installed release is the newest', async (t) => {
  const { server, updater } = await setup();
  t.after(() => server.close());
  await updater.ensure();
  server.state.hits.length = 0;
  const result = await updater.ensure();
  assert.equal(result.status, 'current');
  assert.ok(!server.state.hits.some((hit) => hit.includes('/releases/download/')));
});

test('a newer release replaces the current one and the previous one is kept', async (t) => {
  const { server, updater } = await setup();
  t.after(() => server.close());
  await updater.ensure();
  server.publish('v1.1.0');
  const result = await updater.ensure();
  assert.equal(result.status, 'updated');
  assert.equal(result.previous, 'v1.0.0');
  assert.equal(result.runtime.tag, 'v1.1.0');
  assert.ok(fs.existsSync(path.join(updater.runtimeDir, 'v1.0.0')));
  server.publish('v1.2.0');
  await updater.ensure();
  const kept = fs.readdirSync(updater.runtimeDir).filter((name) => name.startsWith('v')).sort();
  assert.deepEqual(kept, ['v1.1.0', 'v1.2.0']);
});

test('a corrupt download keeps the working release', async (t) => {
  const { server, updater } = await setup();
  t.after(() => server.close());
  await updater.ensure();
  server.publish('v1.1.0');
  server.state.corruptDigest = true;
  const result = await updater.ensure();
  assert.equal(result.status, 'failed');
  assert.match(result.error, /checksum mismatch/);
  assert.equal(result.runtime.tag, 'v1.0.0');
  assert.deepEqual(fs.readdirSync(updater.runtimeDir).filter((name) => name.startsWith('.incoming')), []);
});

test('falls back to the release redirect when the API is unavailable', async (t) => {
  const { server, updater } = await setup();
  t.after(() => server.close());
  server.state.apiFails = true;
  const result = await updater.ensure();
  assert.equal(result.status, 'updated');
  assert.equal(result.runtime.tag, 'v1.0.0');
});

test('works offline with an installed release', async (t) => {
  const { server, updater } = await setup();
  await updater.ensure();
  await server.close();
  const result = await updater.ensure();
  assert.equal(result.status, 'offline');
  assert.equal(result.runtime.tag, 'v1.0.0');
});

test('fails clearly offline when nothing is installed', async (t) => {
  const { server, updater } = await setup();
  await server.close();
  await assert.rejects(updater.ensure(), /No AnyPS5 build is installed/);
});

test('autoUpdate off keeps the installed release without any request', async (t) => {
  const { server, updater } = await setup();
  t.after(() => server.close());
  await updater.ensure();
  server.publish('v2.0.0');
  server.state.hits.length = 0;
  const result = await updater.ensure({ autoUpdate: false });
  assert.equal(result.status, 'pinned');
  assert.equal(result.runtime.tag, 'v1.0.0');
  assert.equal(server.state.hits.length, 0);
});

test('autoUpdate off still installs when nothing is installed yet', async (t) => {
  const { server, updater } = await setup();
  t.after(() => server.close());
  const result = await updater.ensure({ autoUpdate: false });
  assert.equal(result.status, 'updated');
});

test('refuses library archives with path traversal or nesting', async (t) => {
  for (const name of ['libs/../evil.prx', '../evil.prx', 'libs/sub/x.prx', 'other/x.prx']) {
    const { server, updater } = await setup();
    t.after(() => server.close());
    server.publish('v1.0.1', { prx: zlib.gzipSync(makeTar([{ name, data: 'x' }])) });
    await assert.rejects(updater.ensure(), /Unexpected entry/, name);
  }
});

test('refuses archives without any .prx', async (t) => {
  const { server, updater } = await setup();
  t.after(() => server.close());
  server.publish('v1.0.1', { prx: makeLibsArchive({ 'readme.txt': 'x' }) });
  await assert.rejects(updater.ensure(), /no \.prx/);
});

test('reports download progress', async (t) => {
  const { server, updater, events } = await setup();
  t.after(() => server.close());
  await updater.ensure();
  assert.ok(events.some((event) => event.phase === 'downloading' && event.received > 0));
  assert.ok(events.some((event) => event.phase === 'updated'));
});
