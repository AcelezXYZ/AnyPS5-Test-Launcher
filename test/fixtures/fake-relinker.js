#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (process.env.FAKE_RELINKER_LOG) fs.appendFileSync(process.env.FAKE_RELINKER_LOG, `${JSON.stringify(args)}\n`);
const positional = args.filter((arg) => !arg.startsWith('--') && !arg.startsWith('unused-filter='));
if (positional.length !== 2) {
  console.error('usage: relinker [options] <input.elf> <output>');
  process.exit(1);
}
const [input, output] = positional;
const head = fs.readFileSync(input);
if (head.includes('FAIL')) {
  console.error('Conversion error: unsupported instruction');
  process.exit(2);
}
const outDir = path.dirname(path.resolve(output));
fs.writeFileSync(output, `#!/usr/bin/env node
console.log('Physical device candidate: Fake GPU 9000');
console.log('GPU=' + (process.env.ANYPS5_GPU || ''));
console.log('CWD=' + process.cwd());
process.exit(7);
`);
for (const dir of ['sce_module', 'sce_modules', 'prx']) {
  const source = path.join(path.dirname(input), dir);
  if (!fs.existsSync(source)) continue;
  for (const name of fs.readdirSync(source)) {
    const target = path.join(outDir, 'app0', dir, `${name}.guest.prx`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'guest');
    console.log(`Guest module: ${target}`);
  }
}
console.log(`Output file: ${output}`);
