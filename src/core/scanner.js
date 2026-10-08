'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { isElf } = require('./elf');
const { readTitleInfo } = require('./metadata');

const MODULE_DIRS = ['sce_module', 'sce_modules', 'prx'];
const MODULE_EXTENSIONS = new Set(['.prx', '.sprx']);

function gameIdFor(dir) {
  return crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
}

function defaultExecutable(candidates) {
  const eboot = candidates.find((name) => /^eboot\./i.test(name));
  return eboot ?? candidates[0];
}

function layoutWarnings(moduleDirs) {
  const warnings = [];
  const hasSingular = moduleDirs.includes('sce_module');
  const hasPlural = moduleDirs.includes('sce_modules');
  if (hasSingular && hasPlural) warnings.push('both-module-dirs');
  if (moduleDirs.length === 0) warnings.push('no-module-dir');
  return warnings;
}

async function inspectGameDir(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const candidates = [];
  const moduleDirs = [];
  for (const entry of entries) {
    if (entry.isDirectory() && MODULE_DIRS.includes(entry.name)) moduleDirs.push(entry.name);
    if (!entry.isFile()) continue;
    if (MODULE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    if (await isElf(path.join(dir, entry.name))) candidates.push(entry.name);
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.localeCompare(b));
  const info = await readTitleInfo(dir);
  return {
    id: gameIdFor(dir),
    dir: path.resolve(dir),
    folderName: path.basename(path.resolve(dir)),
    title: info.titleName ?? path.basename(path.resolve(dir)),
    titleId: info.titleId,
    executables: candidates,
    executable: defaultExecutable(candidates),
    moduleDirs: moduleDirs.sort(),
    warnings: layoutWarnings(moduleDirs),
  };
}

async function scanLibrary(roots) {
  const games = new Map();
  for (const root of roots) {
    const rootGame = await inspectGameDir(root);
    if (rootGame) games.set(rootGame.id, rootGame);
    let children;
    try {
      children = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith('.')) continue;
      const game = await inspectGameDir(path.join(root, child.name));
      if (game) games.set(game.id, game);
    }
  }
  return [...games.values()].sort((a, b) => a.title.localeCompare(b.title));
}

module.exports = { scanLibrary, inspectGameDir, gameIdFor, MODULE_DIRS };
