'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { scanLibrary } = require('../src/core/scanner');
const { pickLocalizedName, readIconDataUrl } = require('../src/core/metadata');
const { tmp, makeGame } = require('./helpers');

test('finds games with an ELF executable and reads the title from param.json', async () => {
  const root = tmp();
  makeGame(root, 'PPSA01_game', { title: 'Space Game' });
  makeGame(root, 'plain', {});
  fs.mkdirSync(path.join(root, 'not-a-game'));
  fs.writeFileSync(path.join(root, 'not-a-game', 'readme.txt'), 'hi');
  fs.mkdirSync(path.join(root, '.hidden'));
  const games = await scanLibrary([root]);
  assert.deepEqual(games.map((game) => game.title).sort(), ['Space Game', 'plain']);
  const space = games.find((game) => game.title === 'Space Game');
  assert.equal(space.titleId, 'PPSA00000_00');
  assert.deepEqual(space.executables, ['eboot.bin']);
  assert.deepEqual(space.moduleDirs, ['sce_module']);
  assert.deepEqual(space.warnings, []);
});

test('a root that is itself a game is found, and prx files are not executables', async () => {
  const root = tmp();
  makeGame(path.dirname(root), path.basename(root), { moduleDir: 'prx' });
  fs.writeFileSync(path.join(root, 'extra.prx'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));
  const games = await scanLibrary([root]);
  assert.equal(games.length, 1);
  assert.deepEqual(games[0].executables, ['eboot.bin']);
});

test('prefers eboot over other executables and offers all of them', async () => {
  const root = tmp();
  const dir = makeGame(root, 'multi', { executable: 'zzz.elf' });
  fs.copyFileSync(path.join(dir, 'zzz.elf'), path.join(dir, 'eboot.bin'));
  fs.copyFileSync(path.join(dir, 'zzz.elf'), path.join(dir, 'aaa.elf'));
  const [game] = await scanLibrary([root]);
  assert.equal(game.executable, 'eboot.bin');
  assert.deepEqual(game.executables, ['aaa.elf', 'eboot.bin', 'zzz.elf']);
});

test('warns about module directory layouts the relinker rejects', async () => {
  const root = tmp();
  makeGame(root, 'none', { moduleDir: null });
  const both = makeGame(root, 'both', { moduleDir: 'sce_module' });
  fs.mkdirSync(path.join(both, 'sce_modules'));
  const games = await scanLibrary([root]);
  assert.deepEqual(games.find((game) => game.folderName === 'none').warnings, ['no-module-dir']);
  assert.deepEqual(games.find((game) => game.folderName === 'both').warnings, ['both-module-dirs']);
});

test('missing or broken roots do not fail the scan', async () => {
  assert.deepEqual(await scanLibrary([path.join(tmp(), 'missing')]), []);
});

test('title selection falls back through languages', () => {
  assert.equal(pickLocalizedName({ localizedParameters: { defaultLanguage: 'de-DE', 'de-DE': { titleName: 'Spiel' }, 'en-US': { titleName: 'Game' } } }), 'Spiel');
  assert.equal(pickLocalizedName({ localizedParameters: { 'ja-JP': { titleName: 'ゲーム' } } }), 'ゲーム');
  assert.equal(pickLocalizedName({}), undefined);
});

test('icons must be real PNG files', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'sce_sys'));
  fs.writeFileSync(path.join(dir, 'sce_sys', 'icon0.png'), 'not a png');
  assert.equal(await readIconDataUrl(dir), undefined);
  fs.writeFileSync(path.join(dir, 'sce_sys', 'icon0.png'), Buffer.from('89504e470d0a1a0a00', 'hex'));
  assert.match(await readIconDataUrl(dir), /^data:image\/png;base64,/);
});
