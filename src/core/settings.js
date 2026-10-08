'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  libraryRoots: [],
  autoUpdate: true,
  toIntel: 'auto',
  unusedFilter: 0,
  resourceMode: 'copy',
  gpu: '',
  games: {},
});

const TO_INTEL = new Set(['auto', 'on', 'off']);
const RESOURCE_MODES = new Set(['copy', 'link']);

function sanitize(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    libraryRoots: Array.isArray(value.libraryRoots) ? [...new Set(value.libraryRoots.filter((item) => typeof item === 'string' && item))] : [],
    autoUpdate: typeof value.autoUpdate === 'boolean' ? value.autoUpdate : DEFAULTS.autoUpdate,
    toIntel: TO_INTEL.has(value.toIntel) ? value.toIntel : DEFAULTS.toIntel,
    unusedFilter: [0, 1, 2].includes(value.unusedFilter) ? value.unusedFilter : DEFAULTS.unusedFilter,
    resourceMode: RESOURCE_MODES.has(value.resourceMode) ? value.resourceMode : DEFAULTS.resourceMode,
    gpu: typeof value.gpu === 'string' ? value.gpu.trim().slice(0, 200) : DEFAULTS.gpu,
    games: value.games && typeof value.games === 'object' && !Array.isArray(value.games) ? value.games : {},
  };
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.value = sanitize({});
  }

  async load() {
    try {
      this.value = sanitize(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch {
      this.value = sanitize({});
    }
    return this.value;
  }

  get() {
    return this.value;
  }

  async update(patch) {
    this.value = sanitize({ ...this.value, ...patch });
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.value, null, 2));
    await fs.rename(temp, this.file);
    return this.value;
  }

  async setGame(id, patch) {
    const games = { ...this.value.games, [id]: { ...(this.value.games[id] ?? {}), ...patch } };
    return this.update({ games });
  }
}

module.exports = { SettingsStore, sanitize, DEFAULTS };
