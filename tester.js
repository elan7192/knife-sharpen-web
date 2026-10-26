import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Sharpness tester (鋒利度測試儀): a bench rig that clamps the knife edge-down over a taut test thread
// and presses until the thread parts. The dial reads the peak force in grams (lower = sharper).
// This module only builds the prop, paints the dial and draws the progress chart; main.js runs the
// sequence (camera, timing, sound). Everything is procedural geometry and canvas paint.
// Tester-local frame: y up, thread along x at THREAD_Y, the blade comes down at x = 0 with its edge along z.
// ---------------------------------------------------------------------------
export const THREAD_Y = 0.062;
export const THREAD_HALF = 0.05; // posts at x = ±THREAD_HALF
export const DIAL = { min: 20, max: 2000, start: -135, sweep: 270 }; // log scale, degrees clockwise from 12 o'clock

/** Needle angle (radians, for rotation.z; positive = counter-clockwise) for a force in grams. */
export function dialAngle(g) {
  const k = Math.log(Math.max(DIAL.min, Math.min(DIAL.max * 1.08, g)) / DIAL.min) / Math.log(DIAL.max / DIAL.min);
  return -THREE.MathUtils.degToRad(DIAL.start + k * DIAL.sweep);
}

function dialTexture(grades) {
  const n = 512;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  const cx = n / 2, cy = n / 2;
  g.fillStyle = '#F5EFE6';
  g.beginPath(); g.arc(cx, cy, n / 2, 0, Math.PI * 2); g.fill();
  const ang = (v) => { // canvas angle for a value (0 rad = 3 o'clock, clockwise)
    const k = Math.log(v / DIAL.min) / Math.log(DIAL.max / DIAL.min);
    return THREE.MathUtils.degToRad(DIAL.start + k * DIAL.sweep - 90);
  };
  // Grade arcs (sharp on the left / low force, dull on the right)
  const bounds = grades.map((x) => x.min);
  grades.forEach((gr, i) => {
    const hi = i === 0 ? DIAL.max : bounds[i - 1];
    const lo = Math.max(DIAL.min, gr.min);
    g.strokeStyle = gr.color;
    g.lineWidth = n * 0.055;
    g.beginPath(); g.arc(cx, cy, n * 0.4, ang(lo), ang(hi)); g.stroke();
    const mid = (ang(lo) + ang(hi)) / 2;
    g.fillStyle = '#2B2A28';
    g.font = `bold ${n * 0.06}px sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(gr.name, cx + Math.cos(mid) * n * 0.3, cy + Math.sin(mid) * n * 0.3);
  });
  // Ticks + numbers
  g.strokeStyle = '#2B2A28';
  for (const v of [20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000]) {
    const a = ang(v);
    const major = [20, 50, 100, 200, 500, 1000, 2000].includes(v);
    g.lineWidth = major ? 4 : 2;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * n * 0.43, cy + Math.sin(a) * n * 0.43);
    g.lineTo(cx + Math.cos(a) * n * (major ? 0.48 : 0.465), cy + Math.sin(a) * n * (major ? 0.48 : 0.465));
    g.stroke();
    if (major) {
      g.fillStyle = '#2B2A28';
      g.font = `${n * 0.045}px sans-serif`;
      g.fillText(String(v), cx + Math.cos(a) * n * 0.215 + Math.cos(a) * n * 0.0, cy + Math.sin(a) * n * 0.215);
    }
  }
  g.fillStyle = 'rgba(43,42,40,0.6)';
  g.font = `${n * 0.05}px sans-serif`;
  g.fillText('g・切斷力', cx, cy + n * 0.2);
  g.font = `bold ${n * 0.045}px serif`;
  g.fillText('研 刃 計', cx, cy - n * 0.13);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Build the tester prop. mats = { wood, darkWood, steel }. Returns handles main.js animates:
 *   group, carriage (moves in y; the knife hangs under it), threadL / threadR (unit-length cylinders
 *   aimed by setThread), needle / peak (rotation.z), dialPos (world anchor helper), lamp (status light).
 */
export function buildTester(mats, grades) {
  const group = new THREE.Group();
  const add = (geo, m, x, y, z, cast = true) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(x, y, z);
    o.castShadow = cast;
    o.receiveShadow = true;
    group.add(o);
    return o;
  };
  const black = new THREE.MeshStandardMaterial({ color: '#2B2A28', roughness: 0.5, metalness: 0.4 });
  // Base plate + rubber feet
  add(new THREE.BoxGeometry(0.2, 0.014, 0.13), mats.darkWood, 0, 0.007, 0);
  add(new THREE.BoxGeometry(0.19, 0.004, 0.12), black, 0, 0.016, 0, false);
  // Thread posts with knurled clamp knobs
  for (const sx of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.0055, 0.0055, THREAD_Y - 0.012, 10), mats.steel, sx * THREAD_HALF, 0.018 + (THREAD_Y - 0.018) / 2, 0);
    add(new THREE.CylinderGeometry(0.009, 0.009, 0.012, 12), black, sx * THREAD_HALF, THREAD_Y, 0).rotation.z = Math.PI / 2;
  }
  // Gantry: two columns behind the thread, a cross beam, a lead screw down to the carriage
  const TOP = 0.2;
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.012, TOP, 0.012), mats.steel, sx * 0.082, 0.014 + TOP / 2, -0.045);
  add(new THREE.BoxGeometry(0.18, 0.018, 0.022), black, 0, TOP + 0.014, -0.045);
  const screw = add(new THREE.CylinderGeometry(0.003, 0.003, 1, 8), mats.steel, 0, 0, -0.045, false);
  const carriage = new THREE.Group();
  group.add(carriage);
  // Carriage: a clamp block on the spine, arm back to the lead screw
  const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.016, 0.022), black);
  clamp.position.set(0, 0.054, 0);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.048), black);
  arm.position.set(0, 0.058, -0.024);
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.028, 10), mats.steel);
  knob.rotation.x = Math.PI / 2;
  knob.position.set(0.019, 0.054, 0);
  for (const o of [clamp, arm, knob]) { o.castShadow = true; carriage.add(o); }
  // Thread: two halves meeting under the edge (aimed every frame)
  const threadMat = new THREE.MeshStandardMaterial({ color: '#D7263D', roughness: 0.6, emissive: '#5a0d16', emissiveIntensity: 0.6 });
  const threadGeo = new THREE.CylinderGeometry(0.0011, 0.0011, 1, 6).translate(0, 0.5, 0);
  const threadL = new THREE.Mesh(threadGeo, threadMat);
  const threadR = new THREE.Mesh(threadGeo, threadMat);
  group.add(threadL, threadR);
  // Dial gauge, front right, tilted up toward the camera
  const dial = new THREE.Group();
  dial.position.set(0.128, 0.05, 0.03);
  dial.rotation.set(-0.35, -0.55, 0);
  group.add(dial);
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.048, 0.02, 24), black);
  housing.rotation.x = Math.PI / 2;
  housing.castShadow = true;
  const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.044, 0.0035, 6, 32), mats.steel);
  bezel.position.z = 0.0105;
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.042, 40), new THREE.MeshBasicMaterial({ map: dialTexture(grades), toneMapped: false }));
  face.position.z = 0.0104;
  const needle = new THREE.Group();
  needle.position.z = 0.0118;
  const nGeo = new THREE.BoxGeometry(0.0022, 0.036, 0.0008).translate(0, 0.014, 0);
  needle.add(new THREE.Mesh(nGeo, new THREE.MeshBasicMaterial({ color: '#2B2A28' })));
  const peak = new THREE.Group();
  peak.position.z = 0.0114;
  peak.add(new THREE.Mesh(nGeo, new THREE.MeshBasicMaterial({ color: '#D7263D', toneMapped: false })));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.003, 12), mats.steel);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = 0.0125;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 10, 8), new THREE.MeshBasicMaterial({ color: '#3E4A61', toneMapped: false }));
  lamp.position.set(0.034, -0.034, 0.008);
  dial.add(housing, bezel, face, needle, peak, hub, lamp);
  // Lead screw from the beam down to the carriage arm
  const setCarriage = (y) => {
    carriage.position.y = y;
    const top = TOP + 0.005, bottom = y + 0.058;
    screw.scale.y = Math.max(0.001, top - bottom);
    screw.position.y = (top + bottom) / 2;
  };
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), from = new THREE.Vector3();
  /** Aim the two thread halves from the posts to the contact point (x = 0, y = THREAD_Y - sag). */
  const setThread = (sag, broken = 0, whip = 0) => {
    for (const [m, sx] of [[threadL, -1], [threadR, 1]]) {
      from.set(sx * THREAD_HALF, THREAD_Y, 0);
      if (!broken) {
        dir.set(-sx * THREAD_HALF, -sag, 0);
      } else { // parted: each half recoils toward its post and droops
        const len = THREAD_HALF * (1 - 0.55 * broken);
        dir.set(-sx * len * Math.cos(whip), -len * Math.sin(whip) - 0.004 * broken, 0.003 * Math.sin(whip * 3));
      }
      m.position.copy(from);
      m.scale.y = dir.length();
      m.quaternion.setFromUnitVectors(up, dir.normalize());
    }
  };
  setThread(0);
  setCarriage(0.12);
  return { group, carriage, setCarriage, setThread, needle, peak, lamp, dial, threadMat };
}

/**
 * Progress chart (2D canvas): one column per stage (before + each grit), y = force on a log scale,
 * inverted so a sharper edge plots higher. Grade bands shade the background. points: [{ col, g }].
 * reveal (0..1) draws the newest segment growing in. Colours follow the climax palette.
 */
export function drawChart(canvas, { cols, points, grades, reveal = 1, highlight = -1 }) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = canvas.clientWidth || 320, H = canvas.clientHeight || 150;
  if (canvas.width !== Math.round(W * dpr)) canvas.width = Math.round(W * dpr);
  if (canvas.height !== Math.round(H * dpr)) canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const L = 30, R = 16, T = 8, B = 22;
  const gMin = 20, gMax = 2000;
  const y = (v) => T + (1 - Math.log(Math.max(gMin, Math.min(gMax, v)) / gMin) / Math.log(gMax / gMin)) * (H - T - B);
  const x = (c) => L + (c / (cols.length - 1)) * (W - L - R);
  // grade bands
  grades.forEach((gr, i) => {
    const hi = i === 0 ? gMax : grades[i - 1].min;
    const lo = Math.max(gMin, gr.min);
    g.fillStyle = gr.color;
    g.globalAlpha = 0.1;
    g.fillRect(L, y(hi), W - L - R, y(lo) - y(hi));
    g.globalAlpha = 0.85;
    g.fillStyle = gr.color;
    g.font = '10px sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillText(gr.name, L - 4, (y(hi) + y(lo)) / 2);
  });
  g.globalAlpha = 1;
  // x labels
  g.fillStyle = 'rgba(232,241,248,0.6)';
  g.font = '9px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'top';
  cols.forEach((label, c) => g.fillText(label, x(c), H - B + 6));
  g.strokeStyle = 'rgba(232,241,248,0.12)';
  g.lineWidth = 1;
  cols.forEach((_, c) => { g.beginPath(); g.moveTo(x(c), T); g.lineTo(x(c), H - B); g.stroke(); });
  if (!points.length) return;
  // line (newest segment grows with reveal)
  const pts = points.map((p) => [x(p.col), y(p.g)]);
  g.strokeStyle = '#E8F1F8';
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const last = i === pts.length - 1;
    const k = last ? reveal : 1;
    g.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k);
  }
  g.stroke();
  points.forEach((p, i) => {
    if (i === pts.length - 1 && reveal < 1 && pts.length > 1) return;
    const gr = grades.find((q) => p.g >= q.min) || grades[grades.length - 1];
    const hl = i === highlight;
    g.fillStyle = gr.color;
    g.beginPath(); g.arc(pts[i][0], pts[i][1], hl ? 5 : 3.5, 0, Math.PI * 2); g.fill();
    if (hl) {
      g.strokeStyle = '#FFFFFF';
      g.lineWidth = 1.5;
      g.stroke();
    }
  });
}
