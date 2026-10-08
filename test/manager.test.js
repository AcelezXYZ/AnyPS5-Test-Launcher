'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { LauncherCore } = require('../src/core/manager');
const { startReleaseServer, tmp, makeGame } = require('./helpers');

async function setup({ cpuModel = 'AMD Ryzen', settings = {} } = {}) {
  const server = await startReleaseServer({ platform: 'linux' });
  const dataDir = tmp();
  const library = tmp();
  const log = path.join(dataDir, 'relinker.log');
  process.env.FAKE_RELINKER_LOG = log;
  const core = new LauncherCore({
    dataDir,
    platform: 'linux',
    cpuModel,
    fetchImpl: (url, init) => fetch(url.replace('https://api.github.com', server.base).replace('https://github.com', server.base), init),
  });
  core.updater.apiBase = server.base;
  core.updater.webBase = server.base;
  await core.init();
  await core.settings.update({ libraryRoots: [library], ...settings });
  const invocations = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { core, server, library, dataDir, invocations };
}

test('play updates the runtime, converts, runs and reports the exit code and GPU', async (t) => {
  const { core, server, library, invocations } = await setup();
  t.after(() => server.close());
  makeGame(library, 'game1', { title: 'Game One', files: { 'data/level.bin': 'level', 'movie.mp4': 'mp4' } });
  await core.startUp();
  assert.equal(core.runtime.tag, 'v1.0.0');
  const [game] = await core.library();
  assert.equal(game.state, 'missing');
  const lines = [];
  core.on('log', (entry) => lines.push(entry.line));
  const result = await core.play(game.id);
  assert.equal(result.code, 7);
  assert.ok(lines.some((line) => line.includes('GPU=')));
  assert.ok(core.gpuNames.has('Fake GPU 9000'));
  const [args] = invocations();
  assert.equal(args.length, 2);
  assert.ok(args[0].endsWith(path.join('game1', 'eboot.bin')));
  assert.ok(args[1].endsWith('app.elf'));
  const workDir = path.join(core.workRoot, game.id);
  assert.ok(fs.existsSync(path.join(workDir, 'libs', 'libSceTest.prx')));
  assert.equal(fs.readFileSync(path.join(workDir, 'app0', 'data', 'level.bin'), 'utf8'), 'level');
  assert.ok(fs.existsSync(path.join(workDir, 'app0', 'sce_module', 'mod.prx.guest.prx')));
  assert.ok(!fs.existsSync(path.join(workDir, 'app0', 'sce_module', 'mod.prx')), 'original module is not copied');
  assert.ok(!fs.existsSync(path.join(workDir, 'app0', 'eboot.bin')), 'executable is not copied into app0');
});

test('an unchanged game is not converted again', async (t) => {
  const { core, server, library, invocations } = await setup();
  t.after(() => server.close());
  makeGame(library, 'g', {});
  await core.startUp();
  const [game] = await core.library();
  await core.play(game.id);
  await core.play(game.id);
  assert.equal(invocations().length, 1);
  const [after] = await core.library();
  assert.equal(after.state, 'ready');
});

test('a new AnyPS5 release makes conversions stale and reconverts on the next start', async (t) => {
  const { core, server, library, invocations } = await setup();
  t.after(() => server.close());
  makeGame(library, 'g', {});
  await core.startUp();
  let [game] = await core.library();
  await core.play(game.id);
  server.publish('v1.1.0');
  await core.startUp();
  assert.equal(core.runtime.tag, 'v1.1.0');
  [game] = await core.library();
  assert.equal(game.state, 'stale');
  await core.play(game.id);
  assert.equal(invocations().length, 2);
  const state = JSON.parse(fs.readFileSync(path.join(core.workRoot, game.id, '.launcher-state.json'), 'utf8'));
  assert.equal(state.tag, 'v1.1.0');
});

test('changing the game files makes the conversion stale', async (t) => {
  const { core, server, library } = await setup();
  t.after(() => server.close());
  const dir = makeGame(library, 'g', {});
  await core.startUp();
  const [game] = await core.library();
  await core.play(game.id);
  fs.appendFileSync(path.join(dir, 'eboot.bin'), 'patched');
  const [after] = await core.library();
  assert.equal(after.state, 'stale');
});

test('relinker failures are reported with its output and leave no half-built directory', async (t) => {
  const { core, server, library } = await setup();
  t.after(() => server.close());
  makeGame(library, 'bad', { fail: true });
  await core.startUp();
  const [game] = await core.library();
  await assert.rejects(core.play(game.id), (error) => error.name === 'RelinkerError' && error.code === 2 && error.output.some((line) => line.includes('unsupported instruction')));
  assert.ok(!fs.existsSync(path.join(core.workRoot, game.id)));
});

test('toIntel auto follows the CPU, and the settings map to relinker options', async (t) => {
  const intel = await setup({ cpuModel: 'Intel(R) Core(TM) i7', settings: { unusedFilter: 2 } });
  t.after(() => intel.server.close());
  makeGame(intel.library, 'g', {});
  await intel.core.startUp();
  const [game] = await intel.core.library();
  await intel.core.play(game.id);
  assert.deepEqual(intel.invocations()[0].slice(0, 2), ['--to-intel', 'unused-filter=2']);
});

test('toIntel off overrides an Intel CPU', async (t) => {
  const { core, server, library, invocations } = await setup({ cpuModel: 'Intel(R) Xeon', settings: { toIntel: 'off' } });
  t.after(() => server.close());
  makeGame(library, 'g', {});
  await core.startUp();
  const [game] = await core.library();
  await core.play(game.id);
  assert.ok(!invocations()[0].includes('--to-intel'));
});

test('link mode links the resources instead of copying them', async (t) => {
  const { core, server, library } = await setup({ settings: { resourceMode: 'link' } });
  t.after(() => server.close());
  makeGame(library, 'g', { files: { 'data/a.bin': 'a', 'top.txt': 't' } });
  await core.startUp();
  const [game] = await core.library();
  await core.play(game.id);
  const app0 = path.join(core.workRoot, game.id, 'app0');
  assert.ok(fs.lstatSync(path.join(app0, 'data')).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(app0, 'data', 'a.bin'), 'utf8'), 'a');
  assert.ok(!fs.lstatSync(path.join(app0, 'sce_module')).isSymbolicLink());
});

test('the GPU setting is passed to the game as ANYPS5_GPU', async (t) => {
  const { core, server, library } = await setup({ settings: { gpu: 'radeon' } });
  t.after(() => server.close());
  makeGame(library, 'g', {});
  await core.startUp();
  const [game] = await core.library();
  const lines = [];
  core.on('log', (entry) => lines.push(entry.line));
  await core.play(game.id);
  assert.ok(lines.includes('GPU=radeon'));
});

test('the chosen executable is used', async (t) => {
  const { core, server, library, invocations } = await setup();
  t.after(() => server.close());
  const dir = makeGame(library, 'g', {});
  fs.copyFileSync(path.join(dir, 'eboot.bin'), path.join(dir, 'other.elf'));
  await core.startUp();
  let [game] = await core.library();
  await core.settings.setGame(game.id, { executable: 'other.elf' });
  [game] = await core.library();
  assert.equal(game.executable, 'other.elf');
  await core.play(game.id);
  assert.ok(invocations()[0][0].endsWith('other.elf'));
});

test('without network and without an installed build, play explains what is missing', async (t) => {
  const { core, server, library } = await setup();
  makeGame(library, 'g', {});
  await server.close();
  await core.startUp();
  const [game] = await core.library();
  assert.equal(game.state, 'no-runtime');
  await assert.rejects(core.play(game.id), /No AnyPS5 build is available/);
});

test('a game can be stopped', async (t) => {
  const { core, server, library } = await setup();
  t.after(() => server.close());
  makeGame(library, 'g', {});
  await core.startUp();
  const [game] = await core.library();
  await core.prepare(game.id);
  fs.writeFileSync(path.join(core.workRoot, game.id, 'app.elf'), '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n', { mode: 0o755 });
  const running = core.play(game.id);
  while (!core.running.has(game.id)) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(core.stop(game.id), true);
  const result = await running;
  assert.equal(result.signal, 'SIGTERM');
});
