'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const FIXTURE_RELINKER = fs.readFileSync(path.join(__dirname, 'fixtures', 'fake-relinker.js'));
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)]);

function tmp(prefix = 'anyps5-launcher-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function makeTar(entries) {
  const blocks = [];
  for (const { name, data, type } of entries) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
    blocks.push(tarHeader(name, body.length, type));
    blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function makeLibsArchive(files = { 'libSceTest.prx': 'prx-data' }, extra = []) {
  const entries = Object.entries(files).map(([name, data]) => ({ name: `libs/${name}`, data }));
  return zlib.gzipSync(makeTar([...entries, ...extra]));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function platformAssets(platform, tag, options = {}) {
  const target = platform === 'win32' ? 'windows' : 'linux';
  const relinkerName = platform === 'win32' ? `relinker-${tag}.exe` : `relinker-${tag}`;
  const relinker = options.relinker ?? Buffer.concat([FIXTURE_RELINKER, Buffer.from(`// ${tag}\n`)]);
  const prx = options.prx ?? makeLibsArchive({ 'libSceTest.prx': `libs-${tag}` });
  const assets = {};
  if (!options.omitRelinker) assets[relinkerName] = relinker;
  if (!options.omitPrx) assets[`prx-${target}-${tag}.tar.gz`] = prx;
  return assets;
}

async function startReleaseServer({ platform = process.platform, apiDigest = true } = {}) {
  const state = { tag: 'v1.0.0', order: ['v1.0.0'], assets: {}, apiFails: false, downloadsFail: false, corruptDigest: false, hits: [] };
  state.assets[state.tag] = platformAssets(platform, state.tag);
  const server = http.createServer((request, response) => {
    state.hits.push(`${request.method} ${request.url}`);
    const api = /^\/repos\/boykopovar\/AnyPS5\/releases\?per_page=\d+$/.exec(request.url);
    const latest = /^\/boykopovar\/AnyPS5\/releases\/latest$/.exec(request.url);
    const download = /^\/boykopovar\/AnyPS5\/releases\/download\/([^/]+)\/([^/]+)$/.exec(request.url);
    if (api) {
      if (state.apiFails) {
        response.writeHead(403);
        response.end('{"message":"rate limited"}');
        return;
      }
      const body = state.order.map((tag) => ({
        tag_name: tag,
        draft: false,
        prerelease: Boolean(state.prereleases?.has(tag)),
        assets: Object.entries(state.assets[tag]).map(([name, data]) => ({
          name,
          size: data.length,
          ...(apiDigest ? { digest: `sha256:${state.corruptDigest ? '0'.repeat(64) : sha256(data)}` } : {}),
        })),
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
      return;
    }
    if (latest) {
      response.writeHead(302, { location: `http://${request.headers.host}/boykopovar/AnyPS5/releases/tag/${state.tag}` });
      response.end();
      return;
    }
    if (download) {
      const data = state.assets[download[1]]?.[decodeURIComponent(download[2])];
      if (!data || state.downloadsFail) {
        response.writeHead(state.downloadsFail ? 503 : 404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-length': data.length });
      response.end(data);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    base,
    publish(tag, options) {
      state.assets[tag] = platformAssets(platform, tag, options);
      state.order = [tag, ...state.order.filter((item) => item !== tag)];
      state.tag = tag;
      if (options?.prerelease) (state.prereleases ??= new Set()).add(tag);
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeGame(root, name, { title, files = {}, moduleDir = 'sce_module', modules = ['mod.prx'], executable = 'eboot.bin', fail = false } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, executable), Buffer.concat([ELF, Buffer.from(fail ? 'FAIL' : 'ok')]));
  if (moduleDir) {
    fs.mkdirSync(path.join(dir, moduleDir), { recursive: true });
    for (const module of modules) fs.writeFileSync(path.join(dir, moduleDir, module), 'module');
  }
  for (const [relative, data] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  if (title) {
    fs.mkdirSync(path.join(dir, 'sce_sys'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sce_sys', 'param.json'), JSON.stringify({
      titleId: 'PPSA00000_00',
      localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: title } },
    }));
  }
  return dir;
}

module.exports = { tmp, makeTar, makeLibsArchive, startReleaseServer, makeGame, ELF, sha256 };
