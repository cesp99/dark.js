// Runs the browser suite.
//   node tests/run.mjs                      new build (dark.js), Chromium + WebKit
//   node tests/run.mjs --legacy             v1 from main:dark.js
//   node tests/run.mjs --browser=webkit     one browser (chromium | webkit | firefox)
//   --headed                                show the browser
import { startServer, loadScript, launch } from './lib.mjs';
import { runSuite } from './suite.mjs';

const legacy = process.argv.includes('--legacy');
const arg = process.argv.find(a => a.startsWith('--browser='));
const browsers = arg ? arg.slice(10).split(',') : ['chromium', 'webkit'];

const { server, base } = await startServer();
const script = loadScript(legacy);
let failed = 0;
for (const name of browsers) {
  let browser;
  try {
    browser = await launch(name);
  } catch (e) {
    console.log(`\n${name}: could not launch — ${String(e.message).split('\n').slice(0, 2).join(' ')}`);
    failed++;
    continue;
  }
  const suite = await runSuite({ browser, browserName: name, script, label: legacy ? 'legacy' : 'new', base });
  failed += suite.summary();
  await browser.close();
}
server.close();
process.exit(failed ? 1 : 0);
