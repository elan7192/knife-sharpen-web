// 效能線 (perf-r7): frame-time meter behind window.__fps, the adaptive quality governor,
// one-shot static batching of the scenery, and the ?fps=1 on-screen meter for real-device checks.
// Kept out of main.js so the gameplay / stability branches can edit main.js without conflicts.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Frame-time meter. window.__fps stays usable as a number (valueOf = rolling 60-frame average,
// like before) and adds report(): median fps and the worst-1% fps (1000 / 99th-percentile frame ms)
// over the frames since the last reset() (ring of the newest 3600 frames, about one minute).
// ---------------------------------------------------------------------------
export function createFpsMeter(capacity = 3600) {
  const ring = new Float32Array(capacity); // frame times in ms
  const scratch = new Float32Array(capacity);
  const recent = new Float32Array(60);
  let n = 0, head = 0, ri = 0, rn = 0, rsum = 0, since = performance.now();

  const percentileMs = (count, p) => {
    for (let i = 0; i < count; i++) scratch[i] = ring[(head - count + i + capacity) % capacity];
    const view = scratch.subarray(0, count).sort();
    return view[Math.min(count - 1, Math.floor(count * p))];
  };
  const fps = (ms) => (ms > 0 ? Math.round((1000 / ms) * 10) / 10 : 0);

  const meter = {
    current: 0,
    /** One rendered frame that took dtSec (true frame time, not clamped). */
    push(dtSec) {
      const ms = dtSec * 1000;
      ring[head] = ms;
      head = (head + 1) % capacity;
      n = Math.min(capacity, n + 1);
      rsum += dtSec - recent[ri];
      recent[ri] = dtSec;
      ri = (ri + 1) % recent.length;
      rn = Math.min(recent.length, rn + 1);
      meter.current = rsum > 0 ? Math.round((rn / rsum) * 10) / 10 : 0;
    },
    /** Start a new measurement window (tests call this before the part they want to measure). */
    reset() { n = 0; since = performance.now(); },
    /** { current, median, p1low, worstMs, frames, seconds } over the frames since reset(). */
    report() {
      if (!n) return { current: meter.current, median: 0, p1low: 0, worstMs: 0, frames: 0, seconds: 0 };
      const medMs = percentileMs(n, 0.5);
      const p99Ms = percentileMs(n, 0.99);
      return {
        current: meter.current, median: fps(medMs), p1low: fps(p99Ms), worstMs: Math.round(scratch[n - 1] * 10) / 10,
        frames: n, seconds: Math.round((performance.now() - since) / 100) / 10,
      };
    },
    valueOf() { return meter.current; },
    toString() { return String(meter.current); },
    toJSON() { return meter.report(); },
  };
  return meter;
}

// ---------------------------------------------------------------------------
// Adaptive quality. Levels run low -> high; the app's apply(level) does the actual work.
// Every 2 s window of steady frames (no warm-up, no cinematic, tab visible) is judged:
//   - median < 50 fps, or worst-1% < 28 fps in two windows in a row (or median < 40 once) -> one level down,
//     and that level is never probed again this session (no oscillation);
//   - median >= 58 and worst-1% >= 45 for three windows in a row -> probe one level up (if allowed).
// iOS Safari has no GPU timer queries, so probing up and falling back is the only way to find headroom.
// With storageKey, the level this device settled on last time is where the next session starts (a slow phone
// doesn't stutter through the same downgrades on every visit; probing up is still allowed).
// ---------------------------------------------------------------------------
const load = (key) => { try { const v = Number(localStorage.getItem(key)); return Number.isInteger(v) && localStorage.getItem(key) !== null ? v : null; } catch { return null; } };
const save = (key, v) => { try { localStorage.setItem(key, String(v)); } catch { /* private mode: fine */ } };

export function createQualityGovernor({ levels, start, max = levels.length - 1, pinned = null, apply, canChange, storageKey = null }) {
  if (pinned === null && storageKey) {
    const stored = load(storageKey);
    if (stored !== null && stored >= 0 && stored <= max) start = stored;
  }
  const WINDOW = 120, WARMUP = 90;
  const win = new Float32Array(WINDOW);
  const sorted = new Float32Array(WINDOW);
  let wn = 0, warm = WARMUP, good = 0, bad = 0, cap = max, frameNo = 0;
  const log = [];
  const gov = {
    index: pinned ?? start,
    get level() { return levels[gov.index]; },
    get frame() { return frameNo; },
    auto: pinned === null,
    /** Called once per rendered frame with the true frame time in seconds. */
    sample(dtSec) {
      frameNo++;
      if (!gov.auto) return;
      if (!canChange()) { wn = 0; warm = Math.max(warm, 30); return; }
      if (warm > 0) { warm--; return; }
      win[wn++] = dtSec * 1000;
      if (wn < WINDOW) return;
      wn = 0;
      sorted.set(win);
      sorted.sort();
      const med = 1000 / sorted[WINDOW >> 1];
      const low = 1000 / sorted[WINDOW - 2]; // 2nd worst of 120 = worst ~1%
      if (med < 50 || low < 28) {
        good = 0;
        bad++;
        if ((bad >= 2 || med < 40) && gov.index > 0) {
          cap = gov.index - 1;
          gov.set(gov.index - 1, `down: median ${med.toFixed(1)} / 1% ${low.toFixed(1)} fps`);
        }
      } else {
        bad = 0;
        if (med >= 58 && low >= 45 && ++good >= 3 && gov.index < cap) gov.set(gov.index + 1, `probe up: median ${med.toFixed(1)} / 1% ${low.toFixed(1)} fps`);
      }
    },
    set(i, why = 'manual') {
      i = THREE.MathUtils.clamp(i, 0, levels.length - 1);
      if (i !== gov.index) log.push({ t: Math.round(performance.now()), from: gov.index, to: i, why });
      gov.index = i;
      if (gov.auto && storageKey) save(storageKey, i);
      good = bad = wn = 0;
      warm = WARMUP; // new render targets / resolution: let it settle before judging
      apply(levels[i], i);
    },
    /** Pause judging for a while (tab came back, resize, rotation). */
    settle() { wn = 0; warm = WARMUP; },
    state() { return { index: gov.index, name: levels[gov.index].name, auto: gov.auto, cap, level: { ...levels[gov.index] }, log: log.slice() }; },
  };
  return gov;
}

// ---------------------------------------------------------------------------
// Static batching: after the world is built, every visible opaque mesh that never moves is baked
// into world space and merged per (material, shadow flags, render order). Purely a draw-call cut:
// same materials, same triangles, same shading. Anything under a `keep` root stays untouched.
// ---------------------------------------------------------------------------
export function batchStatic(scene, keep) {
  scene.updateMatrixWorld(true);
  const buckets = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || Array.isArray(o.material) || o.material.transparent || o.morphTargetInfluences) return;
    for (let p = o; p; p = p.parent) if (keep.has(p) || !p.visible) return;
    const key = `${o.material.uuid}|${o.castShadow}|${o.receiveShadow}|${o.renderOrder}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  });
  let before = 0, after = 0;
  for (const list of buckets.values()) {
    before += list.length;
    if (list.length < 2) { after += list.length; continue; }
    const m0 = list[0];
    const needsUv = !!(m0.material.map || m0.material.emissiveMap || m0.material.normalMap || m0.material.roughnessMap);
    const allUv = list.every((o) => o.geometry.attributes.uv);
    const allColor = list.every((o) => o.geometry.attributes.color);
    if ((needsUv && !allUv) || (m0.material.vertexColors && !allColor)) { after += list.length; continue; }
    const names = ['position', 'normal', ...(allUv ? ['uv'] : []), ...(allColor ? ['color'] : [])];
    const geos = list.map((o) => {
      const src = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      if (!src.attributes.normal) src.computeVertexNormals();
      const g = new THREE.BufferGeometry();
      for (const name of names) g.setAttribute(name, src.attributes[name]);
      src.dispose();
      return g.applyMatrix4(o.matrixWorld);
    });
    const geo = mergeGeometries(geos);
    geos.forEach((g) => g.dispose());
    if (!geo) { after += list.length; continue; }
    const batch = new THREE.Mesh(geo, m0.material);
    batch.castShadow = m0.castShadow;
    batch.receiveShadow = m0.receiveShadow;
    batch.renderOrder = m0.renderOrder;
    batch.name = `static:${m0.material.type}`;
    batch.matrixAutoUpdate = false; // world-space already
    scene.add(batch);
    for (const o of list) {
      o.removeFromParent();
      o.geometry.dispose();
    }
    after++;
  }
  return { meshesBefore: before, meshesAfter: after };
}

// ---------------------------------------------------------------------------
// ?fps=1: a tiny on-screen meter, so the numbers can be read on a real iPhone (no devtools needed).
// ---------------------------------------------------------------------------
export function createFpsOverlay(meter, governor, info) {
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, { // one line along the bottom edge, clear of the buttons
    position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: 'calc(env(safe-area-inset-bottom) + 2px)',
    zIndex: 60, pointerEvents: 'none', font: '10px/1.3 ui-monospace, Menlo, monospace', color: '#F7F7F2',
    background: 'rgba(11,13,18,0.66)', padding: '2px 6px', borderRadius: '5px', whiteSpace: 'pre',
  });
  document.body.appendChild(el);
  let next = 0; // the meter's ring keeps the newest ~60 s, so the overlay is a rolling window
  return {
    update(now) {
      if (now < next) return;
      next = now + 500;
      const r = meter.report();
      const q = governor.level, i = info();
      el.textContent = `${r.current.toFixed(0)}fps 中位${r.median.toFixed(0)} 1%低${r.p1low.toFixed(0)} · 畫質${q.name}${governor.auto ? '' : '固定'}×${q.dpr} 影${q.shadow} 呼叫${i.calls}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Lowest level only: iOS Safari re-blurs every backdrop-filter panel each frame the canvas under it changes.
// The panels are already ~80% opaque, so dropping the blur is nearly invisible and frees GPU compositing time.
// ---------------------------------------------------------------------------
let lowFxStyle = null;
export function setLowFx(on) {
  if (on && !lowFxStyle) {
    lowFxStyle = document.createElement('style');
    lowFxStyle.textContent = 'body.q-low .card{-webkit-backdrop-filter:none;backdrop-filter:none}';
    document.head.appendChild(lowFxStyle);
  }
  document.body.classList.toggle('q-low', on);
}
