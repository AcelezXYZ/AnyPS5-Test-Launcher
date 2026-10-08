(() => {
'use strict';

const { t, applyTranslations } = window.i18n;
const api = window.launcher;

const $ = (id) => document.getElementById(id);
const MAX_LOG_LINES = 2000;

const view = {
  games: [],
  settings: null,
  logLines: 0,
  errors: new Map(),
  runtimeText: '',
  scanning: false,
};

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  if (options.title) node.title = options.title;
  for (const [key, handler] of Object.entries(options.on ?? {})) node.addEventListener(key, handler);
  for (const child of children) node.append(child);
  return node;
}

function setRuntime(text, kind) {
  const node = $('runtime');
  node.textContent = text;
  node.className = `runtime ${kind ?? ''}`;
}

function showNotice(message) {
  const node = $('notice');
  node.hidden = !message;
  node.textContent = message ?? '';
}

function appendLog(entry) {
  const log = $('log');
  const line = el('div', { className: entry.source, text: entry.line });
  log.append(line);
  view.logLines += 1;
  while (view.logLines > MAX_LOG_LINES) {
    log.firstChild.remove();
    view.logLines -= 1;
  }
  $('log-count').textContent = `(${view.logLines})`;
  if (!$('log-body').hidden) log.scrollTop = log.scrollHeight;
}

function runtimeEvent(event) {
  switch (event.phase) {
    case 'checking':
      setRuntime(t('runtimeChecking'), 'busy');
      break;
    case 'downloading': {
      const percent = event.total ? ` ${Math.floor((event.received / event.total) * 100)}%` : '';
      setRuntime(`${t('runtimeDownloading', { tag: event.tag, file: event.file })}${percent}`, 'busy');
      break;
    }
    case 'done': {
      const map = { current: ['runtimeCurrent', 'ok'], updated: ['runtimeUpdated', 'ok'], offline: ['runtimeOffline', 'warn'], failed: ['runtimeFailed', 'warn'], pinned: ['runtimePinned', 'ok'] };
      const [key, kind] = map[event.status] ?? map.current;
      setRuntime(t(key, { tag: event.tag }), kind);
      if (event.error) appendLog({ source: 'launcher', line: event.error });
      if (event.note) appendLog({ source: 'launcher', line: event.note });
      scan();
      break;
    }
    case 'error':
      setRuntime(t('runtimeNone'), 'warn');
      showNotice(event.error);
      scan();
      break;
    default:
      break;
  }
}

function appUpdateEvent(event) {
  const banner = $('app-update');
  const install = $('app-update-install');
  install.hidden = true;
  let text = '';
  if (event?.phase === 'available') text = t('appUpdateAvailable', { version: event.version });
  else if (event?.phase === 'downloading') text = t('appUpdateDownloading', { percent: event.percent });
  else if (event?.phase === 'ready') {
    text = t('appUpdateReady', { version: event.version });
    install.hidden = false;
  } else if (event?.phase === 'error') appendLog({ source: 'launcher', line: `Launcher update check failed: ${event.message}` });
  banner.hidden = !text;
  $('app-update-text').textContent = text;
}

function stateLabel(state) {
  return {
    missing: 'stateMissing', ready: 'stateReady', stale: 'stateStale', converting: 'stateConverting',
    running: 'stateRunning', 'no-runtime': 'stateNoRuntime', error: 'stateError',
  }[state] ? t({
    missing: 'stateMissing', ready: 'stateReady', stale: 'stateStale', converting: 'stateConverting',
    running: 'stateRunning', 'no-runtime': 'stateNoRuntime', error: 'stateError',
  }[state]) : state;
}

function warningText(code) {
  return { 'both-module-dirs': t('warnBoth'), 'no-module-dir': t('warnNone') }[code] ?? code;
}

async function startGame(game) {
  showNotice('');
  view.errors.delete(game.id);
  setState(game.id, 'converting');
  const outcome = await api.play(game.id);
  if (!outcome.ok) {
    const output = outcome.error.output?.length ? `\n${outcome.error.output.slice(-12).join('\n')}` : '';
    view.errors.set(game.id, outcome.error.message);
    showNotice(`${t('failedTitle', { title: game.title })}\n${outcome.error.message}${output}`);
    setState(game.id, 'error');
  }
  scan();
}

function setState(id, state) {
  const game = view.games.find((item) => item.id === id);
  if (!game) return;
  game.state = state;
  render();
}

function card(game) {
  const busy = game.state === 'converting';
  const running = game.state === 'running';
  const cover = el('div', { className: 'cover' });
  if (game.icon) cover.append(el('img', { text: '' }));
  if (game.icon) cover.firstChild.src = game.icon;
  else cover.textContent = (game.title[0] ?? '?').toUpperCase();

  const info = el('div', { className: 'info' }, [
    el('div', { className: 'title', text: game.title, title: game.title }),
    el('div', { className: 'sub', text: game.titleId ?? game.folderName, title: game.dir }),
    el('span', { className: `pill ${game.state}`, text: stateLabel(game.state) }),
    ...game.warnings.map((code) => el('div', { className: 'warning', text: warningText(code) })),
  ]);

  const actions = el('div', { className: 'card-actions' });
  if (running) {
    actions.append(el('button', { className: 'danger play', text: t('stop'), on: { click: () => api.stop(game.id) } }));
  } else {
    const play = el('button', { className: 'primary play', text: t('play'), on: { click: () => startGame(game) } });
    play.disabled = busy;
    actions.append(play);
  }

  if (game.executables.length > 1) {
    const select = el('select', { title: t('executable') });
    for (const name of game.executables) {
      const option = el('option', { text: name });
      option.value = name;
      option.selected = name === game.executable;
      select.append(option);
    }
    select.disabled = busy || running;
    select.addEventListener('change', async () => {
      await api.setExecutable(game.id, select.value);
      scan();
    });
    actions.append(select);
  }

  const rebuild = el('button', { text: t('rebuild'), on: { click: async () => {
    showNotice('');
    setState(game.id, 'converting');
    const outcome = await api.rebuild(game.id);
    if (!outcome.ok) showNotice(`${t('failedTitle', { title: game.title })}\n${outcome.error.message}`);
    scan();
  } } });
  rebuild.disabled = busy || running;
  const menu = el('div', { className: 'menu' }, [
    rebuild,
    el('button', { text: t('openGame'), on: { click: () => api.openFolder(game.id, 'game') } }),
    el('button', { text: t('openConverted'), on: { click: () => api.openFolder(game.id, 'converted') } }),
  ]);
  actions.append(el('details', { className: 'more' }, [el('summary', { text: '⋯' }), menu]));

  return el('article', { className: 'card' }, [cover, info, actions]);
}

function render() {
  const grid = $('grid');
  grid.replaceChildren(...view.games.map(card));
  $('empty').hidden = view.games.length > 0;
}

async function scan() {
  if (view.scanning) return;
  view.scanning = true;
  try {
    view.games = await api.scan();
    render();
  } finally {
    view.scanning = false;
  }
}

function renderSettings() {
  const { settings } = view;
  $('set-autoUpdate').checked = settings.autoUpdate;
  $('set-resourceMode').value = settings.resourceMode;
  $('set-toIntel').value = settings.toIntel;
  $('set-unusedFilter').value = String(settings.unusedFilter);
  $('set-gpu').value = settings.gpu;
  const roots = $('roots');
  roots.replaceChildren(...settings.libraryRoots.map((dir) => el('li', {}, [
    el('span', { text: dir }),
    el('button', { className: 'small', text: t('remove'), on: { click: async () => {
      adopt(await api.removeRoot(dir));
      scan();
    } } }),
  ])));
}

function adopt(snapshot) {
  view.settings = snapshot.settings;
  $('gpu-list').replaceChildren(...snapshot.gpus.map((name) => {
    const option = document.createElement('option');
    option.value = name;
    return option;
  }));
  renderSettings();
  return snapshot;
}

function bindSettings() {
  const save = async (patch) => adopt(await api.updateSettings(patch));
  $('set-autoUpdate').addEventListener('change', (event) => save({ autoUpdate: event.target.checked }));
  $('set-resourceMode').addEventListener('change', async (event) => { await save({ resourceMode: event.target.value }); scan(); });
  $('set-toIntel').addEventListener('change', async (event) => { await save({ toIntel: event.target.value }); scan(); });
  $('set-unusedFilter').addEventListener('change', async (event) => { await save({ unusedFilter: Number(event.target.value) }); scan(); });
  $('set-gpu').addEventListener('change', (event) => save({ gpu: event.target.value }));
  $('check-update').addEventListener('click', async () => {
    await api.checkRuntime();
  });
}

async function addFolder() {
  adopt(await api.addRoot());
  scan();
}

async function init() {
  applyTranslations();
  bindSettings();
  $('add-root').addEventListener('click', addFolder);
  $('empty-add').addEventListener('click', addFolder);
  $('rescan').addEventListener('click', scan);
  $('open-settings').addEventListener('click', () => $('settings-dialog').showModal());
  $('log-clear').addEventListener('click', () => {
    $('log').replaceChildren();
    view.logLines = 0;
    $('log-count').textContent = '';
  });
  $('log-toggle').addEventListener('click', () => {
    const body = $('log-body');
    body.hidden = !body.hidden;
    $('log-toggle').setAttribute('aria-expanded', String(!body.hidden));
    if (!body.hidden) $('log').scrollTop = $('log').scrollHeight;
  });

  api.on('log', appendLog);
  api.on('runtime', runtimeEvent);
  api.on('app-update', appUpdateEvent);
  $('app-update-install').addEventListener('click', async () => {
    const result = await api.installAppUpdate();
    if (!result.ok && result.reason === 'game-running') showNotice(t('appUpdateBusy'));
  });
  api.on('game-state', (event) => {
    if (event.state === 'ready' || event.state === 'error') scan();
    else setState(event.id, event.state);
  });
  api.on('gpus', (names) => {
    $('gpu-list').replaceChildren(...names.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    }));
  });

  const snapshot = adopt(await api.state());
  $('app-version').textContent = `Launcher ${snapshot.app.version}`;
  appUpdateEvent(snapshot.app.update);
  if (snapshot.runtimeEvent) runtimeEvent(snapshot.runtimeEvent);
  else setRuntime(t('runtimeChecking'), 'busy');
  await scan();
}

init();
})();
