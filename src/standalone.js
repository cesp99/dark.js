/*
 * dark.js — standalone controller around DarkEngine.
 *
 * Decides when the page should be dark (OS theme, manual toggles, page config) and drives the engine.
 * Works as an injected script (Eyed Out: WKUserScript at document start or end), as a userscript, or
 * from a <script> tag. Safe to load more than once: the second copy only forwards a new DarkJSConfig.
 *
 *   window.toggleDarkMode(force?)          v1 API, kept as is: true = on, false = off, no argument = flip
 *   window.DarkJS                          enable(opts) disable() toggle(force) configure(opts)
 *                                          isEnabled() followSystem(bool) state()
 *   window.DarkJSConfig (before loading)   { auto, followSystem, detectDark, brightness, contrast, sepia }
 */
(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc || !global.DarkEngine) return;

  // Only the top frame runs: the root filter already covers every iframe, and inverting a frame
  // again inside an inverted page would turn it back to light.
  let top = true;
  try { top = global.top === global; } catch (e) { top = false; }
  if (!top) return;

  const existing = global.DarkJS;
  if (existing && existing.__darkjs) {
    const cfg = global.DarkJSConfig;
    if (cfg && typeof cfg === 'object' && cfg !== existing.__config) existing.configure(cfg);
    return;
  }

  const VERSION = '2.0.0';
  const PARAMS = ['brightness', 'contrast', 'sepia'];
  const userConfig = global.DarkJSConfig && typeof global.DarkJSConfig === 'object' ? global.DarkJSConfig : {};
  const config = Object.assign(
    { auto: true, followSystem: true, detectDark: true, brightness: 100, contrast: 100, sepia: 0 },
    userConfig,
  );

  const engine = global.DarkEngine.create({ doc, win: global });
  const mql = typeof global.matchMedia === 'function' ? global.matchMedia('(prefers-color-scheme: dark)') : null;

  let started = false;        // nothing happens before auto-init or the first API call
  let manual = null;          // null: follow the OS theme; true / false: set by a call
  let forced = false;         // an explicit "on" call: darken even a page that looks natively dark
  let nativeDetected = false; // the page ships its own dark theme
  let reason = 'idle';
  let lastSystem = null;      // OS theme seen by the last decision

  const query = q => { try { return global.matchMedia(q).matches; } catch (e) { return false; } };
  // A fresh query every time: before <html> exists (WKUserScript at document start) WebKit matches
  // neither dark nor light, and the MediaQueryList created then stays stale until a late 'change'.
  const systemDark = () => query('(prefers-color-scheme: dark)');
  const schemeKnown = () => systemDark() || query('(prefers-color-scheme: light)');
  const params = () => {
    const p = {};
    for (const k of PARAMS) if (config[k] !== undefined) p[k] = config[k];
    return p;
  };
  const wanted = () => (manual !== null ? manual : !!config.followSystem && systemDark());
  /** The state callers see: whether the page is being darkened (never before the controller started). */
  const current = () => started && engine.isEnabled();

  function looksNativeDark() {
    if (!doc.body) return false;
    try { return engine.detectNativeDark(); } catch (e) { return false; }
  }

  /** @param {boolean} recheck look at the page before switching on (it may already be dark) */
  function apply(recheck) {
    if (!started) return;
    lastSystem = systemDark();
    const want = wanted();
    const respectNative = config.detectDark && !(forced && manual === true);
    if (want && recheck && respectNative && !nativeDetected && looksNativeDark()) nativeDetected = true;
    const on = want && !(respectNative && nativeDetected);
    reason = on ? (manual !== null ? 'manual' : 'system')
      : want ? 'native-dark'
      : manual !== null ? 'manual' : config.followSystem ? 'system' : 'off';
    if (on) {
      // On a page whose CSP blocks inline styles, in an engine without constructable stylesheets
      // (iOS < 16.4), the engine stays blocked: isEnabled() is false and state().reason 'csp-blocked'.
      if (engine.isEnabled()) engine.update(params());
      else engine.enable(params());
    } else if (engine.isEnabled() || engine.isBlocked()) {
      engine.disable();
    }
  }

  /** Runs at each stage of the page load: themes can appear late (scripts, async stylesheets). */
  function detect() {
    if (!started || nativeDetected || !config.detectDark || (forced && manual === true) || !wanted()) return;
    if (looksNativeDark()) {
      nativeDetected = true;
      apply(false);
    }
  }

  function whenBody(fn) {
    if (doc.body) { fn(); return; }
    const root = doc.documentElement || doc;
    const mo = new global.MutationObserver(() => {
      if (doc.body) { mo.disconnect(); fn(); }
    });
    // At WKUserScript document start even <html> may not exist yet: watch the document then.
    mo.observe(root, { childList: true, subtree: root === doc });
    doc.addEventListener('DOMContentLoaded', () => { mo.disconnect(); if (doc.body) fn(); }, { once: true });
  }

  let scheduled = false;
  function scheduleDetection() {
    if (scheduled) return;
    scheduled = true;
    let bodyDone = false;
    whenBody(() => { if (!bodyDone) { bodyDone = true; detect(); } });
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', detect, { once: true });
    const onLoad = () => { detect(); global.setTimeout(detect, 1000); };
    if (doc.readyState !== 'complete') global.addEventListener('load', onLoad, { once: true });
    else onLoad();
  }

  function start() {
    if (started) return;
    started = true;
    scheduleDetection();
  }

  function onSchemeChange() {
    if (!started || systemDark() === lastSystem) return; // WebKit's late first 'change' is not a change
    // v1 behaviour: the OS theme wins over an earlier manual toggle while following the system.
    if (config.followSystem) { manual = null; forced = false; }
    // Sites whose own theme follows the OS may have switched with it: look again once their scripts ran.
    nativeDetected = false;
    apply(true);
    global.setTimeout(detect, 300);
  }
  if (mql) {
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSchemeChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onSchemeChange); // iOS < 14
  }

  function setParams(opts) {
    if (!opts || typeof opts !== 'object') return false;
    let decisive = false;
    for (const k of PARAMS) if (opts[k] !== undefined) config[k] = opts[k];
    if (opts.detectDark !== undefined && !!opts.detectDark !== !!config.detectDark) {
      config.detectDark = !!opts.detectDark;
      decisive = true;
    }
    if (opts.followSystem !== undefined && !!opts.followSystem !== !!config.followSystem) {
      setFollow(!!opts.followSystem);
      decisive = true;
    }
    return decisive;
  }

  function setFollow(on) {
    if (on) { manual = null; forced = false; }
    else if (manual === null) manual = wanted(); // keep what the page looks like right now
    config.followSystem = on;
  }

  /** An explicit call: `true` darkens the page even if it looks natively dark (v1 always did). */
  function set(on) {
    start();
    manual = !!on;
    forced = !!on;
    apply(true);
    return current();
  }

  const DarkJS = {
    version: VERSION,
    /** Switches dark mode on. `opts` may carry brightness / contrast / sepia (percent) and detectDark. */
    enable(opts) { setParams(opts); set(true); return DarkJS; },
    disable() { set(false); return DarkJS; },
    /** `true` / `false` force a state; anything else flips it. Returns the new state. */
    toggle(force) { return set(typeof force === 'boolean' ? force : !current()); },
    /** Changes parameters / options in place; does not start a controller created with auto: false. */
    configure(opts) {
      const decisive = setParams(opts);
      apply(decisive);
      return DarkJS;
    },
    /** Whether the page is being darkened right now (false on a page that is dark by itself). */
    isEnabled() { return started && engine.isEnabled(); },
    /** Follow the OS theme (true), or keep the current state regardless of it (false). */
    followSystem(on) {
      setFollow(on === undefined ? true : !!on);
      start();
      apply(true);
      return DarkJS;
    },
    state() {
      return {
        enabled: current(), wanted: started && wanted(), nativeDark: nativeDetected,
        systemDark: systemDark(), followSystem: !!config.followSystem, detectDark: !!config.detectDark,
        // Enabling may complete later (WebKit at document start mounts once <html> exists).
        params: params(), reason: engine.isBlocked() ? 'csp-blocked' : reason,
      };
    },
    engine,
  };
  Object.defineProperty(DarkJS, '__darkjs', { value: true });
  Object.defineProperty(DarkJS, '__config', { value: global.DarkJSConfig });

  /** v1 API, unchanged: `true` switches on, `false` off, no argument (or null) flips. */
  function toggleDarkMode(force = null) {
    if (force === null || force === undefined) return DarkJS.toggle();
    if (force === true || force === false) return DarkJS.toggle(force);
    return current();
  }

  global.DarkJS = DarkJS;
  global.toggleDarkMode = toggleDarkMode;

  if (config.auto !== false) {
    if (!config.followSystem) manual = true; // not following the OS: auto-init means "dark now"
    start();
    apply(true);
  }

  // WebKit at document start: the OS theme becomes known once <html> exists, still before anything is
  // parsed or painted. Decide again then (the engine mounts in the same microtask, so no flash).
  if (!doc.documentElement && !schemeKnown()) {
    const mo = new global.MutationObserver(() => {
      if (!doc.documentElement) return;
      mo.disconnect();
      apply(false);
    });
    mo.observe(doc, { childList: true });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
