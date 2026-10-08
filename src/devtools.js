'use strict';

const fs = require('node:fs');
const { app } = require('electron');

function screenshotAndQuit(win, file) {
  win.webContents.on('console-message', (event) => console.log(`[renderer ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`));
  const delay = Number(process.env.ANYPS5_LAUNCHER_SCREENSHOT_DELAY) || 2500;
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const script = process.env.ANYPS5_LAUNCHER_SCREENSHOT_SCRIPT;
      if (script) await win.webContents.executeJavaScript(script).catch((error) => console.error(error));
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        app.quit();
      }, 800);
    }, delay);
  });
}

module.exports = { screenshotAndQuit };
