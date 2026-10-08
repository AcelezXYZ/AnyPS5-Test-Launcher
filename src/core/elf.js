'use strict';

const fs = require('node:fs/promises');

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

async function isElf(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && head.equals(ELF_MAGIC);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

module.exports = { isElf };
