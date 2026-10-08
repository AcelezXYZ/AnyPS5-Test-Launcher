'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { readTarGz } = require('./tar');

const REPO = 'boykopovar/AnyPS5';
const TAG_PATTERN = /^v[0-9A-Za-z][0-9A-Za-z._-]*$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const KEEP_VERSIONS = 2;

function assertTag(tag) {
  if (typeof tag !== 'string' || !TAG_PATTERN.test(tag) || tag.endsWith('.')) {
    throw new Error(`Unexpected release tag: ${JSON.stringify(tag)}`);
  }
  return tag;
}

function assetNames(tag, platform) {
  const target = platform === 'win32' ? 'windows' : 'linux';
  return {
    relinker: platform === 'win32' ? `relinker-${tag}.exe` : `relinker-${tag}`,
    prx: `prx-${target}-${tag}.tar.gz`,
  };
}

function relinkerFileName(platform) {
  return platform === 'win32' ? 'relinker.exe' : 'relinker';
}

class NoUsableRelease extends Error {}

class Updater {
  constructor({ runtimeDir, platform = process.platform, repo = REPO, apiBase = 'https://api.github.com', webBase = 'https://github.com', fetchImpl = globalThis.fetch, onStatus = () => {} }) {
    this.runtimeDir = runtimeDir;
    this.platform = platform;
    this.repo = repo;
    this.apiBase = apiBase;
    this.webBase = webBase;
    this.fetch = fetchImpl;
    this.onStatus = onStatus;
  }

  currentFile() {
    return path.join(this.runtimeDir, 'current.json');
  }

  async installed() {
    try {
      const current = JSON.parse(await fs.readFile(this.currentFile(), 'utf8'));
      const tag = assertTag(current.tag);
      const dir = path.join(this.runtimeDir, tag);
      const relinker = path.join(dir, relinkerFileName(this.platform));
      const libsDir = path.join(dir, 'libs');
      await fs.access(relinker);
      await fs.access(libsDir);
      return { tag, dir, relinker, libsDir };
    } catch {
      return null;
    }
  }

  async fetchLatest() {
    try {
      return await this.fetchLatestFromApi();
    } catch (apiError) {
      if (apiError instanceof NoUsableRelease) throw apiError;
      try {
        return await this.fetchLatestFromRedirect();
      } catch (redirectError) {
        throw new Error(`Could not determine the latest release (${apiError.message}; ${redirectError.message})`);
      }
    }
  }

  async fetchLatestFromApi() {
    const response = await this.fetch(`${this.apiBase}/repos/${this.repo}/releases?per_page=10`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'anyps5-launcher' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`release API answered ${response.status}`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('release API returned an unexpected answer');
    const skipped = [];
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      let tag;
      try {
        tag = assertTag(release.tag_name);
      } catch {
        continue;
      }
      const assets = {};
      const missing = [];
      for (const [key, name] of Object.entries(assetNames(tag, this.platform))) {
        const asset = (release.assets ?? []).find((item) => item.name === name);
        if (!asset) {
          missing.push(name);
          continue;
        }
        const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : undefined;
        assets[key] = { name, size: asset.size, sha256: digest };
      }
      if (missing.length === 0) {
        const note = skipped.length ? `Newer release(s) skipped: ${skipped.join('; ')}. Using ${tag}.` : undefined;
        return { tag, assets, note };
      }
      skipped.push(`${tag} has no ${missing.join(' and ')}`);
    }
    throw new NoUsableRelease(skipped.length ? `no release contains the files for this platform (${skipped.join('; ')})` : 'no published release found');
  }

  async fetchLatestFromRedirect() {
    const response = await this.fetch(`${this.webBase}/${this.repo}/releases/latest`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'anyps5-launcher' },
      signal: AbortSignal.timeout(15000),
    });
    const location = response.headers.get('location') ?? '';
    const match = /\/releases\/tag\/([^/?#]+)$/.exec(location);
    if (!match) throw new Error(`release redirect answered ${response.status}`);
    const tag = assertTag(decodeURIComponent(match[1]));
    const names = assetNames(tag, this.platform);
    return { tag, assets: { relinker: { name: names.relinker }, prx: { name: names.prx } } };
  }

  assetUrl(tag, name) {
    return `${this.webBase}/${this.repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  }

  async download(tag, asset, destination) {
    const url = this.assetUrl(tag, asset.name);
    const response = await this.fetch(url, { headers: { 'User-Agent': 'anyps5-launcher' }, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`download of ${asset.name} answered ${response.status}`);
    const headerSize = Number(response.headers.get('content-length')) || undefined;
    const expected = asset.size ?? headerSize;
    if (expected !== undefined && expected > MAX_ARCHIVE_BYTES) throw new Error(`${asset.name} is unexpectedly large`);
    const hash = crypto.createHash('sha256');
    let received = 0;
    const source = Readable.fromWeb(response.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      hash.update(chunk);
      if (received > MAX_ARCHIVE_BYTES) source.destroy(new Error(`${asset.name} exceeds the size limit`));
      this.onStatus({ phase: 'downloading', tag, file: asset.name, received, total: expected });
    });
    await pipeline(source, fsSync.createWriteStream(destination));
    if (asset.size !== undefined && received !== asset.size) throw new Error(`${asset.name}: expected ${asset.size} bytes, received ${received}`);
    const actual = hash.digest('hex');
    if (asset.sha256 && actual !== asset.sha256) throw new Error(`${asset.name}: checksum mismatch`);
    if (received === 0) throw new Error(`${asset.name} is empty`);
    return actual;
  }

  async extractLibs(archiveFile, libsDir) {
    const files = readTarGz(await fs.readFile(archiveFile));
    await fs.mkdir(libsDir, { recursive: true });
    const seen = new Set();
    for (const file of files) {
      const parts = file.name.split('/');
      const name = parts[1];
      if (parts.length !== 2 || parts[0] !== 'libs' || !name || name === '.' || name === '..' || name.includes('\\') || seen.has(name)) {
        throw new Error(`Unexpected entry in library archive: ${file.name}`);
      }
      seen.add(name);
      await fs.writeFile(path.join(libsDir, name), file.data);
    }
    if (![...seen].some((name) => name.endsWith('.prx'))) throw new Error('Library archive contains no .prx files');
  }

  async install(latest) {
    const { tag, assets } = latest;
    await fs.mkdir(this.runtimeDir, { recursive: true });
    const staging = await fs.mkdtemp(path.join(this.runtimeDir, '.incoming-'));
    try {
      const relinkerPath = path.join(staging, relinkerFileName(this.platform));
      const archivePath = path.join(staging, 'prx.tar.gz');
      await this.download(tag, assets.relinker, relinkerPath);
      await this.download(tag, assets.prx, archivePath);
      if (this.platform !== 'win32') await fs.chmod(relinkerPath, 0o755);
      await this.extractLibs(archivePath, path.join(staging, 'libs'));
      await fs.rm(archivePath);
      const target = path.join(this.runtimeDir, tag);
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(staging, target);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    await this.activate(tag);
  }

  async activate(tag) {
    const temp = `${this.currentFile()}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ tag, installedAt: new Date().toISOString() }, null, 2));
    await fs.rename(temp, this.currentFile());
    await this.prune(tag);
  }

  async prune(currentTag) {
    const entries = await fs.readdir(this.runtimeDir, { withFileTypes: true });
    const versions = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !TAG_PATTERN.test(entry.name)) continue;
      const stat = await fs.stat(path.join(this.runtimeDir, entry.name));
      versions.push({ name: entry.name, time: stat.mtimeMs });
    }
    versions.sort((a, b) => b.time - a.time);
    const keep = new Set([...new Set([currentTag, ...versions.map((item) => item.name)])].slice(0, KEEP_VERSIONS));
    for (const item of versions) {
      if (!keep.has(item.name)) await fs.rm(path.join(this.runtimeDir, item.name), { recursive: true, force: true });
    }
  }

  async ensure({ autoUpdate = true } = {}) {
    const before = await this.installed();
    if (!autoUpdate && before) return { status: 'pinned', runtime: before };
    this.onStatus({ phase: 'checking' });
    let latest;
    try {
      latest = await this.fetchLatest();
    } catch (error) {
      if (before) return { status: 'offline', runtime: before, error: error.message };
      throw new Error(`No AnyPS5 build is installed and the latest release could not be fetched: ${error.message}`);
    }
    if (before && before.tag === latest.tag) {
      this.onStatus({ phase: 'current', tag: latest.tag });
      return { status: 'current', runtime: before, note: latest.note };
    }
    try {
      await this.install(latest);
    } catch (error) {
      if (before) return { status: 'failed', runtime: before, error: error.message };
      throw new Error(`Installing AnyPS5 ${latest.tag} failed: ${error.message}`);
    }
    const runtime = await this.installed();
    this.onStatus({ phase: 'updated', tag: latest.tag, previous: before?.tag });
    return { status: 'updated', runtime, previous: before?.tag, note: latest.note };
  }
}

module.exports = { Updater, assetNames, relinkerFileName, assertTag, REPO };
