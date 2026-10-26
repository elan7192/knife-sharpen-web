// Perf harness (效能線): headless iPhone 13 emulation, counts WebGL draw calls / triangles per frame,
// times the JS frame callback, and screenshots each scene for before/after comparison.
//
//   node tests/perf/measure.mjs [outDir] [--port 8766] [--label before]
//
// Needs Playwright with Chromium (preinstalled in the cloud box; locally: npm i -D playwright && npx playwright install chromium).
// Headless Chromium renders with SwiftShader (CPU): its fps is NOT the iPhone's. Draw calls, triangles,
// shadow-map passes and JS ms/frame are device independent and are what this harness compares.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// require() so a global install found through NODE_PATH works as well as a local one
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const outDir = path.resolve(args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) ?? 'perf-out');
const port = Number(flag('--port', 8766));
const label = flag('--label', 'run');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
mkdirSync(outDir, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

// Injected before the page: wraps the draw entry points and requestAnimationFrame.
const INSTRUMENT = () => {
  const s = (window.__perfProbe = { calls: 0, tris: 0, points: 0, frames: [], cb: [], record: false });
  const MODE_TRIS = { 4: 1, 5: 1, 6: 1 }; // TRIANGLES / STRIP / FAN
  const add = (mode, count, inst = 1) => {
    s.calls++;
    if (MODE_TRIS[mode]) s.tris += (mode === 4 ? count / 3 : count - 2) * inst;
    else if (mode === 0) s.points += count * inst;
  };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const p = C.prototype;
    const de = p.drawElements, da = p.drawArrays;
    p.drawElements = function (m, c, t, o) { add(m, c); return de.call(this, m, c, t, o); };
    p.drawArrays = function (m, f, c) { add(m, c); return da.call(this, m, f, c); };
    if (p.drawElementsInstanced) { const f = p.drawElementsInstanced; p.drawElementsInstanced = function (m, c, t, o, n) { add(m, c, n); return f.call(this, m, c, t, o, n); }; }
    if (p.drawArraysInstanced) { const f = p.drawArraysInstanced; p.drawArraysInstanced = function (m, a, c, n) { add(m, c, n); return f.call(this, m, a, c, n); }; }
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf((t) => {
    const c0 = s.calls, t0 = s.tris, p0 = s.points, a = performance.now();
    fn(t);
    if (s.record) {
      s.cb.push(performance.now() - a);
      s.frames.push({ calls: s.calls - c0, tris: s.tris - t0, points: s.points - p0, t });
    }
  });
};

const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const p99 = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * 0.99))] : 0; };

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = { label, device: 'iPhone 13 (Playwright emulation, 390x664 CSS px, DPR 3)', note: 'SwiftShader software rendering: fps is not representative of a real iPhone 13', scenes: {} };

async function measure(page, name, ms, during) {
  await page.evaluate(() => { const s = window.__perfProbe; s.frames = []; s.cb = []; s.record = true; });
  const t0 = Date.now();
  if (during) await during();
  const left = ms - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left);
  const r = await page.evaluate(() => {
    const s = window.__perfProbe; s.record = false;
    const fps = window.__fps;
    return { frames: s.frames, cb: s.cb, fps: fps && typeof fps === 'object' ? fps.report() : fps, info: window.__perf ? window.__perf() : null };
  });
  const f = r.frames.filter((x) => x.calls > 0);
  const dts = r.frames.slice(1).map((x, i) => x.t - r.frames[i].t);
  results.scenes[name] = {
    frames: r.frames.length,
    drawCallsMedian: median(f.map((x) => x.calls)), drawCallsMax: Math.max(0, ...f.map((x) => x.calls)),
    trianglesMedian: Math.round(median(f.map((x) => x.tris))), pointsMedian: median(f.map((x) => x.points)),
    jsMsMedian: +median(r.cb).toFixed(2), jsMsP99: +p99(r.cb).toFixed(2),
    swiftshaderFpsMedian: dts.length ? +(1000 / median(dts)).toFixed(1) : 0,
    pageFps: r.fps, info: r.info,
  };
  console.log(name, JSON.stringify(results.scenes[name]));
}

async function open(query = '') {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(INSTRUMENT);
  await page.goto(`http://127.0.0.1:${port}/${query}`);
  await page.waitForFunction(() => window.__knife && window.__game, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return { ctx, page, errors };
}

// 1) Title screen
{
  const { ctx, page, errors } = await open('?time=dusk');
  await measure(page, 'title', 3000);
  await page.screenshot({ path: `${outDir}/${label}-title-dusk.png` });
  // 2) Free sharpening, idle then grinding (mouse drag emulates the stroke finger; sparks + slurry)
  await page.evaluate(() => window.__knife.startFree());
  await page.waitForTimeout(800);
  await measure(page, 'sharpen-idle', 3000);
  await page.screenshot({ path: `${outDir}/${label}-sharpen-dusk.png` });
  const vp = page.viewportSize();
  await measure(page, 'sharpen-grind', 5000, async () => {
    await page.mouse.move(vp.width * 0.3, vp.height * 0.6);
    await page.mouse.down();
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(vp.width * 0.75, vp.height * 0.6, { steps: 8 });
      await page.mouse.move(vp.width * 0.25, vp.height * 0.6, { steps: 8 });
    }
  });
  await page.screenshot({ path: `${outDir}/${label}-grind-dusk.png` });
  await page.mouse.up();
  results.scenes['sharpen-grind'].errors = errors.slice();
  await ctx.close();
}
// 3) Day palette sharpening screenshot + test cut (iceberg) cinematic
{
  const { ctx, page, errors } = await open('?time=day');
  await page.evaluate(() => window.__knife.startFree());
  await page.waitForTimeout(800);
  await measure(page, 'sharpen-day', 2500);
  await page.screenshot({ path: `${outDir}/${label}-sharpen-day.png` });
  await page.evaluate(() => { window.__knife.setSharpness(1); window.__knife.testCut('iceberg'); });
  await page.waitForFunction(() => window.__knife.phase === 'windup', null, { timeout: 60000 });
  await measure(page, 'cut-iceberg', 3500, async () => {
    await page.waitForFunction(() => ['split', 'result'].includes(window.__knife.phase), null, { timeout: 60000 });
    await page.screenshot({ path: `${outDir}/${label}-cut-split.png` });
  });
  await page.waitForFunction(() => window.__knife.phase === 'result', null, { timeout: 60000 });
  await page.screenshot({ path: `${outDir}/${label}-cut-result.png` });
  results.scenes['cut-iceberg'].errors = errors.slice();
  await ctx.close();
}
writeFileSync(`${outDir}/${label}.json`, JSON.stringify(results, null, 2));
await browser.close();
server.kill();
