// Round 7 stability flow test, headless iPhone 13 (Playwright device profile, touch, DPR 3).
//   node tests/stability.iphone13.mjs            (needs Chromium + Playwright; three.js is cached in tests/.cache)
// Screenshots and the share PNG go to tests/artifacts/. Software rendering (SwiftShader) runs at
// ~3 fps, so waits are generous; the fps numbers here say nothing about a real iPhone.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, serve, launch, newPhone, boot, tap, waitFor, suite } from './harness.mjs';

const OUT = path.join(ROOT, 'tests', 'artifacts');
fs.mkdirSync(OUT, { recursive: true });
const T = suite('stability');
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

// navigator.share mock: records whether it was called inside the tap's click dispatch (the iOS rule)
const SHARE_MOCK = () => {
  window.__shareCalls = [];
  window.__shareMode = 'ok';
  window.__inClick = false;
  window.addEventListener('click', () => { window.__inClick = true; }, true);
  window.addEventListener('click', () => { window.__inClick = false; }, false);
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d) => !!(d && d.files && d.files.length) });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: (d) => {
      const f = d.files && d.files[0];
      window.__shareCalls.push({ inClick: window.__inClick, active: navigator.userActivation ? navigator.userActivation.isActive : null, type: f && f.type, size: f && f.size, name: f && f.name, text: d.text });
      const m = window.__shareMode;
      if (m === 'ok') return Promise.resolve();
      return Promise.reject(new DOMException(m, m === 'abort' ? 'AbortError' : 'NotAllowedError'));
    },
  });
};
const setHidden = (page, hidden) => page.evaluate((h) => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
const noScroll = (page) => page.evaluate(() => {
  const se = document.scrollingElement;
  return se.scrollTop === 0 && se.scrollLeft === 0 && se.scrollHeight <= innerHeight + 1 && se.scrollWidth <= innerWidth + 1;
});
async function touchDrag(page, cdp, moves = 10) {
  const vp = page.viewportSize();
  const y = vp.height * 0.55;
  let x = vp.width * 0.3;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 0; i < moves; i++) {
    x += (i % 4 < 2 ? 1 : -1) * vp.width * 0.18;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 2 }] });
    await page.waitForTimeout(300);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const cutDone = (page) => waitFor(page, () => __knife.flow().screen === 'result' && __knife.mode === 'result', null, 240000);

const { server, base } = await serve();
const browser = await launch();
const t0 = Date.now();

// ---------------------------------------------------------------------------
// A. Portrait iPhone 13: settings, an order with real touches, share, save, lifecycle, recovery
// ---------------------------------------------------------------------------
{
  const { context, page, errors } = await newPhone(browser, { init: SHARE_MOCK });
  const cdp = await context.newCDPSession(page);

  await T.step('boot on the title screen', async () => {
    await boot(page, base);
    const s = await page.evaluate(() => ({ screen: __knife.flow().screen, save: __knife.save.status, illegal: __knife.fsm.illegal }));
    T.ok(s.screen === 'title', 'opens on the title', s);
    T.ok(s.save === 'fresh', 'fresh save on first visit', s);
    T.ok(await noScroll(page), 'page does not scroll');
    await shot(page, 'a1-title-portrait');
  });

  await T.step('settings toggles persist across reloads', async () => {
    await tap(page, 'hapticBtn');
    await tap(page, 'soundBtn');
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: 'load' });
    await waitFor(page, () => window.__knife && __knife.lifecycle.frames > 2);
    const s = await page.evaluate(() => ({ h: document.getElementById('hapticBtn').textContent, s: document.getElementById('soundBtn').textContent, data: __knife.save.data.settings, muted: __knife.lifecycle.muted }));
    T.ok(s.h === '震動：關' && s.s === '音效：關' && s.muted === true, 'haptics + sound off after reload', s);
    await tap(page, 'hapticBtn');
    await tap(page, 'soundBtn');
  });

  await T.step('order: title → order card → sharpen (real taps) → grind (real touch drag)', async () => {
    await tap(page, 'startBtn');
    await waitFor(page, () => __knife.flow().screen === 'order');
    await shot(page, 'a2-order-card');
    await tap(page, 'acceptBtn');
    await waitFor(page, () => __knife.flow().screen === 'sharpen' && __knife.mode === 'sharpen');
    await touchDrag(page, cdp, 10);
    const st = await page.evaluate(() => __knife.flow().stats);
    T.ok(st.dist > 0 && st.strokes >= 1, 'touch drag grinds the edge', st);
    T.ok(await noScroll(page), 'no scroll while grinding');
  });

  await T.step('order cut → result card, score, legal transitions only', async () => {
    await page.evaluate(() => __knife.setSharpness(0.4));
    await tap(page, 'testBtn');
    // Hide the tab during the cinematic: everything must stop and then carry on.
    await waitFor(page, () => ['windup', 'slash', 'freeze', 'split'].includes(__knife.phase));
    await setHidden(page, true);
    const p1 = await page.evaluate(() => ({ ...__knife.lifecycle, phase: __knife.phase }));
    await page.waitForTimeout(1500);
    const p2 = await page.evaluate(() => ({ ...__knife.lifecycle, phase: __knife.phase }));
    T.ok(p1.paused && p1.reason === 'hidden', 'hidden tab pauses the game', p1);
    T.ok(p2.frames === p1.frames && p2.phase === p1.phase, 'no frames and no cinematic progress while hidden', { p1: p1.frames, p2: p2.frames });
    T.ok(p1.audio === 'none' || p1.audio === 'suspended', 'audio suspended while hidden', p1.audio);
    await setHidden(page, false);
    await waitFor(page, () => !__knife.lifecycle.paused && __knife.lifecycle.frames > 0);
    await cutDone(page);
    const f = await page.evaluate(() => ({ flow: __knife.flow(), fsm: __knife.fsm, life: __knife.lifecycle }));
    T.ok(f.flow.success === true && typeof f.flow.score === 'number' && /^[SABC]$/.test(f.flow.rank), 'order succeeds with a score + rank', f.flow);
    T.ok(f.life.resumes >= 1 && f.life.frames > p2.frames, 'loop resumed after the tab came back', f.life);
    T.ok(f.fsm.illegal === 0, 'no illegal screen transitions', f.fsm.history);
    const seq = f.fsm.history.map((h) => h.to).join('>');
    T.ok(/title>order>sharpen>cut>result$/.test(seq), 'screen sequence title>order>sharpen>cut>result', seq);
    await shot(page, 'a3-order-result');
  });

  await T.step('share: pre-built PNG, navigator.share called inside the tap', async () => {
    await waitFor(page, () => __knife.share.ready, null, 60000);
    await tap(page, 'shareBtn');
    await waitFor(page, () => __knife.share.last && __knife.share.last.result !== 'pending');
    const r = await page.evaluate(() => ({ calls: window.__shareCalls, share: __knife.share }));
    const c = r.calls[0] || {};
    T.ok(r.calls.length === 1 && c.inClick === true, 'navigator.share called synchronously in the click', r.calls);
    T.ok(c.type === 'image/png' && c.size > 20000 && c.name === 'knife-score.png', 'shares a PNG file', c);
    T.ok(r.share.last.prebuilt === true && r.share.last.result === 'shared', 'used the pre-built image', r.share);
    // Tap faster than the encode: synchronous toDataURL path, still inside the click.
    await page.evaluate(() => __knife.debug.dropShareCache());
    await tap(page, 'shareBtn');
    await waitFor(page, () => window.__shareCalls.length === 2 && __knife.share.last.result !== 'pending');
    const r2 = await page.evaluate(() => ({ c: window.__shareCalls[1], last: __knife.share.last }));
    T.ok(r2.c.inClick === true && r2.last.prebuilt === false && r2.c.size > 20000, 'sync fallback path also shares inside the click', r2);
    // User closes the sheet: nothing else happens.
    await page.evaluate(() => { window.__shareMode = 'abort'; });
    await tap(page, 'shareBtn');
    await waitFor(page, () => __knife.share.last.result !== 'pending');
    const r3 = await page.evaluate(() => ({ last: __knife.share.last, preview: document.getElementById('sharePreview').classList.contains('show') }));
    T.ok(r3.last.result === 'cancelled' && !r3.preview, 'AbortError: no fallback', r3);
    // Share refused (NotAllowedError): preview sheet with the image + save link.
    await page.evaluate(() => { window.__shareMode = 'deny'; });
    await tap(page, 'shareBtn');
    await waitFor(page, () => document.getElementById('sharePreview').classList.contains('show'));
    await waitFor(page, () => document.getElementById('shareImg').naturalWidth > 0);
    const r4 = await page.evaluate(() => ({ last: __knife.share.last, w: document.getElementById('shareImg').naturalWidth, h: document.getElementById('shareImg').naturalHeight, href: document.getElementById('shareSave').href }));
    T.ok(r4.last.result === 'fallback' && r4.last.error === 'NotAllowedError', 'non-AbortError falls back', r4.last);
    T.ok(r4.w === 1080 && r4.h === 1350 && r4.href.startsWith('blob:'), 'preview shows the 1080×1350 card with a download link', r4);
    await shot(page, 'a4-share-preview');
    await tap(page, 'shareClose');
    const png = await page.evaluate(async () => {
      const b = await __knife.shareBlob();
      const buf = new Uint8Array(await b.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    });
    fs.writeFileSync(path.join(OUT, 'share-card.png'), Buffer.from(png, 'base64'));
  });

  await T.step('progress survives a reload', async () => {
    await page.reload({ waitUntil: 'load' });
    await waitFor(page, () => window.__knife && __knife.lifecycle.frames > 2);
    const s = await page.evaluate(() => ({ flow: __knife.flow(), rec: __knife.save.data.records, start: document.getElementById('startBtn').textContent, record: document.getElementById('titleRecord').textContent }));
    T.ok(s.flow.completed === 1, 'completed orders restored', s.flow.completed);
    T.ok(s.rec.bestScore != null && s.rec.cuts.paper >= 1, 'records restored', s.rec);
    T.ok(s.start === '繼續・第 2 件' && s.record.includes('已完成 1 件委託'), 'title shows the progress', s);
    await shot(page, 'a5-title-with-record');
  });

  await T.step('free mode: unlocks and the edge persist; order mode does not overwrite them', async () => {
    await tap(page, 'freeBtn');
    await page.evaluate(() => __knife.setSharpness(0.6));
    await page.evaluate(() => __knife.saveNow());
    await page.evaluate(() => { __knife.title(); __knife.startOrder(); __knife.acceptOrder(); });
    const inOrder = await page.evaluate(() => __knife.sharpness);
    await page.evaluate(() => { __knife.title(); });
    await page.reload({ waitUntil: 'load' });
    await waitFor(page, () => window.__knife && __knife.lifecycle.frames > 2);
    await tap(page, 'freeBtn');
    const s = await page.evaluate(() => ({ sharp: __knife.sharpness, unlocked: __knife.unlocked }));
    T.ok(inOrder < 0.1, 'an order starts from a dull edge', inOrder);
    T.ok(Math.abs(s.sharp - 0.6) < 0.01 && s.unlocked.includes('iron'), 'free-mode edge + unlocks back after reload', s);
  });

  await T.step('errors: a throwing frame and a broken cut both recover', async () => {
    const f0 = await page.evaluate(() => __knife.lifecycle.frames);
    await page.evaluate(() => __knife.debug.throwInFrame());
    await waitFor(page, (n) => __knife.lifecycle.frames > n + 3, f0);
    const a = await page.evaluate(() => ({ life: __knife.lifecycle, issues: __knife.issues }));
    T.ok(a.life.frameErrors === 1 && a.issues.some((i) => i.kind === 'frame'), 'frame error caught, loop keeps running', a);
    await tap(page, 'testBtn');
    await waitFor(page, () => ['enter', 'windup'].includes(__knife.phase));
    await page.evaluate(() => __knife.debug.breakNextTween());
    await waitFor(page, () => __knife.lifecycle.recoveries === 1);
    const b = await page.evaluate(() => ({ flow: __knife.flow().screen, mode: __knife.mode, phase: __knife.phase, bars: __knife.letterbox.amount, btn: document.getElementById('testBtn').disabled, cine: document.body.classList.contains('cine'), issues: __knife.issues.map((i) => i.kind), illegal: __knife.fsm.illegal }));
    T.ok(b.flow === 'sharpen' && b.mode === 'sharpen' && b.phase === 'idle' && b.bars === 0 && !b.btn && !b.cine, 'broken cut → back on the sharpening screen', b);
    T.ok(b.issues.includes('cut') && b.illegal === 0, 'recorded as a recovered issue, transitions still legal', b);
    await shot(page, 'a6-recovered');
    // And the game is still playable: a full cut works afterwards.
    await tap(page, 'testBtn');
    await cutDone(page);
    T.ok(await page.evaluate(() => __knife.lastResult && __knife.lastResult.success), 'next cut after recovery succeeds');
    await tap(page, 'againBtn');
    await waitFor(page, () => __knife.mode === 'sharpen');
  });

  await T.step('WebGL context lost → overlay + pause; restored → resumes', async () => {
    const ok = await page.evaluate(() => __knife.debug.loseContext());
    T.ok(ok, 'WEBGL_lose_context available');
    await waitFor(page, () => __knife.lifecycle.glLost);
    const a = await page.evaluate(() => ({ life: __knife.lifecycle, overlay: document.getElementById('glLost').classList.contains('show') }));
    T.ok(a.life.paused && a.overlay, 'paused with the overlay shown', a);
    await shot(page, 'a7-context-lost');
    const f0 = a.life.frames;
    await page.evaluate(() => __knife.debug.restoreContext());
    await waitFor(page, (n) => !__knife.lifecycle.glLost && __knife.lifecycle.frames > n + 3, f0);
    const b = await page.evaluate(() => ({ overlay: document.getElementById('glLost').classList.contains('show'), env: true }));
    T.ok(!b.overlay, 'overlay hidden after restore, loop running');
    await page.waitForTimeout(500);
    await shot(page, 'a8-context-restored');
  });

  await T.step('unfinished order resumes after a reload (iOS kills background tabs)', async () => {
    await page.evaluate(() => { __knife.title(); __knife.startOrder(); __knife.acceptOrder(); __knife.setSharpness(0.27); __knife.saveNow(); });
    await page.reload({ waitUntil: 'load' });
    await waitFor(page, () => window.__knife && __knife.lifecycle.frames > 2);
    const rec = await page.evaluate(() => document.getElementById('titleRecord').textContent);
    T.ok(rec.includes('有一件委託磨到一半'), 'title mentions the unfinished order', rec);
    await tap(page, 'startBtn');
    await waitFor(page, () => __knife.flow().screen === 'order');
    const card = await page.evaluate(() => ({ btn: document.getElementById('acceptBtn').textContent, t: document.getElementById('orderTarget').textContent }));
    T.ok(card.btn === '接著磨' && card.t.includes('上次磨到 27%'), 'order card offers to continue', card);
    await shot(page, 'a9-order-resume');
    await tap(page, 'acceptBtn');
    const s = await page.evaluate(() => ({ sharp: __knife.sharpness, no: __knife.flow().order.no }));
    T.ok(Math.abs(s.sharp - 0.27) < 0.01 && s.no === 2, 'same order, same edge', s);
  });

  T.ok(errors.length === 0, 'portrait: no page errors / console errors', errors);
  await context.close();
}

// ---------------------------------------------------------------------------
// B. Rotation during the cinematic, landscape result card, pagehide/pageshow
// ---------------------------------------------------------------------------
{
  const { context, page, errors } = await newPhone(browser, { init: SHARE_MOCK });
  await T.step('rotate portrait → landscape mid-cut', async () => {
    await boot(page, base, '?fresh=1');
    await tap(page, 'freeBtn');
    await page.evaluate(() => __knife.setSharpness(0.95));
    await page.evaluate(() => { __knife.testCut('iceberg'); }); // don't await the whole cinematic
    await waitFor(page, () => ['slash', 'freeze', 'split'].includes(__knife.phase));
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await cutDone(page);
    await page.waitForTimeout(1200);
    const s = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const card = document.querySelector('#result .card').getBoundingClientRect();
      const btns = [...document.querySelectorAll('#result .row button:not(.hidden)')].map((b) => b.getBoundingClientRect());
      return { lb: __knife.letterbox, cw: c.clientWidth, ch: c.clientHeight, iw: innerWidth, ih: innerHeight, card: { top: card.top, bottom: card.bottom }, btnsOk: btns.every((r) => r.height >= 44 && r.bottom <= innerHeight && r.top >= 0) };
    });
    T.ok(Math.abs(s.lb.visibleAspect - 2.39) < 0.02, 'letterbox still 2.39:1 after rotating', s.lb);
    T.ok(s.cw === s.iw && s.ch === s.ih, 'canvas follows the new viewport', s);
    T.ok(s.card.top >= 0 && s.card.bottom <= s.ih + 0.5 && s.btnsOk, 'landscape result card fits, buttons ≥44px on screen', s);
    T.ok(await noScroll(page), 'no page scroll after rotating');
    await shot(page, 'b1-landscape-result');
    await tap(page, 'againBtn');
    await waitFor(page, () => __knife.mode === 'sharpen');
    await page.setViewportSize({ width: 390, height: 664 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await page.waitForTimeout(1500);
    const p = await page.evaluate(() => ({ cw: document.querySelector('canvas').clientWidth, iw: innerWidth, illegal: __knife.fsm.illegal }));
    T.ok(p.cw === p.iw && p.illegal === 0, 'back to portrait, still consistent', p);
    await shot(page, 'b2-portrait-again');
  });

  await T.step('pagehide / pageshow (bfcache) pause and resume', async () => {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    const a = await page.evaluate(() => __knife.lifecycle);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForTimeout(800);
    const b = await page.evaluate(() => __knife.lifecycle);
    T.ok(a.paused && a.reason === 'pagehide' && !b.paused && b.frames > a.frames, 'pagehide pauses, pageshow resumes', { a, b });
    T.ok(await page.evaluate(() => __knife.save.status) === 'unavailable', '?fresh=1 leaves storage alone');
  });
  T.ok(errors.length === 0, 'rotation: no page errors / console errors', errors);
  await context.close();
}

// ---------------------------------------------------------------------------
// C. Landscape iPhone 13 order result card (the tallest card) fits
// ---------------------------------------------------------------------------
{
  const { context, page, errors } = await newPhone(browser, { landscape: true, init: SHARE_MOCK });
  await T.step('landscape order result', async () => {
    await boot(page, base);
    await tap(page, 'startBtn');
    await waitFor(page, () => __knife.flow().screen === 'order');
    await shot(page, 'c1-landscape-order');
    await tap(page, 'acceptBtn');
    await page.evaluate(() => __knife.setSharpness(0.3));
    await tap(page, 'testBtn');
    await cutDone(page);
    await page.waitForTimeout(800);
    const s = await page.evaluate(() => {
      const card = document.querySelector('#result .card');
      const r = card.getBoundingClientRect();
      const btns = [...document.querySelectorAll('#result .row button:not(.hidden)')];
      return { top: r.top, bottom: r.bottom, ih: innerHeight, scroll: card.scrollHeight > card.clientHeight, btns: btns.map((b) => b.id) };
    });
    T.ok(s.top >= 0 && s.bottom <= s.ih + 0.5, 'order result card inside the 342 px high viewport (scrolls inside if needed)', s);
    await shot(page, 'c2-landscape-order-result');
    await page.locator('#shareBtn').scrollIntoViewIfNeeded();
    await tap(page, 'shareBtn');
    await waitFor(page, () => window.__shareCalls.length === 1);
    T.ok(await page.evaluate(() => window.__shareCalls[0].inClick), 'share from the landscape card is inside the click');
  });
  T.ok(errors.length === 0, 'landscape: no page errors / console errors', errors);
  await context.close();
}

// ---------------------------------------------------------------------------
// D. Bad storage: corrupt record, round-6 key migration, storage that throws
// ---------------------------------------------------------------------------
{
  const { context, page, errors } = await newPhone(browser, { storage: { 'knife.save': '{"v":1,"progress":{"completed":', 'knife.haptics': '0' } });
  await T.step('corrupt save + old haptics key', async () => {
    await boot(page, base);
    const s = await page.evaluate(() => ({ status: __knife.save.status, corrupt: localStorage.getItem('knife.save.corrupt'), old: localStorage.getItem('knife.haptics'), haptic: document.getElementById('hapticBtn').textContent, reset: !document.getElementById('resetBtn').classList.contains('hidden'), flow: __knife.flow().completed }));
    T.ok(s.status === 'recovered' && s.corrupt && s.corrupt.startsWith('{"v":1'), 'corrupt record kept aside, game starts fresh', s);
    T.ok(s.old === null && s.haptic === '震動：關', 'round-6 knife.haptics migrated', s);
    T.ok(s.reset && s.flow === 0, 'reset button offered on the title', s);
    // Two-tap reset
    await tap(page, 'resetBtn');
    const armed = await page.evaluate(() => document.getElementById('resetBtn').textContent);
    await tap(page, 'resetBtn');
    const after = await page.evaluate(() => ({ text: document.getElementById('resetBtn').textContent, rec: __knife.save.data.records.bestScore, h: __knife.save.data.settings.haptics }));
    T.ok(armed === '再點一次確認清除' && after.text === '清除紀錄' && after.h === false, 'two-tap reset keeps settings', { armed, after });
  });
  T.ok(errors.length === 0, 'bad storage: no page errors / console errors', errors);
  await context.close();
}
{
  const { context, page, errors } = await newPhone(browser, {
    init: () => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } }),
  });
  await T.step('localStorage throws (locked-down Safari / iframe)', async () => {
    await boot(page, base);
    await tap(page, 'startBtn');
    await tap(page, 'acceptBtn');
    const s = await page.evaluate(() => ({ status: __knife.save.status, screen: __knife.flow().screen, saved: __knife.saveNow() }));
    T.ok(s.status === 'unavailable' && s.screen === 'sharpen', 'game still playable without storage', s);
  });
  T.ok(errors.length === 0, 'no storage: no page errors / console errors', errors);
  await context.close();
}

await browser.close();
server.close();
const failed = T.results.filter((r) => !r.ok);
const summary = { passed: T.results.length - failed.length, failed: failed.length, seconds: Math.round((Date.now() - t0) / 1000) };
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ summary, results: T.results }, null, 2));
console.log(`\n${failed.length ? 'FAIL' : 'PASS'} ${summary.passed}/${T.results.length} checks in ${summary.seconds} s`);
process.exit(failed.length ? 1 : 0);
