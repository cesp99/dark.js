// Copies the rendering engine from a checkout of cesp99/dark (the "Dark by Eyed" extension).
//   node scripts/sync-engine.mjs [path/to/dark]        default: ../dark
//   node scripts/sync-engine.mjs --check [path]        exit 1 if src/engine.js is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const upstream = path.resolve(ROOT, args.find(a => !a.startsWith('--')) || '../dark');
const from = path.join(upstream, 'src/engine.js');
const to = path.join(ROOT, 'src/engine.js');
const HEADER = '// Synced verbatim from cesp99/dark src/engine.js — do not edit here; change it upstream and copy it over.\n';

if (!fs.existsSync(from)) { console.error(`No engine at ${from}`); process.exit(2); }
const next = HEADER + fs.readFileSync(from, 'utf8');
const current = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : '';
if (check) {
  console.log(next === current ? 'src/engine.js is in sync' : `src/engine.js differs from ${from}`);
  process.exit(next === current ? 0 : 1);
}
fs.writeFileSync(to, next);
console.log(next === current ? 'src/engine.js already in sync' : `src/engine.js updated from ${from}`);
