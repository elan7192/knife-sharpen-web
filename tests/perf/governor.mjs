// Unit check for perf.js (fps meter + quality governor) with synthetic frame times, run inside the game page
// so the 'three' import map resolves. Headless Chromium, no rendering involved.
//   node tests/perf/governor.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = 8767;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/?quality=0`); // pinned: the page's own governor stays out of the way
await page.waitForFunction(() => window.__knife, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const { createFpsMeter, createQualityGovernor } = await import('/perf.js');
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

  // Meter: 990 frames at 60 fps + 10 frames at 20 fps -> median 60, worst 1% = 20
  const m = createFpsMeter();
  for (let i = 0; i < 990; i++) m.push(1 / 60);
  for (let i = 0; i < 10; i++) m.push(1 / 20);
  const r = m.report();
  check('meter median 60', Math.abs(r.median - 60) < 0.5, r);
  check('meter worst 1% = 20', Math.abs(r.p1low - 20) < 0.5, r);
  check('meter is a number', typeof +m === 'number' && +m > 0, +m);
  m.reset();
  check('meter reset', m.report().frames === 0, m.report());

  const levels = [0, 1, 2, 3].map((i) => ({ name: `L${i}` }));
  let allowed = true;
  const applied = [];
  const g = createQualityGovernor({ levels, start: 2, max: 3, apply: (_, i) => applied.push(i), canChange: () => allowed });
  const run = (n, ms) => { for (let i = 0; i < n; i++) g.sample(ms / 1000); };
  run(90 + 120 * 3, 16.7); // warm-up + three good windows
  check('probes up after 6 s of steady 60 fps', g.index === 3, g.state());
  run(90 + 120 * 2, 25); // 40 fps for two windows
  check('steps down after two windows at 40 fps', g.index === 2, g.state());
  run(90 + 120 * 10, 16.7);
  check('never re-probes a level that failed', g.index === 2, g.state());
  run(90 + 120, 30); // 33 fps: severe, one window is enough
  check('severe drop steps down at once', g.index === 1, g.state());
  allowed = false;
  run(1000, 50);
  check('holds still while the cinematic runs', g.index === 1, g.state());
  allowed = true;
  const hitch = () => { for (let w = 0; w < 3; w++) { run(118, 16.7); run(2, 50); } };
  run(90, 16.7);
  hitch();
  check('repeated 50 ms hitches count as bad (worst 1% < 28)', g.index === 0, g.state());
  check('apply called for every change', applied.join(',') === '3,2,1,0', applied);

  // Remembered level: a new session starts where the last one settled
  localStorage.removeItem('perf.test');
  const g1 = createQualityGovernor({ levels, start: 2, apply() {}, canChange: () => true, storageKey: 'perf.test' });
  for (let i = 0; i < 90 + 120; i++) g1.sample(0.03);
  const g2 = createQualityGovernor({ levels, start: 2, apply() {}, canChange: () => true, storageKey: 'perf.test' });
  check('next session starts at the remembered level', g1.index === 1 && g2.index === 1, { g1: g1.index, g2: g2.index });
  const g3 = createQualityGovernor({ levels, start: 2, pinned: 3, apply() {}, canChange: () => true, storageKey: 'perf.test' });
  check('?quality pin overrides the remembered level', g3.index === 3 && !g3.auto, g3.state());
  localStorage.removeItem('perf.test');
  return results;
});
let failed = 0;
for (const r of out) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  ${JSON.stringify(r.detail)}`}`);
  if (!r.ok) failed++;
}
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
