'use strict';

const { spawn } = require('node:child_process');
const { outputName } = require('./plan');
const path = require('node:path');

const GPU_LINE = /Physical device candidate\b[^\n]*/;

function extractGpuName(line) {
  const match = GPU_LINE.exec(line);
  return match ? match[0].replace(/^Physical device candidate\W*/, '').trim() : undefined;
}

function launchGame({ workDir, platform = process.platform, gpu, onLog = () => {}, onGpu = () => {} }) {
  const env = { ...process.env };
  if (gpu) env.ANYPS5_GPU = gpu;
  const executable = path.join(workDir, outputName(platform));
  const child = spawn(executable, [], { cwd: workDir, env, windowsHide: true });
  const forward = (stream, label) => {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        onLog({ source: label, line });
        const name = extractGpuName(line);
        if (name) onGpu(name);
      }
    });
    stream.on('end', () => {
      if (pending) onLog({ source: label, line: pending });
    });
  };
  forward(child.stdout, 'game');
  forward(child.stderr, 'game');
  const exited = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}

module.exports = { launchGame, extractGpuName };
