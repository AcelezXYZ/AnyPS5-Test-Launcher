'use strict';

const zlib = require('node:zlib');

const BLOCK = 512;

function readString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const stop = end === -1 || end > start + length ? start + length : end;
  return buffer.toString('utf8', start, stop);
}

function readOctal(buffer, start, length) {
  const text = readString(buffer, start, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error('Malformed tar header');
  return parseInt(text, 8);
}

function parsePax(data) {
  const fields = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.toString('latin1', offset, space));
    if (!Number.isInteger(length) || length <= space - offset + 1 || offset + length > data.length) throw new Error('Malformed pax header');
    const record = data.toString('utf8', space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

function parseTar(buffer, { maxFileBytes = 256 * 1024 * 1024 } = {}) {
  const files = [];
  let offset = 0;
  let pending = {};
  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = readString(header, 345, 155);
    const baseName = readString(header, 0, 100);
    const headerName = prefix ? `${prefix}/${baseName}` : baseName;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error('Truncated tar archive');
    if (type === 'x') {
      pending = { ...pending, ...parsePax(buffer.subarray(dataStart, dataEnd)) };
    } else if (type === 'g' || type === 'L' || type === 'K') {
      if (type === 'L') pending = { ...pending, path: readString(buffer, dataStart, size) };
    } else {
      const name = pending.path ?? headerName;
      const actualSize = pending.size !== undefined ? Number(pending.size) : size;
      pending = {};
      if (type === '0') {
        if (actualSize > maxFileBytes) throw new Error(`Tar entry ${name} is too large`);
        files.push({ name, data: buffer.subarray(dataStart, dataStart + actualSize) });
      } else if (type !== '5') {
        throw new Error(`Unsupported tar entry type ${JSON.stringify(type)} for ${name}`);
      }
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

function readTarGz(compressed, { maxBytes = 1024 * 1024 * 1024 } = {}) {
  const tar = zlib.gunzipSync(compressed, { maxOutputLength: maxBytes });
  return parseTar(tar);
}

module.exports = { parseTar, readTarGz };
