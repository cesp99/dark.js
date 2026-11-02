// The dark.js browser suite. The same checks run against the new build and against v1 (main:dark.js);
// everything is judged from screenshot pixels so both implementations are measured the same way.
// Injection mimics Eyed Out: page.addInitScript = WKUserScript at document start, addScriptTag after
// load = document end. OS theme = Playwright colorScheme emulation.
import fs from 'node:fs';
import path from 'node:path';
import {
  ARTIFACTS, decodePng, avgColor, lumRange, isReddish, isBluish, isDark, isLight, near, rgb,
  luminance, Suite, assert, sleep, waitFor,
} from './lib.mjs';

const VIEWPORT = { width: 1000, height: 760 };

export async function runSuite({ browser, browserName, script, label, base }) {
  const suite = new Suite(`${browserName}-${label}`);
  console.log(`\n${suite.name}  (${browser.version ? browser.version() : ''})\n`);
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const open = [];

  /**
   * Opens a fixture in a fresh context.
   * @param {object} o  file, scheme ('light'|'dark'), start (init-script copies), end (copies after load),
   *                    config (window.DarkJSConfig), pre (script run before dark.js), settle (ms)
   */
  async function load(o) {
    // A navigation that never finishes is a harness hiccup (seen once in headless WebKit): retry it once.
    try { return await loadOnce(o); } catch (e) {
      if (!/Timeout/.test(String(e && e.message))) throw e;
      console.log(`    (retrying ${o.file} after a navigation timeout)`);
      return loadOnce(o);
    }
  }
  async function loadOnce({ file, scheme = 'dark', start = 1, end = 0, config = null, pre = '', settle = 700 }) {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: VIEWPORT, deviceScaleFactor: 1 });
    open.push(ctx);
    const prefix = (config ? `window.DarkJSConfig = ${JSON.stringify(config)};\n` : '') + (pre ? `${pre}\n` : '');
    // One init script per copy, config first (Playwright does not order separate init scripts).
    for (let i = 0; i < start; i++) await ctx.addInitScript({ content: (i === 0 ? prefix : '') + script });
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e.message || e).split('\n')[0]));
    try {
      await page.goto(`${base}/${file}`, { waitUntil: 'load', timeout: 15000 });
    } catch (e) {
      await ctx.close().catch(() => {});
      throw e;
    }
    if (start === 0 && prefix) await page.addScriptTag({ content: prefix });
    for (let i = 0; i < end; i++) await page.addScriptTag({ content: script });
    await sleep(settle);
    return page;
  }
  const close = async page => { await page.context().close(); };

  async function shot(page, name) {
    const buf = await page.screenshot();
    fs.writeFileSync(path.join(ARTIFACTS, `${suite.name}-${name}.png`), buf);
    return decodePng(buf);
  }
  const rect = (page, sel) => page.evaluate(s => {
    const [host, inner] = s.split(' >>> ');
    const el = inner ? document.querySelector(host)?.shadowRoot?.querySelector(inner) : document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
  async function region(page, png, sel) {
    const b = await rect(page, sel);
    assert(b, `${sel} not found`);
    return avgColor(png, b.x + b.width * 0.3, b.y + b.height * 0.3, b.width * 0.4, b.height * 0.4);
  }
  /** Empty area at the bottom right of the viewport: the page background. */
  const pageBg = png => avgColor(png, VIEWPORT.width - 120, VIEWPORT.height - 120, 80, 80);
  /** Dark background with light glyphs inside #text-block. */
  async function lightOnDark(page, png) {
    const b = await rect(page, '#text-block');
    const [, hi] = lumRange(png, b.x, b.y, b.width, b.height);
    return hi;
  }
  const call = (page, expr) => page.evaluate(expr);
  const darkLooks = async (page, name) => isDark(pageBg(await shot(page, name)));
  /** Whether either implementation has its style in the document (v1: #dark-mode-styles). */
  const styleOn = page => page.evaluate(() => !!document.querySelector('#dark-by-eyed, #dark-mode-styles'));

  // ---------------------------------------------------------------- basics

  let defaultBg = null;
  await suite.test('OS dark: light page is darkened (document start)', async () => {
    const p = await load({ file: 'light.html' });
    const png = await shot(p, 'light-dark');
    const bg = pageBg(png);
    const hi = await lightOnDark(p, png);
    defaultBg = bg;
    const errs = p.errors;
    await close(p);
    assert(isDark(bg), `page ${rgb(bg)}${errs.length ? `; error: ${errs[0]}` : ''}`);
    assert(hi > 0.5, `text not light (max lum ${hi.toFixed(2)})`);
    return `bg ${rgb(bg)}`;
  });

  await suite.test('no script errors when injected at document start', async () => {
    const p = await load({ file: 'light.html', scheme: 'dark' });
    const errs = p.errors;
    await close(p);
    assert(!errs.length, errs[0]);
  });

  await suite.test('no flash: dark while the page is still parsing', async () => {
    const p = await load({ file: 'light.html', settle: 100 });
    const early = await call(p, () => window.__earlyDark);
    await close(p);
    assert(early === true, `dark mode was not active during parsing (${early})`);
  });

  await suite.test('OS light: page left untouched', async () => {
    const p = await load({ file: 'light.html', scheme: 'light' });
    const bg = pageBg(await shot(p, 'light-light'));
    const on = await styleOn(p);
    await close(p);
    assert(near(bg, [255, 255, 255], 2) && !on, `page ${rgb(bg)}, style ${on ? 'present' : 'absent'}`);
  });

  await suite.test('toggleDarkMode(true / false / no argument)', async () => {
    const p = await load({ file: 'light.html', scheme: 'light' });
    const seq = [];
    await call(p, () => window.toggleDarkMode(true)); await sleep(150); seq.push(await darkLooks(p, 't1'));
    await call(p, () => window.toggleDarkMode(false)); await sleep(150); seq.push(await darkLooks(p, 't2'));
    await call(p, () => window.toggleDarkMode()); await sleep(150); seq.push(await darkLooks(p, 't3'));
    await call(p, () => window.toggleDarkMode()); await sleep(150); seq.push(await darkLooks(p, 't4'));
    await call(p, () => window.toggleDarkMode(true)); await call(p, () => window.toggleDarkMode(true)); await sleep(150);
    seq.push(await darkLooks(p, 't5'));
    await close(p);
    const want = [true, false, true, false, true];
    assert(seq.join() === want.join(), `dark sequence ${seq.join(',')} (expected ${want.join(',')})`);
  });

  await suite.test('live OS theme change (light → dark → light)', async () => {
    const p = await load({ file: 'light.html', scheme: 'light' });
    const seq = [await darkLooks(p, 'os0')];
    await p.emulateMedia({ colorScheme: 'dark' }); await sleep(500); seq.push(await darkLooks(p, 'os1'));
    await p.emulateMedia({ colorScheme: 'light' }); await sleep(500); seq.push(await darkLooks(p, 'os2'));
    await close(p);
    assert(seq.join() === 'false,true,false', `dark sequence ${seq.join(',')}`);
  });

  await suite.test('injection at document end works', async () => {
    const p = await load({ file: 'light.html', start: 0, end: 1 });
    const png = await shot(p, 'end');
    const bg = pageBg(png);
    const hi = await lightOnDark(p, png);
    const errs = p.errors;
    await close(p);
    assert(isDark(bg) && hi > 0.5, `page ${rgb(bg)} text max lum ${hi.toFixed(2)}${errs.length ? `; ${errs[0]}` : ''}`);
    return `bg ${rgb(bg)}`;
  });

  for (const where of ['start', 'end']) {
    await suite.test(`double injection is harmless (document ${where})`, async () => {
      const p = await load({ file: 'light.html', start: where === 'start' ? 2 : 0, end: where === 'end' ? 2 : 0 });
      const dark1 = await darkLooks(p, `double-${where}`);
      const styles = await call(p, () => document.querySelectorAll('#dark-by-eyed, #dark-mode-styles').length);
      await call(p, () => window.toggleDarkMode(false)); await sleep(150);
      const dark2 = await darkLooks(p, `double-${where}-off`);
      const errs = p.errors;
      await close(p);
      assert(dark1 && !dark2 && styles === 1 && !errs.length,
        `dark=${dark1}, after toggle off dark=${dark2}, ${styles} style elements${errs.length ? `, error: ${errs[0]}` : ''}`);
    });
  }

  // ---------------------------------------------------------------- rendering quality

  // Colour checks only count on a page that was actually darkened (a script that failed to run would
  // otherwise "keep" every colour). Run at document start, and at document end for a like-for-like
  // comparison of rendering with v1.
  const notApplied = bg => `dark mode not applied (page ${rgb(bg)})`;
  for (const where of ['start', 'end']) {
    const p = await load({ file: 'light.html', start: where === 'start' ? 1 : 0, end: where === 'end' ? 1 : 0 });
    const png = await shot(p, `quality-${where}`);
    const bg = pageBg(png);
    const at = where === 'end' ? ' (document end)' : '';
    await suite.test(`<img> keeps its colours${at}`, async () => {
      assert(isDark(bg), notApplied(bg));
      const c = await region(p, png, '#photo');
      assert(isReddish(c), rgb(c));
      return rgb(c);
    });
    await suite.test(`CSS photo background keeps its colours${at}`, async () => {
      assert(isDark(bg), notApplied(bg));
      const c = await region(p, png, '#hero');
      assert(isReddish(c), rgb(c));
      return rgb(c);
    });
    await suite.test(`coloured UI keeps its hue${at}`, async () => {
      assert(isDark(bg), notApplied(bg));
      const c = await region(p, png, '#blue-panel');
      assert(isBluish(c), `blue panel ${rgb(c)}`);
      return rgb(c);
    });
    await close(p);
  }

  await suite.test('short page: canvas below the content is dark', async () => {
    const p = await load({ file: 'short.html' });
    const bg = pageBg(await shot(p, 'short'));
    await close(p);
    assert(isDark(bg), rgb(bg));
    return rgb(bg);
  });

  await suite.test('iframe content is darkened exactly once', async () => {
    const p = await load({ file: 'iframe.html', settle: 1000 });
    const png = await shot(p, 'iframe');
    const c = await region(p, png, '#frame');
    await close(p);
    assert(isDark(c), `iframe ${rgb(c)}`);
    return rgb(c);
  });

  {
    const p = await load({ file: 'engine-cases.html', settle: 2600 });
    let png = await shot(p, 'cases');
    const casesBg = pageBg(png);
    const red = (sel, what) => suite.test(`${what} keeps its colours`, async () => {
      assert(isDark(casesBg), notApplied(casesBg));
      const c = await region(p, png, sel);
      assert(isReddish(c), `${sel} ${rgb(c)}`);
      return rgb(c);
    });
    await red('#class-bg', 'stylesheet photo background');
    await red('#inline-bg', 'inline-style photo background');
    await red('#nested-img', '<img> inside a photo background (no double inversion)');
    await red('#xo-bg', 'photo background from a cross-origin stylesheet');
    await red('#late-bg', 'photo background added later (SPA)');
    await red('#cij-bg', 'CSS-in-JS rule (insertRule)');
    await red('#svg-image', 'SVG <image>');
    await red('#vid', '<video> poster');
    await red('x-card >>> #sh-img', '<img> in an open shadow root');
    await suite.test('gradient background follows the page', async () => {
      const c = await region(p, png, '#gradient');
      assert(isDark(c), rgb(c));
      return rgb(c);
    });
    await suite.test('fixed header stays fixed while scrolling', async () => {
      const before = avgColor(png, 300, 10, 200, 20);
      await call(p, () => scrollTo(0, 700)); await sleep(300);
      const png2 = await shot(p, 'cases-scrolled');
      const after = avgColor(png2, 300, 10, 200, 20);
      const top = (await rect(p, '#fixed')).y;
      await call(p, () => scrollTo(0, 0)); await sleep(200);
      assert(isDark(casesBg), notApplied(casesBg));
      // Layout (rect) and paint (same pixels at the top after scrolling) both have to stay put.
      assert(top === 0 && near(before, after, 4), `top=${top} before ${rgb(before)} after ${rgb(after)}`);
      return `header ${rgb(after)}`;
    });
    await suite.test('modal <dialog> (top layer) is darkened', async () => {
      await call(p, () => document.getElementById('dlg').showModal()); await sleep(300);
      png = await shot(p, 'dialog');
      const c = await region(p, png, '#dlg');
      await call(p, () => document.getElementById('dlg').close());
      assert(isDark(c), `dialog ${rgb(c)}`);
      return rgb(c);
    });
    await close(p);
  }

  // ---------------------------------------------------------------- sites that are dark already

  const untouched = (title, file, want, opts = {}) => suite.test(title, async () => {
    const p = await load({ file, settle: opts.settle || 900 });
    const png = await shot(p, file.replace('.html', ''));
    const bg = pageBg(png);
    await close(p);
    assert(near(bg, want, 3), `page ${rgb(bg)}, site colour ${rgb(want)}`);
    return rgb(bg);
  });
  await untouched('natively dark page is left untouched', 'dark-native.html', [18, 20, 23]);
  await untouched('color-scheme: dark page is left untouched', 'dark-scheme.html', [27, 27, 31]);
  await untouched('prefers-color-scheme site keeps its own dark theme (OS dark)', 'auto-scheme.html', [15, 27, 45]);
  await untouched('dark app shell on a transparent body is left untouched', 'dark-wrapper.html', [22, 24, 28]);
  await untouched('theme applied after load is detected', 'late-theme.html', [17, 19, 22], { settle: 2400 });

  await suite.test('prefers-color-scheme site in OS light + toggleDarkMode(true) is darkened', async () => {
    const p = await load({ file: 'auto-scheme.html', scheme: 'light' });
    await call(p, () => window.toggleDarkMode(true)); await sleep(200);
    const dark = await darkLooks(p, 'auto-scheme-forced');
    await close(p);
    assert(dark, 'page not darkened');
  });

  await suite.test('light site with a dark hero is still darkened', async () => {
    const p = await load({ file: 'light-dark-hero.html' });
    await call(p, () => scrollTo(0, 1100)); await sleep(300);
    const bg = pageBg(await shot(p, 'hero-scrolled'));
    await close(p);
    assert(isDark(bg), `content below the hero ${rgb(bg)}`);
  });

  await suite.test('light site behind a dark consent overlay is still darkened', async () => {
    const p = await load({ file: 'light-overlay.html', settle: 900 });
    const on = await styleOn(p);
    await close(p);
    assert(on, 'dark mode switched off');
  });

  // ---------------------------------------------------------------- engine robustness

  const RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGklEQVR4AWN8ICDwnwEJMDGgASYGNMDEgAYAg+QCBygajHwAAAAASUVORK5CYII=';

  await suite.test('content drawn over a photo layer keeps its designed colours (hero text)', async () => {
    const p = await load({ file: 'light.html' });
    await p.evaluate(red => {
      const box = document.createElement('div');
      box.id = 'cover';
      box.style.cssText = 'position:absolute;left:600px;top:40px;width:240px;height:140px;overflow:hidden';
      box.innerHTML = `<img alt="" src="${red}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` +
        '<div id="cover-over" style="position:absolute;left:10px;top:10px;width:100px;height:50px;background:#fff"></div>' +
        '<h2 style="position:relative;margin:0;padding:80px 10px 0;color:#fff">Over a photo</h2>';
      document.body.appendChild(box);
    }, RED);
    await sleep(900);
    const png = await shot(p, 'cover');
    const over = await region(p, png, '#cover-over');
    const b = await rect(p, '#cover');
    const photo = avgColor(png, b.x + 180, b.y + 90, 40, 30);
    await close(p);
    assert(isLight(over) && isReddish(photo), `overlay ${rgb(over)} photo ${rgb(photo)}`);
    return `overlay ${rgb(over)} photo ${rgb(photo)}`;
  });

  await suite.test('raster thumbnails of SVGs (Wikimedia .svg.png) follow the page; photos do not', async () => {
    const p = await load({ file: 'light.html' });
    const f = await call(p, () => ['/w/thumb/a/ab/Euler.svg/250px-Euler.svg.png', '/w/thumb/c/cd/Photo.jpg/250px-Photo.jpg'].map(src => {
      const i = document.createElement('img'); i.src = src; i.alt = ''; document.body.appendChild(i);
      const v = getComputedStyle(i).filter; i.remove(); return v;
    }));
    await close(p);
    assert(f[0] === 'none' && f[1] !== 'none', `svg thumb filter=${f[0]} photo thumb filter=${f[1]}`);
  });

  await suite.test('translucent black modal scrim dims the dark page (no white haze)', async () => {
    const p = await load({ file: 'light.html' });
    const before = pageBg(await shot(p, 'scrim-before'));
    await call(p, () => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50';
      document.body.appendChild(d);
    });
    await sleep(900);
    const after = pageBg(await shot(p, 'scrim'));
    await close(p);
    assert(isDark(after) && after[0] <= before[0], `page under the scrim ${rgb(after)}, without ${rgb(before)}`);
    return `${rgb(before)} -> ${rgb(after)}`;
  });

  await suite.test('page CSP without unsafe-inline: still darkened (constructed stylesheet)', async () => {
    const p = await load({ file: `light.html?csp=${encodeURIComponent("style-src 'self'")}` });
    await p.evaluate(red => {
      const host = document.createElement('div');
      host.id = 'csp-host';
      const img = document.createElement('img');
      img.src = red; img.alt = ''; img.style.width = '200px'; img.style.height = '110px'; img.style.display = 'block';
      host.attachShadow({ mode: 'open' }).appendChild(img);
      document.body.prepend(host);
    }, RED);
    await sleep(900);
    const png = await shot(p, 'csp');
    const bg = pageBg(png);
    const st = await call(p, () => window.DarkJS.state());
    const hb = await rect(p, '#csp-host');
    const shImg = avgColor(png, hb.x + 40, hb.y + 30, 120, 50);
    await close(p);
    assert(isDark(bg) && st.enabled && st.reason !== 'csp-blocked', `page ${rgb(bg)} state ${JSON.stringify(st)}`);
    assert(isReddish(shImg), `<img> in a shadow root ${rgb(shImg)}`);
    return `bg ${rgb(bg)}, shadow img ${rgb(shImg)}`;
  });

  await suite.test('page CSP and no constructable stylesheets: reports csp-blocked instead of enabled', async () => {
    const p = await load({ file: `light.html?csp=${encodeURIComponent("style-src 'self'")}`, pre: 'window.CSSStyleSheet = undefined;' });
    const st = await call(p, () => [window.DarkJS.state(), window.DarkJS.isEnabled(), window.toggleDarkMode(true)]);
    await close(p);
    assert(st[0].reason === 'csp-blocked' && !st[0].enabled && st[1] === false && st[2] === false, JSON.stringify(st));
  });

  await suite.test('toggleDarkMode(true) forces a natively dark page, toggleDarkMode() undoes it', async () => {
    const p = await load({ file: 'dark-native.html' });
    const r1 = await call(p, () => [window.toggleDarkMode(true), window.DarkJS.isEnabled()]);
    await sleep(150);
    const bg1 = pageBg(await shot(p, 'force-toggle-on'));
    const r2 = await call(p, () => [window.toggleDarkMode(), window.DarkJS.isEnabled()]);
    await sleep(150);
    const bg2 = pageBg(await shot(p, 'force-toggle-off'));
    await close(p);
    assert(r1.join() === 'true,true' && isLight(bg1), `toggleDarkMode(true) -> ${r1}, page ${rgb(bg1)}`);
    assert(r2.join() === 'false,false' && isDark(bg2), `toggleDarkMode() -> ${r2}, page ${rgb(bg2)}`);
  });

  await suite.test('a leftover engine <style> from an earlier copy is cleaned up', async () => {
    const p = await load({ file: 'light.html', scheme: 'light' });
    const n = await call(p, () => {
      const st = document.createElement('style');
      st.id = 'dark-by-eyed'; st.setAttribute('data-dark', 'engine');
      st.textContent = ':root{filter:invert(1)!important}';
      document.documentElement.appendChild(st);
      window.DarkJS.enable();
      const on = document.querySelectorAll('style#dark-by-eyed').length;
      window.DarkJS.disable();
      return [on, document.querySelectorAll('style#dark-by-eyed').length];
    });
    await sleep(150);
    const bg = pageBg(await shot(p, 'orphan'));
    await close(p);
    assert(n.join() === '1,0' && isLight(bg), `styles while on/off ${n}, page ${rgb(bg)}`);
  });

  if (browserName === 'chromium') {
    await suite.test('detached shadow trees are not kept alive by the engine', async () => {
      const p = await load({ file: 'light.html' });
      await call(p, () => {
        const box = document.createElement('div');
        box.id = 'churn';
        for (let i = 0; i < 300; i++) {
          const h = document.createElement('div');
          h.attachShadow({ mode: 'open' }).innerHTML = '<span>card</span><img alt="">';
          box.appendChild(h);
        }
        document.body.appendChild(box);
      });
      await sleep(1200);
      const live = () => call(p, () => window.DarkJS.engine.shadowRefs.filter(r => (r.deref ? r.deref() : r)).length);
      const before = await live();
      await call(p, () => document.getElementById('churn').remove());
      const cdp = await p.context().newCDPSession(p);
      for (let i = 0; i < 3; i++) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(100); }
      const after = await live();
      await close(p);
      assert(before >= 300 && after < 30, `styled shadow roots alive: ${before} before, ${after} after removal + GC`);
      return `${before} -> ${after}`;
    });
  }

  // ---------------------------------------------------------------- v2 API

  await suite.test('window.DarkJS API is present', async () => {
    const p = await load({ file: 'light.html', scheme: 'light' });
    const api = await call(p, () => window.DarkJS
      ? ['enable', 'disable', 'toggle', 'configure', 'isEnabled', 'followSystem'].filter(k => typeof window.DarkJS[k] !== 'function')
      : null);
    await close(p);
    assert(api && !api.length, api ? `missing ${api.join(', ')}` : 'window.DarkJS is undefined');
  });

  await suite.test('DarkJS.enable / disable / toggle / isEnabled', async () => {
    const p = await load({ file: 'light.html', scheme: 'light' });
    const seq = await call(p, () => {
      const D = window.DarkJS, s = [];
      if (!D) return null;
      D.enable(); s.push(D.isEnabled());
      D.disable(); s.push(D.isEnabled());
      s.push(D.toggle()); s.push(D.isEnabled());
      s.push(D.toggle(false)); s.push(D.isEnabled());
      return s;
    });
    await close(p);
    assert(seq && seq.join() === 'true,false,true,true,false,false', `sequence ${seq}`);
  });

  await suite.test('DarkJSConfig { followSystem: false } darkens with OS light', async () => {
    const p = await load({ file: 'light.html', scheme: 'light', config: { followSystem: false } });
    const dark = await darkLooks(p, 'cfg-nofollow');
    await close(p);
    assert(dark, 'page not darkened');
  });

  await suite.test('DarkJSConfig { auto: false } waits for a call', async () => {
    const p = await load({ file: 'light.html', scheme: 'dark', config: { auto: false } });
    const before = await darkLooks(p, 'cfg-noauto');
    await call(p, () => window.toggleDarkMode()); await sleep(150);
    const after = await darkLooks(p, 'cfg-noauto-on');
    await close(p);
    assert(!before && after, `before call dark=${before}, after toggleDarkMode() dark=${after}`);
  });

  await suite.test('followSystem(false) keeps the state when the OS theme changes', async () => {
    const p = await load({ file: 'light.html', scheme: 'dark' });
    await call(p, () => window.DarkJS && window.DarkJS.followSystem(false));
    await p.emulateMedia({ colorScheme: 'light' }); await sleep(400);
    const dark = await darkLooks(p, 'nofollow-os');
    await close(p);
    assert(dark, 'page switched to light with the OS');
  });

  await suite.test('brightness option changes rendering', async () => {
    const p = await load({ file: 'light.html', config: { brightness: 50 } });
    const bg = pageBg(await shot(p, 'brightness'));
    await close(p);
    assert(defaultBg && luminance(bg) < luminance(defaultBg) * 0.8 && isDark(bg), `bg ${rgb(bg)} vs default ${defaultBg && rgb(defaultBg)}`);
    return `${rgb(bg)} vs ${rgb(defaultBg)}`;
  });

  await suite.test('configure({ detectDark: false }) forces a dark site', async () => {
    const p = await load({ file: 'dark-native.html' });
    await call(p, () => window.DarkJS && window.DarkJS.configure({ detectDark: false })); await sleep(200);
    const bg = pageBg(await shot(p, 'force-native'));
    await close(p);
    assert(isLight(bg), `page ${rgb(bg)}`);
  });

  // ---------------------------------------------------------------- cost

  // Main-thread cost (script + the style recalculation it causes) is what dark.js controls; the time to
  // the next painted frame is reported too, but headless WebKit paints filters in software.
  await suite.test('cost of switching on, 4000-row page', async () => {
    const p = await load({ file: 'heavy.html', scheme: 'light', settle: 300 });
    const [sync, frame] = await call(p, async () => {
      const t0 = performance.now();
      window.toggleDarkMode(true);
      document.body.getBoundingClientRect();
      getComputedStyle(document.body.lastElementChild).color;
      const t1 = performance.now();
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return [Math.round(t1 - t0), Math.round(performance.now() - t0)];
    });
    const dark = await darkLooks(p, 'heavy');
    await close(p);
    assert(dark, 'heavy page not darkened');
    assert(sync < 100, `${sync} ms script + style recalc (${frame} ms to the next frame)`);
    return `${sync} ms script + style, ${frame} ms to the next frame`;
  });

  for (const ctx of open) await ctx.close().catch(() => {});
  return suite;
}
