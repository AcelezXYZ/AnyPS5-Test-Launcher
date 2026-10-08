'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { startReleaseServer, tmp, makeGame } = require('../test/helpers');

function png(width, height, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const shade = 0.55 + 0.45 * (x / width);
      row[1 + x * 3] = Math.round(rgb[0] * shade);
      row[2 + x * 3] = Math.round(rgb[1] * shade);
      row[3 + x * 3] = Math.round(rgb[2] * shade);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const output = path.resolve(process.argv[2] ?? 'smoke.png');
  const script = process.argv[3] ?? '';
  const server = await startReleaseServer({ platform: process.platform });
  const library = tmp('anyps5-smoke-lib-');
  const dataDir = tmp('anyps5-smoke-data-');
  const a = makeGame(library, 'Nebula Runner', { title: 'Nebula Runner' });
  fs.writeFileSync(path.join(a, 'sce_sys', 'icon0.png'), png(128, 128, [90, 170, 255]));
  const b = makeGame(library, 'Kingdom of Ash', { title: 'Kingdom of Ash' });
  fs.writeFileSync(path.join(b, 'sce_sys', 'icon0.png'), png(128, 128, [255, 140, 90]));
  makeGame(library, 'homebrew', { moduleDir: null });
  makeGame(library, 'Broken Dump', { title: 'Broken Dump', fail: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ libraryRoots: process.env.SMOKE_EMPTY ? [] : [library] }));
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1200x800x24', path.join(__dirname, '..', 'node_modules', '.bin', 'electron'), '--no-sandbox', '.'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ANYPS5_LAUNCHER_DATA_DIR: dataDir,
      ANYPS5_LAUNCHER_API_BASE: server.base,
      ANYPS5_LAUNCHER_WEB_BASE: server.base,
      ANYPS5_LAUNCHER_SCREENSHOT: output,
      ANYPS5_LAUNCHER_SCREENSHOT_SCRIPT: script,
    },
  });
  let captured = '';
  child.stdout.on('data', (chunk) => { captured += chunk; });
  child.stderr.on('data', (chunk) => { captured += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  const result = { stdout: captured, stderr: '' };
  await server.close();
  process.stdout.write(`${result.stdout}${result.stderr}`.split('\n').filter((line) => !/dbus|GPU process|Gtk|ERROR:/i.test(line)).join('\n'));
  console.log(fs.existsSync(output) ? `screenshot: ${output}` : 'no screenshot');
  console.log(`runtime installed: ${fs.existsSync(path.join(dataDir, 'runtime', 'current.json')) ? fs.readFileSync(path.join(dataDir, 'runtime', 'current.json'), 'utf8').replace(/\s+/g, ' ') : 'no'}`);
  process.exit(fs.existsSync(output) ? 0 : 1);
}

main();
