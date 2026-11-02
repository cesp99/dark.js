## Reading the table

- **v1 in Chromium never runs at document start.** It appends its `<style>` to `document.head`, which
  doesn't exist yet at that point, so it throws (`Cannot read properties of null`). Every check that needs
  a darkened page fails for that reason. The "untouched" checks pass because nothing ran at all.
  Injected at document end, v1 works; see the `(document end)` rows for a like-for-like rendering comparison.
- **v1 in WebKit only works at document start by accident.** Before `<html>` exists, WebKit matches
  neither `prefers-color-scheme: dark` nor `light`. v1 reads "light", and is saved by a late `change`
  event that fires once `<body>` exists, by which time `document.head` is there. The page is still
  painted light first (the flash check), and v1 repaints already-dark sites `#121212`.
  v2 re-reads the theme as soon as `<html>` exists, so the dark style is in place before anything is parsed.
- **Colour samples:** v2 keeps photos and video at their real colours, apart from the outermost 7% of
  tones. That's why the test red `#e01010` reads (155,68,68): the engine's known limit for very saturated
  colours. v1 doesn't touch the image itself, but it repaints every other element `#121212`. That's why
  the blue panel, the gradient and the fixed header lose their colours under v1 in WebKit.
- **Cost:** "script + style" is the main-thread work for switching on, which dark.js controls. "Next frame"
  includes painting. Headless WebKit (WPE on Linux) paints filters in software, so its frame time is much
  higher than on a GPU-composited iPhone. v1's frame time also includes 0.2 s colour transitions on every element.
- **WebKit build:** Playwright's WebKit 27.2 (WPE MiniBrowser) on Arch Linux. It ran through a launcher that
  adds the Ubuntu 24.04 ICU 74, libxml2 2.9 and flite libraries (`DARKJS_WEBKIT_PATH`, see README).
  This is the WebKit engine, not iOS Safari or WKWebView: no touch, no native video fullscreen, no iOS scrollbars.
