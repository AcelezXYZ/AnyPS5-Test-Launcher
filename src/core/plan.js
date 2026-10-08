'use strict';

const os = require('node:os');

function isIntelHost(cpuModel = os.cpus()[0]?.model ?? '') {
  return /intel/i.test(cpuModel);
}

function resolveToIntel(mode, cpuModel) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return isIntelHost(cpuModel);
}

function buildRelinkerArgs({ platform, toIntel, unusedFilter, input, output }) {
  const args = [];
  if (platform === 'win32') args.push('--windows');
  if (toIntel) args.push('--to-intel');
  if (unusedFilter !== 0) args.push(`unused-filter=${unusedFilter}`);
  args.push(input, output);
  return args;
}

function outputName(platform) {
  return platform === 'win32' ? 'app.exe' : 'app.elf';
}

module.exports = { buildRelinkerArgs, outputName, resolveToIntel, isIntelHost };
