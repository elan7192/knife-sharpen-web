// Shared test harness: static server for the repo, Chromium with the iPhone 13 profile,
// three.js served from a local cache (fetched once with curl), console / page errors collected.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tests', '.cache');

function loadPlaywright() {
  for (const id of ['playwright', '@playwright/test', '/opt/node-tools/node_modules/playwright']) {
    try { return require(id); } catch (_) { /* try the next one */ }
  }
  throw new Error('Playwright not found: npm i -D playwright (or use the preinstalled one)');
}
export const pw = loadPlaywright();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
export function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/` })));
}

/** unpkg (three.js 0.170) from tests/.cache; downloaded with curl (which trusts the proxy CA) on first use. */
async function routeThree(context) {
  await context.route(/^https:\/\/unpkg\.com\/three@/, async (route) => {
    const url = new URL(route.request().url());
    const file = path.join(CACHE, url.pathname.replace(/[^\w./@-]/g, '_'));
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        execFileSync('curl', ['-sSfL', '--max-time', '60', '-o', file, url.href]);
      }
      await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(file) });
    } catch (e) {
      await route.continue();
    }
  });
}

export async function launch() {
  return pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}

/** New iPhone 13 page (portrait unless landscape) with error capture and optional init script. */
export async function newPhone(browser, { landscape = false, init, storage } = {}) {
  const device = pw.devices[landscape ? 'iPhone 13 landscape' : 'iPhone 13'];
  const context = await browser.newContext({ ...device, serviceWorkers: 'block' });
  await routeThree(context);
  if (storage) await context.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  return { context, page, errors };
}

export async function boot(page, base, query = '') {
  await page.goto(`${base}index.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__knife && window.__knife.lifecycle.frames > 2, null, { timeout: 60000 });
}

/** Tap an element by id with a real touch at its centre (fails if it is hidden or off-screen). */
export async function tap(page, id) {
  const el = page.locator(`#${id}`);
  await el.waitFor({ state: 'visible', timeout: 20000 });
  const box = await el.boundingBox();
  const vp = page.viewportSize();
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > vp.width + 1 || box.y + box.height > vp.height + 1) {
    throw new Error(`#${id} is outside the viewport: ${JSON.stringify(box)} in ${vp.width}x${vp.height}`);
  }
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

export const waitFor = (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });

// Tiny assertion runner: every check is recorded; the process exits non-zero if any failed.
export function suite(name) {
  const results = [];
  return {
    results,
    ok(cond, label, detail) {
      results.push({ ok: !!cond, label, detail });
      console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail !== undefined && !cond ? `  → ${JSON.stringify(detail)}` : ''}`);
    },
    async step(label, fn) {
      console.log(`\n[${name}] ${label}`);
      try { await fn(); } catch (e) { this.ok(false, `${label}: threw`, String(e && e.stack || e).slice(0, 600)); }
    },
  };
}
