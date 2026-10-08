'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_PARAM_BYTES = 1024 * 1024;
const MAX_ICON_BYTES = 8 * 1024 * 1024;

function pickLocalizedName(parameters) {
  const localized = parameters?.localizedParameters;
  if (!localized || typeof localized !== 'object') return undefined;
  const preferred = [localized.defaultLanguage, 'en-US', 'en-GB'];
  for (const key of preferred) {
    const name = localized[key]?.titleName;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  for (const value of Object.values(localized)) {
    if (value && typeof value === 'object' && typeof value.titleName === 'string' && value.titleName.trim()) {
      return value.titleName.trim();
    }
  }
  return undefined;
}

async function readTitleInfo(gameDir) {
  const file = path.join(gameDir, 'sce_sys', 'param.json');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_PARAM_BYTES) return {};
    const parameters = JSON.parse(await fs.readFile(file, 'utf8'));
    const titleName = pickLocalizedName(parameters) ?? (typeof parameters.titleName === 'string' ? parameters.titleName.trim() : undefined);
    const titleId = typeof parameters.titleId === 'string' ? parameters.titleId : undefined;
    return { titleName: titleName || undefined, titleId };
  } catch {
    return {};
  }
}

async function readIconDataUrl(gameDir) {
  const file = path.join(gameDir, 'sce_sys', 'icon0.png');
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return undefined;
    const data = await fs.readFile(file);
    if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) return undefined;
    return `data:image/png;base64,${data.toString('base64')}`;
  } catch {
    return undefined;
  }
}

module.exports = { readTitleInfo, readIconDataUrl, pickLocalizedName };
