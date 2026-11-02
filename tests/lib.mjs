// Shared helpers for the browser tests: fixture server, browser launch, pixel sampling, a tiny runner.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'tests/fixtures');
export const ARTIFACTS = path.join(ROOT, 'tests/artifacts');

/** 4000 rows and 50 colour rules: the page the v1 universal `*` rule struggled with. */
function heavyPage() {
  const rows = [];
  for (let i = 0; i < 4000; i++) {
    rows.push(`<div class="row r${i % 50}"><span class="label">Row ${i}</span> <a href="#${i}">link ${i}</a> <em>item</em></div>`);
  }
  const rules = [];
  for (let i = 0; i < 50; i++) rules.push(`.r${i}{background:hsl(${i * 7},60%,96%);border-bottom:1px solid hsl(${i * 7},30%,85%)}`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Heavy</title><style>body{margin:0;background:#fff;color:#222;font:14px system-ui}${rules.join('')}</style></head><body>${rows.join('\n')}</body></html>`;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.js': 'text/javascript' };

/**
 * Serves tests/fixtures. Pages are opened on 127.0.0.1; `{{XO}}` in a fixture becomes the same server
 * on `localhost`, which is a different origin (cross-origin stylesheets cannot be read by the engine).
 */
export async function startServer() {
  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/heavy.html') {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(heavyPage());
    }
    const file = path.join(FIXTURES, path.basename(url.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    if (type.startsWith('text/html')) return res.end(fs.readFileSync(file, 'utf8').replaceAll('{{XO}}', `http://localhost:${port}`));
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  return { server, port, base: `http://127.0.0.1:${port}` };
}

/** The script under test: the built dark.js, or v1 straight from the main branch. */
export function loadScript(legacy) {
  if (legacy) return execFileSync('git', ['-C', ROOT, 'show', 'main:dark.js'], { encoding: 'utf8' });
  const file = path.join(ROOT, 'dark.js');
  if (!fs.existsSync(file)) throw new Error('dark.js not built — run npm run build');
  return fs.readFileSync(file, 'utf8');
}

/**
 * Launches a Playwright browser. WebKit can use a custom launcher via DARKJS_WEBKIT_PATH (for hosts
 * Playwright does not support out of the box, see README); host validation is skipped then.
 */
export async function launch(name) {
  const pw = await import('playwright');
  const opts = { headless: !process.argv.includes('--headed') };
  if (name === 'webkit' && process.env.DARKJS_WEBKIT_PATH) {
    process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
    opts.executablePath = process.env.DARKJS_WEBKIT_PATH;
  }
  return pw[name].launch(opts);
}

export function decodePng(buf) { return PNG.sync.read(buf); }

/** Average colour of a rectangle in a decoded PNG. */
export function avgColor(png, x, y, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let j = Math.max(0, Math.round(y)); j < Math.min(png.height, Math.round(y + h)); j++) {
    for (let i = Math.max(0, Math.round(x)); i < Math.min(png.width, Math.round(x + w)); i++) {
      const k = (png.width * j + i) * 4;
      r += png.data[k]; g += png.data[k + 1]; b += png.data[k + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n].map(Math.round) : [0, 0, 0];
}

/** Brightest and darkest luminance in a rectangle (text glyphs vs. background). */
export function lumRange(png, x, y, w, h) {
  let lo = 1, hi = 0;
  for (let j = Math.max(0, Math.round(y)); j < Math.min(png.height, Math.round(y + h)); j++) {
    for (let i = Math.max(0, Math.round(x)); i < Math.min(png.width, Math.round(x + w)); i++) {
      const k = (png.width * j + i) * 4;
      const l = luminance([png.data[k], png.data[k + 1], png.data[k + 2]]);
      if (l < lo) lo = l;
      if (l > hi) hi = l;
    }
  }
  return [lo, hi];
}

export function luminance([r, g, b]) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export const isReddish = ([r, g, b]) => r > 150 && g < 90 && b < 90;
export const isBluish = ([r, g, b]) => b > r + 40 && b > 110;
export const isDark = c => luminance(c) < 0.12;
export const isLight = c => luminance(c) > 0.6;
/** Within `tol` of an expected colour on every channel. */
export const near = (c, want, tol = 3) => c.every((v, i) => Math.abs(v - want[i]) <= tol);
export const rgb = c => `rgb(${c.join(',')})`;

/** Records results instead of throwing on the first failure. */
export class Suite {
  constructor(name) { this.name = name; this.results = []; }
  async test(title, fn) {
    try {
      const note = await fn();
      this.results.push({ title, ok: true, note: note || '' });
      console.log(`  ✓ ${title}${note ? `  (${note})` : ''}`);
    } catch (e) {
      const note = String(e?.message || e).split('\n')[0].slice(0, 160);
      this.results.push({ title, ok: false, note });
      console.log(`  ✗ ${title}\n      ${note}`);
    }
  }
  summary() {
    const failed = this.results.filter(r => !r.ok).length;
    console.log(`\n${this.name}: ${this.results.length - failed}/${this.results.length} passed`);
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, `${this.name}.json`), JSON.stringify(this.results, null, 2));
    return failed;
  }
}

export function assert(cond, msg) { if (!cond) throw new Error(msg); }
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Polls fn until it returns truthy or times out; returns the last value. */
export async function waitFor(fn, { timeout = 3000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(interval); }
  return v;
}
