(() => {
'use strict';

const STRINGS = {
  addFolder: 'Add folder', rescan: 'Rescan', settings: 'Settings', log: 'Log', clearLog: 'Clear', close: 'Close',
  emptyTitle: 'No games yet',
  emptyText: 'Add a folder that contains your dumped game folders. Each game folder needs its decrypted ELF executable.',
  play: 'Play', stop: 'Stop', rebuild: 'Rebuild', openGame: 'Game folder', openConverted: 'Converted files',
  stateMissing: 'Not converted yet', stateReady: 'Ready', stateStale: 'Update pending', stateConverting: 'Converting…',
  stateRunning: 'Running', stateNoRuntime: 'Waiting for AnyPS5', stateError: 'Error',
  executable: 'Executable',
  warnBoth: 'Both sce_module and sce_modules exist; the relinker rejects this layout.',
  warnNone: 'No sce_module, sce_modules or prx folder found; the relinker rejects this layout.',
  runtimeChecking: 'Checking for AnyPS5 updates…', runtimeDownloading: 'Downloading AnyPS5 {tag} ({file})…',
  runtimeCurrent: 'AnyPS5 {tag} (latest)', runtimeUpdated: 'AnyPS5 {tag} (just updated)',
  runtimeOffline: 'AnyPS5 {tag} (offline, update check failed)', runtimeFailed: 'AnyPS5 {tag} (update failed)',
  runtimePinned: 'AnyPS5 {tag} (auto-update off)', runtimeNone: 'No AnyPS5 build installed',
  autoUpdate: 'Always use the newest AnyPS5 release', autoUpdateHint: 'Checks GitHub at every start and downloads the relinker and system libraries when a new release exists. Converted games are rebuilt on the next launch.',
  resourceMode: 'Game files', resourceModeHint: 'Copy is safe but needs disk space. Link is fast and saves space, but is not verified with real titles.',
  modeCopy: 'Copy', modeLink: 'Link (experimental)',
  toIntel: 'Intel conversion (--to-intel)', toIntelHint: 'Auto enables it when the CPU is an Intel CPU.', auto: 'Auto', on: 'On', off: 'Off',
  unusedFilter: 'Unused import filter', unusedFilterHint: '0 keeps all imports. Higher levels are stricter and can fail the conversion.',
  gpu: 'GPU (ANYPS5_GPU)', gpuHint: 'Part of a device name. Empty uses the default choice. Names appear after the first start of a game.',
  folders: 'Library folders', remove: 'Remove', checkUpdate: 'Check for update now',
  lastExit: 'Exited with {code}', failedTitle: 'Could not start {title}',
  appUpdateAvailable: 'Launcher update {version} found, downloading…', appUpdateDownloading: 'Downloading launcher update… {percent}%',
  appUpdateReady: 'Launcher {version} is ready to install.', restartUpdate: 'Restart and update', appUpdateBusy: 'Close the running game first, then restart to update.',
};

function t(key, values = {}) {
  const template = STRINGS[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
}

function applyTranslations(root = document) {
  document.documentElement.lang = 'en';
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
}

window.i18n = { t, applyTranslations };
})();
