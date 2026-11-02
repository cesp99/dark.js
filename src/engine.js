// Synced verbatim from cesp99/dark src/engine.js — do not edit here; change it upstream and copy it over.
/*
 * Dark by Eyed — rendering engine (DarkEngine).
 *
 * Hybrid filter engine: the whole page is inverted once with a GPU filter on the root element
 * (invert + hue-rotate keeps hues, flips lightness) and media is inverted back so photos and video
 * keep their real colours. Nothing is repainted per element, so style recalculation stays tiny even
 * on huge pages.
 *
 *   :root                { filter: invert(1) hue-rotate(180deg) [brightness/contrast/sepia] }
 *   img, video, …        { filter: invert(1) hue-rotate(180deg) }   cancels the root inversion
 *   photo backgrounds    { same }      selectors harvested from stylesheets + inline styles
 *   nested media         { filter: none }   never invert something twice
 *
 * Browser notes (verified in Chromium 156 / Firefox 154):
 *  - A filter on the root does not break position:fixed (spec exception for the root) in either engine.
 *  - Chromium does not filter the default (white) canvas when html/body have no background, but does
 *    filter a propagated html/body background. We therefore give html a low-priority background.
 *  - Chromium renders top-layer elements (fullscreen, modal <dialog>, popovers) outside the root
 *    filter; Firefox renders them inside it. Chromium gets the root filter on top-layer elements.
 *
 * Classic script, no dependencies, no extension APIs: shared verbatim with the dark.js library.
 * Loading it twice in the same global is harmless.
 */
(function (global) {
  'use strict';

  if (global.DarkEngine) return;

  const STYLE_ID = 'dark-by-eyed';
  const BG_ATTR = 'data-dark-bg';
  const XHTML = 'http://www.w3.org/1999/xhtml';
  // White becomes #121212 (not pure black: softer, and leaves room for the brightness slider) and black
  // becomes #ededed. Media gets the exact inverse: invert(1) hue-rotate(180deg) contrast(1/(2·DEPTH−1))
  // cancels invert(DEPTH) hue-rotate(180deg) for every tone except the outer 7% at either end.
  const DEPTH = 0.93;
  const ROOT_BASE = `invert(${DEPTH}) hue-rotate(180deg)`;
  const INVERT = `invert(1) hue-rotate(180deg) contrast(${+(1 / (2 * DEPTH - 1)).toFixed(4)})`;
  const IMP = '!important';

  /** Background given to <html> when the page paints none (Chromium leaves the default canvas unfiltered). */
  const CANVAS = { light: '#fffffe', dark: '#121213' };
  const CANVAS_COMPUTED = ['rgb(255, 255, 254)', 'rgb(18, 18, 19)'];

  const SCROLLBAR = '#56585e #18181a';
  const MEDIA_QUERY = 'screen and (forced-colors: none)';

  const DEFAULTS = Object.freeze({ brightness: 100, contrast: 100, sepia: 0 });
  const LIMITS = { brightness: [0, 300], contrast: [0, 300], sepia: [0, 100] };

  const MAX_BG_SELECTORS = 1500;   // photo-background selectors emitted as CSS
  const MAX_ANCESTOR_SELECTORS = 200; // of which may act as "already re-inverted" ancestors
  const MAX_RULES_PER_PASS = 60000;
  const MAX_SCAN_ELEMENTS = 20000; // per element pass
  const MAX_PENDING_ROOTS = 3000;
  const DARK_LUM = 0.18;

  // Iframes that embed video or maps (pixels, not UI) keep their colours.
  const MEDIA_IFRAMES = [
    'youtube.com/embed', 'youtube-nocookie.com', 'player.vimeo.com', 'dailymotion.com/embed',
    'player.twitch.tv', 'clips.twitch.tv', 'streamable.com/', 'fast.wistia', 'loom.com/embed',
    'tiktok.com/embed', 'facebook.com/plugins/video', 'google.com/maps', 'maps.google.',
  ].map(s => `iframe[src*="${s}"]`);

  // SVG images are nearly always logos, icons, diagrams or formulas drawn in dark ink on transparency:
  // re-inverting them would put dark ink on a dark page, so they follow the page instead.
  const NOT_SVG = ':not([src$=".svg" i]):not([src*=".svg?" i]):not([src*=".svg#" i]):not([src*="/svg/" i])';

  /** Leaf media that must keep original colours. <picture> is not listed: its <img> is. */
  const MEDIA = [`img${NOT_SVG}`, `input[type="image" i]${NOT_SVG}`, 'video', 'image', 'embed', 'object', ...MEDIA_IFRAMES];
  /** Opt-out hooks for site authors (kept from v1). */
  const EXEMPT = ['.no-dark-mode', '.darkmode-exempt', '[data-dark-exempt]'];
  /** Inline photo backgrounds (CMS thumbnails). SVG urls are treated as icons. */
  const INLINE_BG = ':not(html,body)[style*="url(" i][style*="background" i]:not([style*="svg" i])';
  /** Re-inverted elements that can have descendants. */
  const CONTAINERS = ['video', 'object', `[${BG_ATTR}]`, INLINE_BG, ...EXEMPT];
  const BASE_TARGETS = [...MEDIA, `[${BG_ATTR}]`, INLINE_BG, ...EXEMPT];
  const TOP_LAYER = ':fullscreen,:modal,:popover-open';
  // WebKit ignores CSS filter functions on SVG child elements, so an SVG <image> cannot be re-inverted
  // itself: re-invert the outermost <svg> that contains one. hanging-punctuation is WebKit-only.
  const WEBKIT = '(hanging-punctuation:first) and (not (-moz-orient:inline))';
  const SVG_WITH_IMAGE = 'svg:not(svg svg):has(image)';

  const SKIP_SCAN_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE',
    'IMG', 'VIDEO', 'PICTURE', 'SOURCE', 'IFRAME', 'EMBED', 'OBJECT', 'CANVAS', 'BR', 'svg', 'SVG', 'path']);
  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'PICTURE', 'svg', 'SVG', 'image']);

  // ------------------------------------------------------------------ pure helpers

  function clampParams(p) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) {
      const n = Number(p && p[k]);
      const [lo, hi] = LIMITS[k];
      out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[k];
    }
    return out;
  }

  /** Root filter; neutral parameters are omitted to keep the string (and the GPU chain) short. */
  function rootFilter(p) {
    let f = ROOT_BASE;
    if (p.brightness !== 100) f += ` brightness(${+(p.brightness / 100).toFixed(3)})`;
    if (p.contrast !== 100) f += ` contrast(${+(p.contrast / 100).toFixed(3)})`;
    if (p.sepia !== 0) f += ` sepia(${+(p.sepia / 100).toFixed(3)})`;
    return f;
  }

  /** Splits a selector list on top-level commas (ignores commas inside (), [] and strings). */
  function splitSelectors(text) {
    const out = [];
    let depth = 0, quote = '', start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '\\') i++;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
    }
    out.push(text.slice(start).trim());
    return out.filter(Boolean);
  }

  /** The compound selector that selects the subject (the part after the last top-level combinator). */
  function subjectCompound(sel) {
    let depth = 0, quote = '', cut = 0;
    for (let i = 0; i < sel.length; i++) {
      const ch = sel[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '\\') i++;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) cut = i + 1;
    }
    return sel.slice(cut).trim();
  }

  /**
   * Whether a harvested selector may be re-inverted: never the root/body (that would undo the whole
   * page), the universal selector, scrollbars, or relative (nested-rule) selectors.
   */
  function usableSelector(sel) {
    if (!sel || sel.length > 400 || sel.includes('&')) return false;
    const subj = subjectCompound(sel).toLowerCase();
    if (!subj || /^(html|body|:root|\*|:host|::?-webkit-scrollbar|::?-moz-|::selection|::backdrop|::placeholder|::marker)/.test(subj)) return false;
    if (/(^|[^\w-])(html|body|:root)$/.test(subj)) return false;
    return true;
  }

  const hasPseudoElement = sel => /::|:(before|after|first-line|first-letter)\b/i.test(sel);

  function maxPx(size) {
    let m = 0;
    for (const x of String(size).matchAll(/(-?[\d.]+)px/g)) m = Math.max(m, Number(x[1]));
    return m;
  }

  /**
   * Classifies a background as a photo (keep colours) vs. an icon / pattern / gradient (follow the page).
   * @param {{image: string, size?: string, repeat?: string}} bg
   * @param {{w: number, h: number}=} box rendered size when known
   */
  function isPhotoBackground(bg, box) {
    const image = bg.image || '';
    if (!image.includes('url(')) return false;
    const size = (bg.size || '').toLowerCase();
    const big = box && box.w >= 100 && box.h >= 80;
    if (/data:image\/svg|\.svg\b/i.test(image)) {
      // Vector backgrounds are icons/illustrations; only a large "cover" one is treated as a picture.
      return /cover/.test(size) && (!box || big);
    }
    if (/cover|contain/.test(size)) return true;
    if (/%/.test(size) || maxPx(size) >= 64) return true;
    if (/\.(jpe?g|webp|avif|heic)\b|data:image\/(jpe?g|webp|avif)/i.test(image)) return true;
    if (big && !/^repeat|^round|^space/.test((bg.repeat || '').trim())) return true;
    return false;
  }

  /** Parses "rgb(a)" / "#hex" strings; returns [r, g, b, a] (0..255, alpha 0..1) or null. */
  function parseColor(str) {
    if (!str) return null;
    const s = String(str).trim().toLowerCase();
    if (s === 'transparent') return [0, 0, 0, 0];
    let m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
    if (m) {
      let a = m[4] === undefined ? 1 : Number(m[4]);
      if (m[5]) a /= 100;
      return [Number(m[1]), Number(m[2]), Number(m[3]), a];
    }
    m = s.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
      let h = m[1];
      if (h.length <= 4) h = h.split('').map(c => c + c).join('');
      const n = i => parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/);
    if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : Number(m[4])];
    return null;
  }

  function luminance([r, g, b]) {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function bgChunks(selectors) {
    const out = [];
    for (let i = 0; i < selectors.length; i += 300) out.push(`${selectors.slice(i, i + 300).join(',')}{filter:${INVERT}${IMP}}`);
    return out;
  }

  const onlyDark = v => /\bdark\b/.test(v || '') && !/\blight\b/.test(v || '');

  // ------------------------------------------------------------------ engine

  const instances = new WeakMap();

  class Engine {
    constructor(doc, win) {
      this.doc = doc;
      this.win = win;
      this.enabled = false;
      this.params = clampParams(DEFAULTS);
      this.style = null;
      this.canvasMode = 'soft';      // 'soft' | 'off' | 'force'
      this.canvasTone = 'light';
      this.bgSelectors = new Set();  // harvested photo-background selectors
      this.seenRules = new WeakSet();
      this.ruleCounts = new WeakMap();
      this.needElementScan = false;  // cross-origin sheets / var() backgrounds we could not read
      this.scannedAll = false;
      this.pendingRoots = new Set();
      this.shadowRoots = new WeakSet();
      this.shadowStyles = new Set();
      this.customSeen = new WeakSet();
      this.customRetried = new WeakSet();
      this.customPending = new Set();
      this.customTimer = 0;
      this.colorCache = new Map();
      this.idleHandle = 0;
      this.lastSheetCheck = 0;
      this.observer = null;
      this.rootObserver = null;
      this.onReady = this.onReady.bind(this);
      this.onLoadCapture = this.onLoadCapture.bind(this);
      this.tick = this.tick.bind(this);
    }

    isEnabled() { return this.enabled; }

    enable(options) {
      if (options) this.params = clampParams(Object.assign({}, this.params, options));
      if (this.enabled) { this.applyParams(); return this; }
      this.enabled = true;
      this.mount();
      return this;
    }

    update(options) {
      const next = clampParams(Object.assign({}, this.params, options || {}));
      const changed = Object.keys(next).some(k => next[k] !== this.params[k]);
      this.params = next;
      if (this.enabled && changed) this.applyParams();
      return this;
    }

    disable() {
      if (!this.enabled) return this;
      this.enabled = false;
      const { doc } = this;
      if (this.observer) this.observer.disconnect();
      if (this.rootObserver) this.rootObserver.disconnect();
      this.observer = this.rootObserver = null;
      this.observingSubtree = this.bodySeen = false;
      this.sheetCount = -1;
      doc.removeEventListener('DOMContentLoaded', this.onReady);
      this.win.removeEventListener('load', this.onReady);
      doc.removeEventListener('load', this.onLoadCapture, true);
      this.cancelIdle();
      if (this.style) this.style.remove();
      this.style = null;
      for (const el of doc.querySelectorAll(`[${BG_ATTR}]`)) el.removeAttribute(BG_ATTR);
      for (const st of this.shadowStyles) st.remove();
      this.shadowStyles.clear();
      this.shadowRoots = new WeakSet();
      this.customSeen = new WeakSet();
      this.customRetried = new WeakSet();
      this.customPending.clear();
      if (this.customTimer) this.win.clearTimeout(this.customTimer);
      this.customTimer = 0;
      this.scannedAll = false;
      this.walker = null;
      this.pendingRoots.clear();
      return this;
    }

    // ---------------------------------------------------------------- mounting

    mount() {
      const { doc } = this;
      const root = doc.documentElement;
      if (!root) {
        // Some engines run document_start scripts before the root element exists.
        this.rootObserver = new this.win.MutationObserver(() => {
          if (doc.documentElement) { this.rootObserver.disconnect(); this.rootObserver = null; if (this.enabled) this.mount(); }
        });
        this.rootObserver.observe(doc, { childList: true });
        return;
      }
      if (root.namespaceURI !== XHTML) return; // SVG / XML documents are left alone
      if (!this.style) {
        this.style = doc.createElement('style');
        this.style.id = STYLE_ID;
        this.style.setAttribute('data-dark', 'engine');
        // Never print inverted pages, and leave Windows high-contrast palettes alone.
        this.style.media = this.mediaQuery();
      }
      this.guessCanvas();
      this.style.textContent = this.css();
      root.appendChild(this.style);

      // Keep our <style> attached (some frameworks re-render <html>'s children) and notice <body>. While the
      // parser is running only <html>'s children are observed; the subtree is watched from DOMContentLoaded.
      this.observer = new this.win.MutationObserver(records => this.onMutations(records));
      this.observingSubtree = doc.readyState !== 'loading';
      this.observer.observe(root, { childList: true, subtree: this.observingSubtree });
      doc.addEventListener('load', this.onLoadCapture, true); // <link rel=stylesheet> finished loading
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', this.onReady);
      if (doc.readyState !== 'complete') this.win.addEventListener('load', this.onReady);
      if (doc.readyState !== 'loading') this.onReady();
      this.scanSheets(8);
    }

    onReady() {
      if (!this.enabled) return;
      if (this.observer && !this.observingSubtree && this.doc.documentElement) {
        this.observingSubtree = true;
        this.observer.observe(this.doc.documentElement, { childList: true, subtree: true });
      }
      this.checkCanvas();
      this.scanSheets(8);
      this.schedule();
    }

    onLoadCapture(e) {
      const t = e.target;
      if (t && t.nodeName === 'LINK') { this.scanSheets(8); this.schedule(); }
    }

    onMutations(records) {
      if (!this.enabled) return;
      const { doc } = this;
      if (this.style && !this.style.isConnected && doc.documentElement) doc.documentElement.appendChild(this.style);
      if (!this.bodySeen && doc.body) { this.bodySeen = true; this.scanSheets(8); } // <head> is complete
      // New <style>/<link> elements show up as a different sheet count: no per-node work needed.
      const count = doc.styleSheets.length;
      if (count !== this.sheetCount) { this.sheetCount = count; this.scanSheets(4); }
      if (this.scannedAll || this.walker) {
        for (const r of records) {
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (this.pendingRoots.size < MAX_PENDING_ROOTS) this.pendingRoots.add(n);
            else { this.scannedAll = false; break; }
          }
        }
      }
      this.schedule();
    }

    // ---------------------------------------------------------------- CSS

    // Rule layout of our sheet (indices are relied upon for in-place CSSOM updates):
    //   0 :root filter + viewport scrollbar      3 leaf media / exempt / inline photo backgrounds
    //   1 body scrollbar reset                    4 @supports (Chromium top layer)   5 @supports (Firefox backdrop)
    //   2 canvas background                       6 @supports (WebKit SVG <image>)
    //   7… harvested photo-background chunks, last: nesting guard
    css() {
      const F = rootFilter(this.params);
      const rules = [
        // The viewport scrollbar is painted outside the root filter in both engines: give it dark colours
        // directly, and reset the inherited value for everything inside (those scrollbars are filtered).
        `:root{filter:${F}${IMP};scrollbar-color:${SCROLLBAR}${IMP}}`,
        ':where(body){scrollbar-color:auto}',
        this.canvasRule(),
        `${BASE_TARGETS.join(',')}{filter:${INVERT}${IMP}}`,
        // Chromium paints the top layer outside the root filter: give it its own (Firefox already filters it).
        `@supports not (-moz-orient:inline){${TOP_LAYER}{filter:${F}${IMP}}` +
          `${MEDIA.flatMap(m => TOP_LAYER.split(',').map(t => m + t)).join(',')}{filter:none${IMP}}}`,
        // Firefox does filter the top layer, so dialog backdrops would turn into a white haze: keep them as designed.
        `@supports (-moz-orient:inline){::backdrop{filter:${INVERT}${IMP}}}`,
        `@supports ${WEBKIT}{${SVG_WITH_IMAGE}{filter:${INVERT}${IMP}}:is(${CONTAINERS.join(',')}) ${SVG_WITH_IMAGE}{filter:none${IMP}}}`,
        ...bgChunks([...this.bgSelectors]),
        this.nestingRule(),
      ];
      this.bgRendered = this.bgSelectors.size;
      return rules.join('\n');
    }

    canvasRule() {
      const c = CANVAS[this.canvasTone];
      if (this.canvasMode === 'soft') return `:where(html){background-color:${c}}`;
      if (this.canvasMode === 'force') return `html{background-color:${c}${IMP}}`;
      return ':where(html){}';
    }

    /** Anything inside an already re-inverted element must not be inverted a second time. */
    nestingRule() {
      const harvested = [...this.bgSelectors];
      const ancestors = CONTAINERS.concat(harvested.filter(x => !hasPseudoElement(x)).slice(0, MAX_ANCESTOR_SELECTORS));
      // CSS nesting keeps this linear in size; each "& target" is still bucketed by its own subject.
      return `:is(${ancestors.join(',')}){${BASE_TARGETS.concat(harvested).map(t => `& ${t}`).join(',')}{filter:none${IMP}}}`;
    }

    /** Changes filter parameters in place via CSSOM (no re-parse, no flicker). */
    applyParams() {
      const F = rootFilter(this.params);
      try {
        const rules = this.style.sheet.cssRules;
        rules[0].style.setProperty('filter', F, 'important');
        rules[4].cssRules[0].style.setProperty('filter', F, 'important');
      } catch (e) {
        this.render();
      }
    }

    setCanvas(mode, tone) {
      if (mode === this.canvasMode && tone === this.canvasTone) return;
      this.canvasMode = mode;
      this.canvasTone = tone;
      try {
        const sheet = this.style.sheet;
        sheet.deleteRule(2);
        sheet.insertRule(this.canvasRule(), 2);
      } catch (e) {
        this.render();
      }
    }

    /** Appends rules for newly harvested selectors instead of re-parsing the whole sheet. */
    syncBackgrounds() {
      if (!this.style || this.bgSelectors.size === this.bgRendered) return;
      const fresh = [...this.bgSelectors].slice(this.bgRendered);
      this.bgRendered = this.bgSelectors.size;
      try {
        const sheet = this.style.sheet;
        const last = sheet.cssRules[sheet.cssRules.length - 1];
        if (last && String(last.selectorText).startsWith(':is(')) sheet.deleteRule(sheet.cssRules.length - 1);
        for (const rule of bgChunks(fresh)) sheet.insertRule(rule, sheet.cssRules.length);
        sheet.insertRule(this.nestingRule(), sheet.cssRules.length);
      } catch (e) {
        this.render();
      }
    }

    render() {
      if (!this.enabled || !this.style) return;
      const text = this.css();
      if (this.style.textContent !== text) this.style.textContent = text;
    }

    // ---------------------------------------------------------------- canvas

    /**
     * Chromium does not filter the default canvas, so html gets a background when the page paints none.
     * Once the page is styled we drop it again if body paints a background (so body still propagates).
     */
    checkCanvas() {
      const { doc, win } = this;
      const html = doc.documentElement, body = doc.body;
      if (!html || !body) return;
      const hs = win.getComputedStyle(html), bs = win.getComputedStyle(body);
      const ours = CANVAS_COMPUTED.includes(hs.backgroundColor) && hs.backgroundImage === 'none';
      const htmlNone = (ours || this.alpha(hs.backgroundColor) === 0) && hs.backgroundImage === 'none';
      const bodyPaints = this.alpha(bs.backgroundColor) > 0 || bs.backgroundImage !== 'none';
      const scheme = hs.colorScheme || '';
      const tone = onlyDark(scheme) || (/\bdark\b/.test(scheme) && this.prefersDark()) ? 'dark' : 'light';
      let mode = this.canvasMode;
      if (htmlNone) mode = bodyPaints ? 'off' : (ours ? 'soft' : 'force');
      this.setCanvas(mode, tone);
    }

    /**
     * Enabling on a page that is already styled: pick the canvas rule checkCanvas() will settle on before
     * our sheet is attached, so the first check does not change it (a second full style recalculation,
     * ~25 ms on a 4000-row page in WebKit). checkCanvas() still runs and corrects any wrong guess.
     */
    guessCanvas() {
      const { doc, win } = this;
      const html = doc.documentElement, body = doc.body;
      if (!html || !body || doc.readyState === 'loading') return;
      const hs = win.getComputedStyle(html), bs = win.getComputedStyle(body);
      if (this.alpha(hs.backgroundColor) === 0 && hs.backgroundImage === 'none') {
        // With no html background the soft rule applies; with a body background it is not needed.
        this.canvasMode = this.alpha(bs.backgroundColor) > 0 || bs.backgroundImage !== 'none' ? 'off' : 'soft';
      }
      const scheme = hs.colorScheme || '';
      this.canvasTone = onlyDark(scheme) || (/\bdark\b/.test(scheme) && this.prefersDark()) ? 'dark' : 'light';
    }

    /** Safari before 16 does not know forced-colors: a query using it would never match there. */
    mediaQuery() {
      if (this.media === undefined) {
        try {
          this.media = this.win.matchMedia('(forced-colors: none), (forced-colors: active)').matches ? MEDIA_QUERY : 'screen';
        } catch { this.media = MEDIA_QUERY; }
      }
      return this.media;
    }

    prefersDark() {
      try { return this.win.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
    }

    alpha(str) {
      const c = this.color(str);
      return c ? c[3] : 1;
    }

    /** Parses any CSS colour string (computed values may be oklch()/lab() etc.) to [r,g,b,a]. */
    color(str) {
      let c = parseColor(str);
      if (c) return c;
      if (this.colorCache.has(str)) return this.colorCache.get(str);
      try {
        const cv = this.doc.createElement('canvas');
        cv.width = cv.height = 1;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = str;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        c = [d[0], d[1], d[2], d[3] / 255];
      } catch { c = null; }
      if (this.colorCache.size < 200) this.colorCache.set(str, c);
      return c;
    }

    // ---------------------------------------------------------------- stylesheet harvesting

    /** Scans stylesheets for photo backgrounds. Runs for at most `budgetMs`; the rest continues on idle. */
    scanSheets(budgetMs) {
      if (!this.enabled) return true;
      const { doc } = this;
      const deadline = performance.now() + budgetMs;
      const before = this.bgSelectors.size;
      let visited = 0, done = true;
      const ownSheet = this.style && this.style.sheet;
      const sheets = Array.from(doc.styleSheets || []);
      try { if (doc.adoptedStyleSheets) sheets.push(...doc.adoptedStyleSheets); } catch { /* not exposed */ }

      const stack = [];
      for (const sheet of sheets) {
        if (sheet === ownSheet || sheet.disabled) continue;
        let rules;
        try { rules = sheet.cssRules; } catch { this.needElementScan = true; continue; }
        if (!rules || this.ruleCounts.get(sheet) === rules.length) continue;
        stack.push([sheet, rules, 0]);
      }
      outer:
      while (stack.length) {
        const frame = stack[stack.length - 1];
        const [sheet, rules] = frame;
        while (frame[2] < rules.length) {
          if ((++visited & 255) === 0 && (performance.now() > deadline || visited > MAX_RULES_PER_PASS)) { done = false; break outer; }
          const rule = rules[frame[2]++];
          if (this.seenRules.has(rule)) continue;
          this.seenRules.add(rule);
          if (rule.selectorText !== undefined && rule.style) {
            this.harvest(rule);
          } else if (rule.styleSheet) { // @import
            try { const r = rule.styleSheet.cssRules; stack.push([rule.styleSheet, r, 0]); } catch { this.needElementScan = true; }
            continue outer;
          } else if (rule.cssRules) { // @media, @supports, @layer, @container, …
            stack.push([null, rule.cssRules, 0]);
            continue outer;
          }
        }
        stack.pop();
        if (sheet) this.ruleCounts.set(sheet, rules.length);
      }
      if (this.bgSelectors.size !== before) this.syncBackgrounds();
      if (!done) this.schedule();
      this.sheetsPending = !done;
      return done;
    }

    harvest(rule) {
      const st = rule.style;
      const image = st.backgroundImage;
      if (!image) return;
      if (image.includes('var(') || (!image.includes('url(') && (st.background || '').includes('var('))) {
        this.needElementScan = true;
        return;
      }
      if (!image.includes('url(')) return;
      if (!isPhotoBackground({ image, size: st.backgroundSize, repeat: st.backgroundRepeat })) return;
      for (const sel of splitSelectors(rule.selectorText)) {
        if (this.bgSelectors.size >= MAX_BG_SELECTORS) return;
        if (usableSelector(sel)) this.bgSelectors.add(sel);
      }
    }

    // ---------------------------------------------------------------- idle work

    schedule() {
      if (this.idleHandle || !this.enabled) return;
      const w = this.win;
      if (typeof w.requestIdleCallback === 'function') {
        this.idleHandle = w.requestIdleCallback(this.tick, { timeout: 1500 });
        this.idleKind = 'idle';
      } else {
        this.idleHandle = w.setTimeout(() => this.tick({ timeRemaining: () => 8, didTimeout: true }), 60);
        this.idleKind = 'timeout';
      }
    }

    cancelIdle() {
      if (!this.idleHandle) return;
      if (this.idleKind === 'idle') this.win.cancelIdleCallback(this.idleHandle);
      else this.win.clearTimeout(this.idleHandle);
      this.idleHandle = 0;
    }

    tick(deadline) {
      this.idleHandle = 0;
      if (!this.enabled) return;
      const budget = () => Math.min(12, Math.max(2, deadline.timeRemaining()));
      const now = performance.now();
      // CSS-in-JS libraries add rules with insertRule (no DOM mutation): re-check rule counts, throttled.
      if (this.sheetsPending || now - this.lastSheetCheck > 1000) {
        this.lastSheetCheck = now;
        if (!this.scanSheets(budget())) return;
      }
      if (this.doc.readyState === 'loading') return; // full element pass waits for the document
      const end = performance.now() + budget();
      if (!this.scannedAll) {
        if (!this.walker) {
          this.walker = this.doc.createTreeWalker(this.doc.body || this.doc.documentElement, 1);
          this.walked = 0;
          this.pendingRoots.clear();
        }
        if (!this.walk(this.walker, end, true)) { this.schedule(); return; }
        this.walker = null;
        this.scannedAll = true;
      }
      while (this.pendingRoots.size) {
        if (performance.now() > end) { this.schedule(); return; }
        const root = this.pendingRoots.values().next().value;
        this.pendingRoots.delete(root);
        if (!root.isConnected) continue;
        this.walk(this.doc.createTreeWalker(root, 1), Infinity, false, 400);
      }
    }

    /** Walks elements: finds shadow roots and (when stylesheets were unreadable) photo backgrounds. */
    walk(walker, end, counted, cap = Infinity) {
      let n = 0;
      let el = walker.currentNode;
      if (el && el.nodeType === 1 && !counted) this.inspect(el);
      while ((el = walker.nextNode())) {
        this.inspect(el);
        if (++n >= cap) return true;
        if (counted && ++this.walked >= MAX_SCAN_ELEMENTS) return true;
        if ((n & 63) === 0 && performance.now() > end) return false;
      }
      return true;
    }

    inspect(el) {
      if (el.shadowRoot) {
        if (!this.shadowRoots.has(el.shadowRoot)) this.adoptShadow(el.shadowRoot);
      } else if (el.localName.includes('-') && !this.customSeen.has(el) && this.customPending.size < 2000) {
        // Custom elements often attach their shadow root later (lazy definition / upgrade): look again.
        this.customSeen.add(el);
        this.customPending.add(el);
        if (!this.customTimer) this.customTimer = this.win.setTimeout(() => this.recheckCustom(), 1500);
      }
      if (!this.needElementScan || SKIP_SCAN_TAGS.has(el.nodeName) || el.namespaceURI !== XHTML) return;
      const cs = this.win.getComputedStyle(el);
      const image = cs.backgroundImage;
      const marked = el.hasAttribute(BG_ATTR);
      if (image === 'none' || !image.includes('url(')) {
        if (marked) el.removeAttribute(BG_ATTR);
        return;
      }
      if (marked || cs.filter !== 'none') return; // already handled by a CSS rule (or the page filters it)
      const r = el.getBoundingClientRect();
      if (r.height > this.win.innerHeight * 1.5) return; // page-sized wrappers are backgrounds, not photos
      if (isPhotoBackground({ image, size: cs.backgroundSize, repeat: cs.backgroundRepeat }, { w: r.width, h: r.height })) {
        el.setAttribute(BG_ATTR, '');
      }
    }

    recheckCustom() {
      this.customTimer = 0;
      if (!this.enabled) return;
      const els = [...this.customPending];
      this.customPending.clear();
      const retry = [];
      for (const el of els) {
        if (el.shadowRoot) { if (!this.shadowRoots.has(el.shadowRoot)) this.adoptShadow(el.shadowRoot); }
        else if (!this.customRetried.has(el) && el.isConnected) { this.customRetried.add(el); retry.push(el); }
      }
      if (retry.length) {
        for (const el of retry) this.customPending.add(el);
        if (!this.customTimer) this.customTimer = this.win.setTimeout(() => this.recheckCustom(), 6000);
      }
    }

    /** Shadow trees are not reached by document styles: give open ones the media rules. */
    adoptShadow(sr) {
      this.shadowRoots.add(sr);
      try {
        const st = this.doc.createElement('style');
        st.id = STYLE_ID;
        st.media = this.mediaQuery();
        const targets = BASE_TARGETS;
        st.textContent = `${targets.join(',')}{filter:${INVERT}${IMP}}` +
          `:is(${CONTAINERS.join(',')}) :is(${targets.join(',')}){filter:none${IMP}}`;
        sr.appendChild(st);
        this.shadowStyles.add(st);
        const w = this.doc.createTreeWalker(sr, 1);
        let el;
        while ((el = w.nextNode())) if (el.shadowRoot && !this.shadowRoots.has(el.shadowRoot)) this.adoptShadow(el.shadowRoot);
      } catch { /* closed or exotic root */ }
    }

    // ---------------------------------------------------------------- native dark detection

    /**
     * Whether the page already ships a dark theme. Computed colours are not affected by the filter,
     * so this works while the engine is enabled.
     */
    detectNativeDark() {
      return this.analyze().dark;
    }

    analyze() {
      const { doc, win } = this;
      const html = doc.documentElement;
      if (!html || html.namespaceURI !== XHTML) return { dark: false, why: 'no-html' };
      const body = doc.body;
      const cache = new Map();
      const cs = el => { let s = cache.get(el); if (!s) { s = win.getComputedStyle(el); cache.set(el, s); } return s; };
      const prefersDark = this.prefersDark();
      const meta = doc.querySelector('meta[name="color-scheme" i]');
      const metaScheme = meta ? String(meta.content || '').toLowerCase() : '';
      const rootScheme = String(cs(html).colorScheme || '').toLowerCase();
      const scheme = rootScheme && rootScheme !== 'normal' ? rootScheme : metaScheme;
      const schemeDark = onlyDark(scheme) || (/\bdark\b/.test(scheme) && prefersDark);

      if (!body) return { dark: onlyDark(scheme), why: 'no-body', scheme };

      // Paint of one element: luminance of its background colour (or gradient), null if see-through.
      const paint = el => {
        const s = cs(el);
        const img = s.backgroundImage;
        if (img && img !== 'none' && img.includes('gradient')) {
          const stops = img.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi) || [];
          const cols = stops.map(x => this.color(x)).filter(c => c && c[3] >= 0.5);
          if (cols.length) return cols.reduce((a, c) => a + luminance(c), 0) / cols.length;
        }
        if (el === html && CANVAS_COMPUTED.includes(s.backgroundColor)) return null; // our own canvas fix
        const c = this.color(s.backgroundColor);
        if (c && c[3] * Number(s.opacity) >= 0.5) return luminance(c);
        return null;
      };

      let canvasLum = paint(html);
      let canvasExplicit = canvasLum !== null;
      if (canvasLum === null) { canvasLum = paint(body); canvasExplicit = canvasLum !== null; }
      if (canvasLum === null) canvasLum = schemeDark ? 0.01 : 1;
      const canvasDark = canvasLum < DARK_LUM;

      const vw = html.clientWidth || win.innerWidth, vh = win.innerHeight;
      const docH = Math.max(html.scrollHeight, body.scrollHeight, vh);
      const partial = doc.readyState === 'loading';
      const skipFixed = new Map();
      // Translucent overlays, cookie banners and other small fixed boxes say nothing about the page.
      const inSmallFixed = el => {
        for (let e = el; e && e !== body && e !== html; e = e.parentElement) {
          if (skipFixed.has(e)) return skipFixed.get(e);
          const s = cs(e);
          if (s.position === 'fixed' || s.position === 'sticky') {
            const r = e.getBoundingClientRect();
            const big = r.width >= vw * 0.9 && r.height >= vh * 0.9;
            const c = this.color(s.backgroundColor);
            const skip = !(big && c && c[3] * Number(s.opacity) >= 0.9); // dimming backdrops use opacity too
            skipFixed.set(e, skip);
            if (skip) return true;
          }
        }
        return false;
      };

      const samples = [];
      for (const fy of [0.35, 0.6, 0.85]) {
        for (const fx of [0.3, 0.5, 0.7]) {
          const stack = doc.elementsFromPoint(vw * fx, vh * fy);
          let sample = null;
          for (const el of stack) {
            if (el === html || el === body) break;
            if (el.namespaceURI !== XHTML && el.nodeName !== 'svg') continue;
            const s = cs(el);
            if (Number(s.opacity) < 0.1) continue;
            if (inSmallFixed(el)) continue;
            if (MEDIA_TAGS.has(el.nodeName)) {
              const r = el.getBoundingClientRect();
              if (r.width * r.height >= vw * vh * 0.2) { sample = { media: true }; break; } // a hero picture: no signal
              continue; // an icon or thumbnail: look at what it sits on
            }
            const lum = paint(el);
            if (lum === null) continue;
            const r = el.getBoundingClientRect();
            // While the parser is still running the document height is not final, so an element that
            // seems to cover "the whole page" may just be a hero above content that is not parsed yet.
            const strong = !partial && (r.height >= docH * 0.8 || (s.position === 'fixed' && r.height >= vh * 0.9));
            sample = { lum, strong };
            break;
          }
          if (!sample) sample = { lum: canvasLum, strong: true, canvas: true };
          if (!sample.media) samples.push(sample);
        }
      }
      const n = samples.length;
      const darkN = samples.filter(s => s.lum < DARK_LUM).length;
      const strongDarkN = samples.filter(s => s.lum < DARK_LUM && s.strong).length;
      let dark;
      if (!n) dark = canvasDark && (canvasExplicit || schemeDark);
      else if (canvasDark) dark = darkN / n > 0.5;
      else dark = strongDarkN / n >= 0.6;
      return { dark, scheme, schemeDark, canvasLum, canvasExplicit, samples: n, darkN, strongDarkN };
    }
  }

  const DarkEngine = {
    version: '2.0.0',
    /** Returns the engine singleton for a document. */
    create(opts = {}) {
      const doc = opts.doc || global.document;
      const win = opts.win || (doc && doc.defaultView) || global;
      let e = instances.get(doc);
      if (!e) { e = new Engine(doc, win); instances.set(doc, e); }
      return e;
    },
    defaults: DEFAULTS,
    util: { rootFilter, clampParams, splitSelectors, subjectCompound, usableSelector, isPhotoBackground, parseColor, luminance, MEDIA },
  };

  Object.defineProperty(global, 'DarkEngine', { value: Object.freeze(DarkEngine), configurable: true, writable: false });
})(typeof globalThis !== 'undefined' ? globalThis : this);
