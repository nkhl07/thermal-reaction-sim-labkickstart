// build.js — produce a single self-contained HTML file.
//
// index.html imports ./thermal-sim.js as a module (needs a static server).
// This inlines the same core into dist/standalone.html so the page runs from
// file:// with no server, and can be shared as one file. Single source of
// truth: the physics is never hand-copied, always inlined from thermal-sim.js.
//
//   node build.js

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const core = readFileSync('./thermal-sim.js', 'utf8')
  .replace(/^export default[\s\S]*?;$/m, '')   // drop the default export line
  .replace(/\bexport\s+/g, '');                 // strip remaining `export ` keywords

const html = readFileSync('./index.html', 'utf8')
  .replace(/import \{ ThermalSim, C \} from '\.\/thermal-sim\.js';/,
    '/* --- inlined thermal-sim.js core --- */\n' + core + '\n/* --- end core --- */');

mkdirSync('./dist', { recursive: true });
writeFileSync('./dist/standalone.html', html);
console.log('wrote dist/standalone.html (' + html.length + ' bytes)');
