// ---------------------------------------------------------------------------
// Stability helpers (no three.js, no DOM state of their own) used by main.js:
//   - flow state machine: the legal screen transitions and a short history for tests
//   - save store: one versioned localStorage record (progress, unlocks, settings) that
//     survives private mode, quota errors and corrupt JSON
//   - share hand-off: navigator.share() must be the first async step inside the tap
//     (iOS Safari drops the user gesture after any await), with a download fallback
// ---------------------------------------------------------------------------

// Screens: title -> order -> sharpen -> cut -> result. Self-transitions are always allowed.
// 素材工房 (integrate-r8): title -> lab -> sharpen <-> measure (the sharpness tester), result -> lab.
export const FLOW_EDGES = {
  title: ['order', 'sharpen', 'lab'],
  order: ['title', 'sharpen', 'lab'],
  lab: ['title', 'sharpen', 'order'],
  sharpen: ['title', 'order', 'cut', 'lab', 'measure'],
  measure: ['sharpen'],
  cut: ['result', 'sharpen'], // cut -> sharpen only when a broken cinematic is recovered
  result: ['sharpen', 'cut', 'order', 'title', 'lab'],
};

export function createFlowMachine(initial, onIllegal) {
  const history = [{ from: null, to: initial, why: 'boot', t: 0 }];
  let illegal = 0;
  return {
    get illegal() { return illegal; },
    get history() { return history.slice(); },
    /** Record from -> to; returns false (and reports) when the edge is not in FLOW_EDGES. */
    check(from, to, why = '') {
      if (from === to) return true;
      const ok = !!FLOW_EDGES[from] && FLOW_EDGES[from].includes(to);
      history.push({ from, to, why, t: Math.round(performance.now()), ok });
      if (history.length > 40) history.splice(1, history.length - 40);
      if (!ok) {
        illegal++;
        onIllegal?.(from, to, why);
      }
      return ok;
    },
  };
}

// ---------------------------------------------------------------------------
// Save store
// ---------------------------------------------------------------------------
export const SAVE_KEY = 'knife.save';
export const SAVE_VERSION = 1;
const RANKS = ['S', 'A', 'B', 'C'];

export function defaultSave() {
  return {
    v: SAVE_VERSION,
    savedAt: 0,
    settings: { haptics: true, sound: true },
    progress: {
      completed: 0, // successful orders (sets the next order's difficulty)
      best: -1, // free mode: best target index cut so far
      unlocked: 0, // free mode: highest unlocked target index (sticky)
      knife: null, // free-mode edge: { segs: number[], stone }
      order: null, // unfinished order: { no, segs, stone, stats } (resumed after a reload / tab kill)
      wear: {}, // stone id -> wear profile (number[])
    },
    records: { bestScore: null, bestRank: null, ranks: { S: 0, A: 0, B: 0, C: 0 }, cuts: {} },
    unlocks: {}, // id -> true; open slot for unlockable content (material knives, stones, ...)
  };
}

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const int = (v, lo, hi, d) => {
  const n = num(v, lo, hi, null);
  return n == null ? d : Math.round(n);
};
const numArr = (a, len, lo, hi) =>
  Array.isArray(a) && (len == null || a.length === len) && a.every((x) => typeof x === 'number' && Number.isFinite(x))
    ? a.map((x) => Math.min(hi, Math.max(lo, x)))
    : null;

/**
 * Accept anything (old versions, hand-edited JSON, garbage) and return a valid save.
 * shape: { segs, targets, stones: [{ id, cols }] } bounds the arrays to the current game.
 */
export function sanitizeSave(raw, shape = {}) {
  const s = defaultSave();
  if (!raw || typeof raw !== 'object') return s;
  const segs = shape.segs ?? 10;
  const lastTarget = Math.max(0, (shape.targets ?? 5) - 1);
  const stones = shape.stones ?? [];
  s.savedAt = num(raw.savedAt, 0, 8.64e15, 0);
  const st = raw.settings || {};
  if (typeof st.haptics === 'boolean') s.settings.haptics = st.haptics;
  if (typeof st.sound === 'boolean') s.settings.sound = st.sound;
  const p = raw.progress || {};
  s.progress.completed = int(p.completed, 0, 1e6, 0);
  s.progress.best = int(p.best, -1, lastTarget, -1);
  s.progress.unlocked = int(p.unlocked, 0, lastTarget, 0);
  if (p.knife && typeof p.knife === 'object') {
    const k = numArr(p.knife.segs, segs, 0, 1);
    if (k) s.progress.knife = { segs: k, stone: int(p.knife.stone, 0, Math.max(0, stones.length - 1), 0) };
  }
  if (p.order && typeof p.order === 'object') {
    const k = numArr(p.order.segs, segs, 0, 1);
    const st0 = p.order.stats || {};
    if (k && Number.isInteger(p.order.no) && p.order.no >= 1) {
      s.progress.order = {
        no: p.order.no, segs: k, stone: int(p.order.stone, 0, Math.max(0, stones.length - 1), 0),
        stats: {
          dist: num(st0.dist, 0, 1e6, 0), angleDist: num(st0.angleDist, 0, 1e6, 0), pressDist: num(st0.pressDist, 0, 1e6, 0),
          strokes: int(st0.strokes, 0, 1e7, 0), goalDist: num(st0.goalDist, -1, 1e6, -1),
        },
      };
    }
  }
  if (p.wear && typeof p.wear === 'object') {
    for (const { id, cols } of stones) {
      const w = numArr(p.wear[id], cols, 0, 1);
      if (w) s.progress.wear[id] = w;
    }
  }
  const r = raw.records || {};
  if (r.bestScore != null) s.records.bestScore = int(r.bestScore, 0, 100, null);
  if (RANKS.includes(r.bestRank)) s.records.bestRank = r.bestRank;
  for (const k of RANKS) s.records.ranks[k] = int(r.ranks?.[k], 0, 1e6, 0);
  if (r.cuts && typeof r.cuts === 'object') {
    for (const [id, n] of Object.entries(r.cuts)) if (/^[\w-]{1,32}$/.test(id)) s.records.cuts[id] = int(n, 0, 1e6, 0);
  }
  if (raw.unlocks && typeof raw.unlocks === 'object') {
    for (const [id, v] of Object.entries(raw.unlocks)) if (/^[\w-]{1,32}$/.test(id) && v === true) s.unlocks[id] = true;
  }
  return s;
}

function safeStorage() {
  try {
    const ls = window.localStorage;
    const probe = '__knife_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch (_) {
    return null; // Safari private mode (old), storage disabled, sandboxed iframe
  }
}

/**
 * One JSON record under SAVE_KEY. Writes are coalesced (save() marks dirty; flush() writes now).
 * status: 'ok' | 'fresh' (nothing saved yet) | 'recovered' (corrupt record replaced) |
 *         'unavailable' (no storage; the game still runs, nothing persists) | 'error' (last write failed)
 */
export function createSaveStore({ shape, ignore = false, onError } = {}) {
  const ls = ignore ? null : safeStorage();
  let status = ls ? 'fresh' : 'unavailable';
  let data = defaultSave();
  let dirty = false;
  let timer = 0;
  let writes = 0;
  if (ls) {
    let text = null;
    try { text = ls.getItem(SAVE_KEY); } catch (_) {}
    if (text) {
      try {
        data = sanitizeSave(JSON.parse(text), shape);
        status = 'ok';
      } catch (e) {
        status = 'recovered';
        try { ls.setItem(`${SAVE_KEY}.corrupt`, text.slice(0, 20000)); } catch (_) {}
        onError?.(e);
      }
    }
    // Round-6 setting lived in its own key.
    try {
      const old = ls.getItem('knife.haptics');
      if (old != null) {
        if (status !== 'ok') data.settings.haptics = old !== '0'; // fresh or recovered: the old key is all we have
        ls.removeItem('knife.haptics');
        dirty = true;
      }
    } catch (_) {}
  }
  const store = {
    get data() { return data; },
    get status() { return status; },
    get writes() { return writes; },
    get dirty() { return dirty; },
    /** Mark dirty and write within `delay` ms (coalesces bursts, e.g. stone wear while grinding). */
    save(delay = 400) {
      dirty = true;
      if (!ls) return;
      if (!timer) timer = setTimeout(() => store.flush(), delay);
    },
    /** Write now (page hide, result screen). Returns true when the record reached storage. */
    flush() {
      clearTimeout(timer);
      timer = 0;
      if (!ls || !dirty) return !!ls && !dirty;
      try {
        data.savedAt = Date.now();
        ls.setItem(SAVE_KEY, JSON.stringify(data));
        dirty = false;
        writes++;
        if (status !== 'recovered') status = 'ok';
        return true;
      } catch (e) {
        status = 'error'; // quota exceeded etc.: keep playing, retry on the next save
        onError?.(e);
        return false;
      }
    },
    /** Wipe progress and records; settings are kept. */
    reset() {
      const settings = data.settings;
      data = defaultSave();
      data.settings = settings;
      dirty = true;
      store.flush();
    },
  };
  if (dirty) store.save();
  return store;
}

// ---------------------------------------------------------------------------
// Share hand-off
// ---------------------------------------------------------------------------
/** Synchronous data: URL -> Blob (used when the pre-built image is not ready at tap time). */
export function dataURLToBlob(url) {
  const comma = url.indexOf(',');
  const mime = /^data:([^;,]+)/.exec(url)?.[1] || 'application/octet-stream';
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Call synchronously from the tap handler. navigator.share() is invoked before anything is awaited,
 * so the transient user activation is still there on iOS Safari. Resolves with
 * 'shared' | 'cancelled' (AbortError: the user closed the sheet) | 'fallback' (no file share, or it failed).
 */
export function shareFileNow(file, meta, fallback) {
  let pending = null;
  try {
    if (file && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      pending = navigator.share({ files: [file], ...meta });
    }
  } catch (e) {
    pending = Promise.reject(e);
  }
  if (!pending) {
    fallback(null);
    return Promise.resolve('fallback');
  }
  return Promise.resolve(pending).then(
    () => 'shared',
    (e) => {
      if (e && e.name === 'AbortError') return 'cancelled';
      fallback(e);
      return 'fallback';
    },
  );
}
