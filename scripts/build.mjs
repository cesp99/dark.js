// Builds dark.js (readable, single file) and dark.min.js (terser) from src/.
//   node scripts/build.mjs
// src/engine.js is synced verbatim from cesp99/dark; src/standalone.js is the library wrapper.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').trim();

const banner = `/*! dark.js v${pkg.version} | force dark mode for any website | GPL-3.0 | https://github.com/cesp99/dark.js */`;
// Each part is a self-contained IIFE; the leading ';' keeps concatenation safe whatever precedes it.
const parts = ['engine.js', 'standalone.js'].map(f => {
  const src = read(f);
  if (!/\)\s*;?$/.test(src)) throw new Error(`src/${f} must end with an IIFE call`);
  return `;${src.replace(/;?$/, ';')}`;
});
const out = `${banner}\n${parts.join('\n\n')}\n`;

// Parse check before writing anything.
new Function(out); // eslint-disable-line no-new-func

const min = await minify(out, {
  ecma: 2020,
  compress: { passes: 2 },
  mangle: true,
  format: { comments: /^!/ },
});
if (!min.code) throw new Error('terser produced no output');

fs.writeFileSync(path.join(ROOT, 'dark.js'), out);
fs.writeFileSync(path.join(ROOT, 'dark.min.js'), `${min.code}\n`);
const kb = f => (fs.statSync(path.join(ROOT, f)).size / 1024).toFixed(1);
console.log(`dark.js ${kb('dark.js')} KB, dark.min.js ${kb('dark.min.js')} KB`);
