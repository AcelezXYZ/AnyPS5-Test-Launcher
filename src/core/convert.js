'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { MODULE_DIRS } = require('./scanner');
const { buildRelinkerArgs, outputName, resolveToIntel } = require('./plan');

const STATE_FILE = '.launcher-state.json';
const STATE_SCHEMA = 1;

class RelinkerError extends Error {
  constructor(message, { code, output }) {
    super(message);
    this.name = 'RelinkerError';
    this.code = code;
    this.output = output;
  }
}

function insideRoot(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function statSignature(target) {
  const hash = crypto.createHash('sha256');
  async function walk(dir, prefix) {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${prefix}${entry.name}\n`);
        await walk(full, `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full);
        hash.update(`f:${prefix}${entry.name}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
      }
    }
  }
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) await walk(target, '');
    else hash.update(`f:${path.basename(target)}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
  } catch {
    return 'missing';
  }
  return hash.digest('hex');
}

async function fingerprint({ game, executable, runtime, settings, platform, cpuModel }) {
  const toIntel = resolveToIntel(settings.toIntel, cpuModel);
  const parts = {
    schema: STATE_SCHEMA,
    tag: runtime.tag,
    platform,
    toIntel,
    unusedFilter: settings.unusedFilter,
    resourceMode: settings.resourceMode,
    executable,
    executableSignature: await statSignature(path.join(game.dir, executable)),
    modules: await Promise.all(game.moduleDirs.map(async (name) => `${name}:${await statSignature(path.join(game.dir, name))}`)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function readState(workDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(workDir, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

async function conversionStatus(options) {
  const { workRoot, game, platform } = options;
  const workDir = path.join(workRoot, game.id);
  const state = await readState(workDir);
  if (!state) return { state: 'missing', workDir };
  try {
    await fs.access(path.join(workDir, outputName(platform)));
  } catch {
    return { state: 'missing', workDir };
  }
  const current = await fingerprint(options);
  return { state: state.fingerprint === current ? 'ready' : 'stale', workDir, tag: state.tag };
}

function runRelinker(binary, args, cwd, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, windowsHide: true });
    const lines = [];
    const forward = (stream, label) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, index).replace(/\r$/, '');
          pending = pending.slice(index + 1);
          lines.push(line);
          onLog({ source: label, line });
        }
      });
      stream.on('end', () => {
        if (pending) {
          lines.push(pending);
          onLog({ source: label, line: pending });
        }
      });
    };
    forward(child.stdout, 'relinker');
    forward(child.stderr, 'relinker');
    child.on('error', (error) => reject(new RelinkerError(`Could not start the relinker: ${error.message}`, { code: null, output: lines })));
    child.on('close', (code) => {
      if (code === 0) resolve(lines);
      else {
        const reason = code === 1 ? 'invalid arguments' : code === 2 ? 'conversion failed' : `exit code ${code}`;
        reject(new RelinkerError(`The relinker reported: ${reason}`, { code, output: lines }));
      }
    });
  });
}

async function copyLibs(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.isFile()) await fs.copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}

async function linkEntry(source, destination, isDirectory) {
  if (isDirectory) {
    await fs.symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  try {
    await fs.symlink(source, destination, 'file');
  } catch {
    try {
      await fs.link(source, destination);
    } catch {
      await fs.copyFile(source, destination);
    }
  }
}

async function populateResources({ game, executable, app0, mode, onLog }) {
  const skip = new Set([executable, ...MODULE_DIRS]);
  await fs.mkdir(app0, { recursive: true });
  for (const entry of await fs.readdir(game.dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const source = path.join(game.dir, entry.name);
    const destination = path.join(app0, entry.name);
    onLog({ source: 'launcher', line: `${mode === 'link' ? 'Linking' : 'Copying'} ${entry.name}` });
    if (mode === 'link') {
      await linkEntry(source, destination, entry.isDirectory());
    } else if (entry.isDirectory()) {
      await fs.cp(source, destination, { recursive: true, force: true });
    } else if (entry.isFile()) {
      await fs.copyFile(source, destination);
    }
  }
}

async function convertGame({ game, executable, runtime, settings, workRoot, platform = process.platform, cpuModel, onLog = () => {} }) {
  if (!game.executables.includes(executable)) throw new Error(`${executable} is not an executable of ${game.title}`);
  const workDir = path.join(workRoot, game.id);
  if (!insideRoot(workRoot, workDir)) throw new Error('Refusing to work outside of the launcher data directory');
  const current = await fingerprint({ game, executable, runtime, settings, platform, cpuModel });
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  const output = path.join(workDir, outputName(platform));
  const args = buildRelinkerArgs({
    platform,
    toIntel: resolveToIntel(settings.toIntel, cpuModel),
    unusedFilter: settings.unusedFilter,
    input: path.join(game.dir, executable),
    output,
  });
  onLog({ source: 'launcher', line: `AnyPS5 ${runtime.tag}: relinker ${args.join(' ')}` });
  try {
    await runRelinker(runtime.relinker, args, workDir, onLog);
    await fs.access(output);
    if (platform !== 'win32') await fs.chmod(output, 0o755);
    await copyLibs(runtime.libsDir, path.join(workDir, 'libs'));
    await populateResources({ game, executable, app0: path.join(workDir, 'app0'), mode: settings.resourceMode, onLog });
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true });
    throw error;
  }
  await fs.writeFile(path.join(workDir, STATE_FILE), JSON.stringify({
    fingerprint: current,
    tag: runtime.tag,
    executable,
    convertedAt: new Date().toISOString(),
  }, null, 2));
  return { workDir, output };
}

module.exports = { convertGame, conversionStatus, RelinkerError, insideRoot, fingerprint };
