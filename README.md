# Dark.js

A lightweight JavaScript plugin to force dark mode on websites that don't natively support it.

## Features

- One GPU filter on the page instead of repainting every element, so it stays fast on huge pages
- Photos, videos and photo backgrounds keep their real colours
- Leaves sites that are already dark alone, including the ones that follow the OS theme on their own
- Follows the system theme, live
- No white flash when injected at document start
- Brightness, contrast and sepia controls
- Safe to inject twice, at document start or at document end

## Usage

1. Inject `dark.js` (or `dark.min.js`) into the page: as a `WKUserScript`, a userscript, or a plain `<script>` tag
2. That's it: the page turns dark when the OS is in dark mode, and back when it isn't

It only runs in the top frame. The filter on the page already covers its iframes.

### API

`window.toggleDarkMode(force)` works exactly as in v1:

```js
toggleDarkMode(true);  // dark
toggleDarkMode(false); // light
toggleDarkMode();      // flip
```

`window.DarkJS` adds a bit more control:

| Method | |
|---|---|
| `DarkJS.enable(opts?)` | Switch dark mode on. `opts` may carry `brightness`, `contrast`, `sepia`, `detectDark` |
| `DarkJS.disable()` | Switch it off |
| `DarkJS.toggle(force?)` | `true` / `false` force a state, anything else flips it. Returns the new state |
| `DarkJS.configure(opts)` | Change any option below, in place |
| `DarkJS.isEnabled()` | Whether the page is being darkened right now (`false` on a page that is dark by itself) |
| `DarkJS.followSystem(bool)` | Follow the OS theme (`true`), or keep the current state whatever the OS does (`false`) |
| `DarkJS.state()` | `{ enabled, wanted, nativeDark, systemDark, followSystem, detectDark, params, reason }` |

While following the system, an OS theme change wins over an earlier manual toggle (same as v1).

### Configuration Options

Set `window.DarkJSConfig` before the script runs (for example in an earlier `WKUserScript`):

```js
window.DarkJSConfig = { followSystem: false, brightness: 90 };
```

- `auto` (`true`): decide on load. With `auto: false` nothing happens until the first API call
- `followSystem` (`true`): follow the OS theme. With `false`, the page is dark as soon as the script runs
- `detectDark` (`true`): skip pages that already have a dark theme. Set it to `false` to force them dark anyway
- `brightness` (`100`): percent, 0–300
- `contrast` (`100`): percent, 0–300
- `sepia` (`0`): percent, 0–100

Injecting the script again with a new `DarkJSConfig` applies the new options to the running copy.

### Opting out

Site authors can keep an element exactly as designed with `.no-dark-mode`, `.darkmode-exempt` or `[data-dark-exempt]`.

## How it works

The page is inverted once with a filter on the root element: white becomes `#121212`, black becomes `#ededed` and
hues are kept. Images, video, embeds and photo backgrounds get the exact opposite filter, so they come out
unchanged. Nothing is repainted per element, so turning it on stays cheap even on a page with thousands of
elements (on a 4000-row test page: ~15 ms in Chromium and ~30 ms in WebKit, where v1 takes hundreds of milliseconds).

Before switching on, it looks at the page (its `color-scheme`, the html/body background and a few points of
the visible area) and stays off if the page is already dark. It looks again as the page loads, because some
themes only show up late.

The rendering engine (`src/engine.js`) is shared verbatim with the
[Dark by Eyed](https://github.com/cesp99/dark) browser extension.

## Deployment

Currently used on **[Eyed Out Browser](https://apps.apple.com/app/eyed-out-private-web-browser/id6475011990)** for the "force dark mode" functionality.

### Build

`dark.js` and `dark.min.js` are built from `src/`:

```bash
npm install
npm run build
```

- `src/engine.js`: the rendering engine, copied from the extension. Don't edit it here: change it in
  [cesp99/dark](https://github.com/cesp99/dark) and run `npm run sync-engine` (it reads `../dark` by default)
- `src/standalone.js`: the part that decides when to turn dark mode on, and the API

## Tests

```bash
npm test               # build, then run the suite in Chromium and WebKit
npm run test:legacy    # the same suite against v1 (main:dark.js)
npm run baseline       # both, written to tests/BASELINE.md
```

Add `--browser=chromium` or `--browser=webkit` to run one browser, and `--headed` to watch it.

The suite uses Playwright and judges everything from screenshot pixels. Pages, iframes and stylesheets are
served from `tests/fixtures`. Scripts are injected at document start, the way a `WKUserScript` is, unless a
test says otherwise. Current results are in [tests/BASELINE.md](./tests/BASELINE.md).

Playwright's WebKit only supports some Linux distributions. On other distributions, point
`DARKJS_WEBKIT_PATH` at a launcher that starts `minibrowser-wpe/MiniBrowser` with the missing libraries on
`LD_LIBRARY_PATH`.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## Licensing

This project is licensed under the GPL 3.0 License - see the [LICENSE](./LICENSE) file for details.

## Installation

Add the script to your browser's userscript manager (run it at `document-start`), or inject it via a browser extension or a `WKUserScript`.

## Compatibility

Tested on WebKit (Safari 27 engine) and Chromium. It needs Safari 14 / iOS 14 or newer. Keeping media
colours inside nested backgrounds needs CSS nesting (Safari 16.5, Chrome 112).
