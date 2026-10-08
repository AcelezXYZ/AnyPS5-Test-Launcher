'use strict';

const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { scanLibrary } = require('./scanner');
const { readIconDataUrl } = require('./metadata');
const { SettingsStore } = require('./settings');
const { Updater } = require('./updater');
const { convertGame, conversionStatus } = require('./convert');
const { launchGame } = require('./launch');

class LauncherCore extends EventEmitter {
  constructor({ dataDir, platform = process.platform, cpuModel = os.cpus()[0]?.model ?? '', fetchImpl, apiBase, webBase }) {
    super();
    this.dataDir = dataDir;
    this.platform = platform;
    this.cpuModel = cpuModel;
    this.workRoot = path.join(dataDir, 'games');
    this.settings = new SettingsStore(path.join(dataDir, 'settings.json'));
    this.updater = new Updater({
      runtimeDir: path.join(dataDir, 'runtime'),
      platform,
      fetchImpl,
      ...(apiBase ? { apiBase } : {}),
      ...(webBase ? { webBase } : {}),
      onStatus: (status) => this.publishRuntime(status),
    });
    this.games = new Map();
    this.running = new Map();
    this.busy = new Map();
    this.runtime = null;
    this.gpuNames = new Set();
    this.lastRuntimeEvent = null;
  }

  publishRuntime(event) {
    this.lastRuntimeEvent = event;
    this.emit('runtime', event);
  }

  async init() {
    await this.settings.load();
  }

  async startUp() {
    try {
      const result = await this.updater.ensure({ autoUpdate: this.settings.get().autoUpdate });
      this.runtime = result.runtime;
      this.publishRuntime({ phase: 'done', status: result.status, tag: result.runtime.tag, previous: result.previous, error: result.error, note: result.note });
    } catch (error) {
      this.runtime = await this.updater.installed();
      this.publishRuntime({ phase: 'error', error: error.message });
    }
    return this.runtime;
  }

  log(gameId, entry) {
    this.emit('log', { gameId, ...entry });
  }

  executableFor(game) {
    const chosen = this.settings.get().games[game.id]?.executable;
    return game.executables.includes(chosen) ? chosen : game.executable;
  }

  async describe(game) {
    const executable = this.executableFor(game);
    let state = 'no-runtime';
    let tag;
    if (this.runtime) {
      const status = await conversionStatus({
        game, executable, runtime: this.runtime, settings: this.settings.get(), workRoot: this.workRoot, platform: this.platform, cpuModel: this.cpuModel,
      });
      state = status.state;
      tag = status.tag;
    }
    if (this.running.has(game.id)) state = 'running';
    else if (this.busy.has(game.id)) state = 'converting';
    return { ...game, executable, state, convertedWith: tag, icon: await readIconDataUrl(game.dir) };
  }

  async library() {
    const games = await scanLibrary(this.settings.get().libraryRoots);
    this.games = new Map(games.map((game) => [game.id, game]));
    return Promise.all(games.map((game) => this.describe(game)));
  }

  requireGame(id) {
    const game = this.games.get(id);
    if (!game) throw new Error('Unknown game; rescan the library');
    return game;
  }

  async ensureRuntime() {
    if (!this.runtime) await this.startUp();
    if (!this.runtime) throw new Error('No AnyPS5 build is available. Check the internet connection and try again.');
    return this.runtime;
  }

  async prepare(id, { force = false } = {}) {
    const game = this.requireGame(id);
    if (this.busy.has(id)) return this.busy.get(id);
    const work = (async () => {
      const runtime = await this.ensureRuntime();
      const executable = this.executableFor(game);
      const options = { game, executable, runtime, settings: this.settings.get(), workRoot: this.workRoot, platform: this.platform, cpuModel: this.cpuModel };
      if (!force) {
        const status = await conversionStatus(options);
        if (status.state === 'ready') return status.workDir;
      }
      this.emit('game-state', { id, state: 'converting' });
      const result = await convertGame({ ...options, onLog: (entry) => this.log(id, entry) });
      return result.workDir;
    })();
    this.busy.set(id, work);
    try {
      return await work;
    } finally {
      this.busy.delete(id);
    }
  }

  async play(id) {
    const game = this.requireGame(id);
    if (this.running.has(id)) throw new Error(`${game.title} is already running`);
    let workDir;
    try {
      workDir = await this.prepare(id);
    } catch (error) {
      this.emit('game-state', { id, state: 'error', error: error.message });
      throw error;
    }
    const { child, exited } = launchGame({
      workDir,
      platform: this.platform,
      gpu: this.settings.get().gpu,
      onLog: (entry) => this.log(id, entry),
      onGpu: (name) => {
        this.gpuNames.add(name);
        this.emit('gpus', [...this.gpuNames]);
      },
    });
    this.running.set(id, child);
    this.emit('game-state', { id, state: 'running' });
    const result = await exited;
    this.running.delete(id);
    this.log(id, { source: 'launcher', line: result.error ? `Start failed: ${result.error}` : `Exited with ${result.signal ? `signal ${result.signal}` : `code ${result.code}`}` });
    this.emit('game-state', { id, state: 'ready', exit: result });
    return result;
  }

  stop(id) {
    const child = this.running.get(id);
    if (!child) return false;
    child.kill();
    return true;
  }

  stopAll() {
    for (const child of this.running.values()) child.kill();
  }

  async addRoot(dir) {
    const roots = [...new Set([...this.settings.get().libraryRoots, dir])];
    return this.settings.update({ libraryRoots: roots });
  }

  async removeRoot(dir) {
    return this.settings.update({ libraryRoots: this.settings.get().libraryRoots.filter((item) => item !== dir) });
  }
}

module.exports = { LauncherCore };
