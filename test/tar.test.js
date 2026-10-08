'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { readTarGz, parseTar } = require('../src/core/tar');
const { makeTar, makeLibsArchive, tmp } = require('./helpers');

test('reads regular files and skips directories', () => {
  const files = readTarGz(zlib.gzipSync(makeTar([
    { name: 'libs/', data: '', type: '5' },
    { name: 'libs/a.prx', data: 'AAA' },
    { name: 'libs/b.prx', data: Buffer.alloc(600, 7) },
  ])));
  assert.deepEqual(files.map((file) => file.name), ['libs/a.prx', 'libs/b.prx']);
  assert.equal(files[1].data.length, 600);
});

test('rejects links and other special entries', () => {
  assert.throws(() => parseTar(makeTar([{ name: 'libs/x', data: '', type: '2' }])), /Unsupported tar entry/);
});

test('rejects truncated archives', () => {
  const tar = makeTar([{ name: 'libs/a.prx', data: Buffer.alloc(2000, 1) }]);
  assert.throws(() => parseTar(tar.subarray(0, 700)), /Truncated/);
});

test('reads an archive produced by Python tarfile like tools/package_release.py does', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'libSceLongName.prx'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(dir, 'libgcc_s_seh-1.dll'), 'dll');
  const archive = path.join(dir, 'prx.tar.gz');
  execFileSync('python3', ['-c', `
import sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz', compresslevel=9) as t:
    for name in ('libSceLongName.prx', 'libgcc_s_seh-1.dll'):
        t.add(sys.argv[2] + '/' + name, arcname='libs/' + name)
`, archive, dir]);
  const files = readTarGz(fs.readFileSync(archive));
  assert.deepEqual(files.map((file) => file.name).sort(), ['libs/libSceLongName.prx', 'libs/libgcc_s_seh-1.dll']);
  assert.equal(files.find((file) => file.name.endsWith('.prx')).data.length, 1000);
});

test('helper archive round trips', () => {
  const files = readTarGz(makeLibsArchive({ 'x.prx': 'hello' }));
  assert.equal(files[0].data.toString(), 'hello');
});
