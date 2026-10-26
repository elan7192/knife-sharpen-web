import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// URL options
//   ?time=day|dusk  force a palette (default: dusk between 17:00 and 06:00)
//   ?demo=0.8       debug: start with that sharpness and run the test cut immediately
// Everything in the scene is procedural geometry: no model, texture or HDRI files are loaded.
// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const hour = new Date().getHours();
const TIME = params.get('time') === 'dusk' || params.get('time') === 'day' ? params.get('time') : hour >= 17 || hour < 6 ? 'dusk' : 'day';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const BAND_LO = 15; // angle sweet spot (degrees)
const BAND_HI = 20;
const ANGLE_MIN = 0;
const ANGLE_MAX = 30;
const START_ANGLE = 26;
const ANGLE_PER_PX = 0.06; // degrees per pixel of vertical finger movement
// Pressure sweet zone: deliberately wide so phone swipes land in it easily.
const PRESS_LO = 0.3;
const PRESS_HI = 0.8;
const STONE_LEN = 0.21; // 05-model-specs: ~0.21 x 0.07 x 0.03 m
const STONE_W = 0.07;
const STONE_H = 0.03;
const HOLDER_H = 0.035; // 砥石台 height under the stone
const STONE_TOP = HOLDER_H + STONE_H; // stone surface height above the table top
const KNIFE_TRAVEL = STONE_LEN / 2 - 0.02;
const KNIFE_YAW = 2.44; // handle toward the player's right hand
const STATION_X = 0;
const TABLE_TOP = 0.78;
const STAGE_TOP = 0.68;

// Edge coverage: the edge is split into segments; each one is polished separately.
const SEGS = 10;
const SEG_LEVELS = [0.25, 0.5, 0.75, 1]; // each crossing rings the 刃鳴 and brightens the gleam
const GAIN_PER_PASS = 0.06; // progress a segment gains per ideal full pass over it
const SEG_WINDOW = 1.5 / SEGS; // contact patch half-width in edge units

// Test-cut targets, in unlock order. need = sharpness that unlocks it (and that a cut requires);
// hitstop = cut freeze (s, capped by HITSTOP_MAX); dull = edge lost per successful cut, so a
// target unlocked earlier can bounce the blade later until it is touched up again.
const TARGETS = [
  { id: 'paper', name: '紙', need: 0.0, hitstop: 0.04, dull: 0.0 },
  { id: 'makiwara', name: '卷藁', need: 0.3, hitstop: 0.06, dull: 0.01 },
  { id: 'iron', name: '鐵', need: 0.55, hitstop: 0.09, dull: 0.03 },
  { id: 'boulder', name: '巨石', need: 0.75, hitstop: 0.11, dull: 0.04 },
  { id: 'iceberg', name: '冰山', need: 0.92, hitstop: 0.12, dull: 0.03 },
];
const RANKS = ['鈍刀', '入門', '見習', '利刃', '名刀', '神品']; // index = best target cut + 1 (free mode)

// Order (委託) mode. Order n asks for TARGETS[min(n, last)] (difficulty rises per completed order,
// then stays at the iceberg); the customer cycles through this list. The knife is always the gyuto.
const CUSTOMERS = [
  { name: '王老闆', from: '老街豆腐店', knife: '天天切豆腐、刃口鈍掉的牛刀', line: '豆腐都切得坑坑巴巴的，麻煩你了。' },
  { name: '陳師傅', from: '竹林工坊', knife: '劈竹子劈到有點捲刃的牛刀', line: '慢慢磨就好，不急。' },
  { name: '林師傅', from: '打鐵鋪', knife: '剛打好、還沒開鋒的牛刀', line: '我只管打鐵，磨刀就交給你了。' },
  { name: '張大哥', from: '山腳石材行', knife: '刃口崩了一點的牛刀', line: '聽說磨得夠利，連石頭都切得開？' },
  { name: '小雪', from: '冰雕工作室', knife: '收了一整年、鈍掉的牛刀', line: '希望它能像冰一樣俐落。' },
  { name: '阿明', from: '漁港', knife: '沾了海水、有點鈍的牛刀', line: '剛收完漁獲，刀鈍到切不動魚。' },
];
// Order scoring (deterministic, 0–100). Each part is a 0..1 ratio times its weight; weights sum to 100.
//   margin     final sharpness over the requirement; full at need + min(marginFull, marginCeil - need)
//   angle      share of grinding distance with the angle inside BAND_LO–BAND_HI
//   pressure   share of grinding distance with pressure in the green zone PRESS_LO–PRESS_HI
//   efficiency grinding distance until the margin goal was first reached (or in total, if never) vs. par
//              (= max(parMin, ideal full passes from orderStart to the goal × parSlack)); 1 when within par.
//              Polishing past the goal is never penalised.
// A failed cut has no score: rank 失敗 and the player can keep sharpening the same order.
const SCORE = {
  weights: { margin: 40, angle: 25, pressure: 20, efficiency: 15 },
  marginFull: 0.1,
  marginCeil: 0.98,
  parSlack: 2,
  parMin: 2, // full passes; one pass = the whole edge across the stone once
  orderStart: 0.08, // every order starts with a dull edge at this sharpness, on the coarse stone
};
const RANK_TABLE = [{ rank: 'S', min: 90 }, { rank: 'A', min: 75 }, { rank: 'B', min: 55 }, { rank: 'C', min: 0 }];
const RANK_LINES = { S: '完美！這把刀比新的還利。', A: '好利！謝謝你。', B: '不錯，可以用了。', C: '切得開，下次再磨細一點吧。' };
const HITSTOP_MAX = 0.12; // seconds; research: hitstop must be capped
const FAIL_HITSTOP = 0.07;
const SLOWMO_SCALE = 0.15; // time scale during the slash
const SLASH_TIME = 0.14; // game seconds for the slash stroke (~0.9 s real at SLOWMO_SCALE)
const LETTERBOX_ASPECT = 2.39; // visible area during the cinematic is exactly this aspect
const LETTERBOX_IN = 0.6; // seconds for the bars to slide in / out
const CINE_HFOV = 44; // horizontal field of view (deg) of the 2.39:1 cinematic frame
const CUT_TILT = THREE.MathUtils.degToRad(30); // pre-cut plane: 30° off vertical (05-model-specs)
const SHAKE_TIME = 0.45; // camera shake decay after the freeze (s)

// Whetstones 粗 / 中 / 細: rate = progress multiplier, cap = highest sharpness that stone can reach,
// wear = how fast its top dishes, fx = particles at the contact point, sound = grind timbre.
// Colours are palette entries (05/palettes.json): dusk stone, dusk wood, day gravel.
const STONES = [
  { id: 'coarse', name: '粗', grit: '#220', color: '#5C5650', rate: 2.2, cap: 0.55, wear: 1.0, fx: 'spark',
    sound: { f0: 240, f1: 950, q: 0.7, gain: 1.0, grit: 0.7, hiss: 0.04, hissF: 2400 } },
  { id: 'medium', name: '中', grit: '#1000', color: '#A8643C', rate: 1.0, cap: 0.85, wear: 0.45, fx: 'slurry',
    sound: { f0: 480, f1: 1700, q: 1.1, gain: 0.75, grit: 0.15, hiss: 0.12, hissF: 3600 } },
  { id: 'fine', name: '細', grit: '#6000', color: '#DCD3C3', rate: 0.5, cap: 1.0, wear: 0.2, fx: 'slurry',
    sound: { f0: 1100, f1: 3400, q: 2.2, gain: 0.5, grit: 0, hiss: 0.28, hissF: 6400 } },
];
const WEAR_COLS = 28; // stone top subdivisions along its length (wear profile resolution)
const WEAR_ROWS = 6;
const WEAR_DEPTH = 0.0025; // m: deepest dish a stone can get
const WEAR_RATE = 0.012; // wear per full pass at full pressure on wear-1.0 stone
const WEAR_SIGMA = 0.02; // m: width of the contact patch that wears the stone

const isMobile = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const damp = (current, target, rate, dt) => lerp(current, target, 1 - Math.exp(-rate * dt));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOutBounce = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const pixelRatio = () => Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2);
renderer.setPixelRatio(pixelRatio());
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = isMobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);
const canvas = renderer.domElement;

// ---------------------------------------------------------------------------
// Palettes (/workspace/game-art/palettes.json): one per time of day, plus the test-cut climax.
// Colours not in the palette (grass shade, dark wood) are derived from palette entries.
// ---------------------------------------------------------------------------
const PALETTES = {
  day: {
    skyTop: '#C9D8C5', skyBottom: '#F3EBDD', wood: '#B08A63', stone: '#7C7A75', water: '#4E6E7E',
    leaf: '#6F8F6A', moss: '#C9D8C5', gravel: '#DCD3C3', sun: '#FFF4E2', sunI: 2.1,
    hemiSky: '#F3EBDD', hemiGround: '#6F8F6A', hemiI: 0.95, envI: 0.55, glow: '#FFD27A', lanternI: 0.6,
  },
  dusk: {
    skyTop: '#8E6C8A', skyBottom: '#F2B880', wood: '#A8643C', stone: '#5C5650', water: '#3E4A61',
    leaf: '#5E7A5C', moss: '#8E9A80', gravel: '#B9A493', sun: '#F2B880', sunI: 1.25,
    hemiSky: '#8E6C8A', hemiGround: '#3E4A61', hemiI: 0.8, envI: 0.45, glow: '#FFD27A', lanternI: 1.6,
  },
};
const P = Object.fromEntries(Object.entries(PALETTES[TIME]).map(([k, v]) => [k, typeof v === 'string' ? new THREE.Color(v) : v]));
const CLIMAX = {
  bg: new THREE.Color('#0B0D12'), ambient: new THREE.Color('#1C2A3A'), rim: new THREE.Color('#9FB7C9'),
  slash: '#E8F1F8', accent: '#D7263D', heat: new THREE.Color('#F4C95D'), gleam: new THREE.Color('#E8F1F8'),
};
const INK = '#2B2A28';
document.body.classList.add(TIME);
const shade = (c, k) => new THREE.Color(c).multiplyScalar(k);

const scene = new THREE.Scene();
scene.background = CLIMAX.bg;
scene.fog = new THREE.Fog(P.skyBottom.clone(), 5, 14);

// Gradient sky dome; uDark blends it to the climax black.
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uTop: { value: P.skyTop }, uBottom: { value: P.skyBottom }, uDark: { value: 0 }, uBg: { value: CLIMAX.bg } },
  vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform vec3 uTop, uBottom, uBg; uniform float uDark; varying vec3 vP;
    void main(){ vec3 c = mix(uBottom, uTop, smoothstep(0.0, 0.55, vP.y)); gl_FragColor = vec4(mix(c, uBg, uDark), 1.0);
    #include <colorspace_fragment>
    }`,
});
scene.add(new THREE.Mesh(new THREE.SphereGeometry(35, 24, 12), skyMat));

// Procedural IBL so the metal has something to reflect (no external HDRI).
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = P.envI;
pmrem.dispose();

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.02, 80);

// Lights: one shadow-casting sun + sky ambient (style guide), lantern glow, and a cold rim for the climax.
const hemi = new THREE.HemisphereLight(P.hemiSky, P.hemiGround, P.hemiI);
scene.add(hemi);
const sun = new THREE.DirectionalLight(P.sun, P.sunI);
sun.position.set(TIME === 'dusk' ? -3.2 : 2.2, TIME === 'dusk' ? 2.6 : 4.5, 2.0);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(isMobile ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.5, far: 12 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
const lanternLight = new THREE.PointLight(P.glow, P.lanternI, 3, 2); // no shadows: only the sun casts
scene.add(lanternLight);
const rim = new THREE.DirectionalLight(CLIMAX.rim, 0);
scene.add(rim, rim.target);

// ---------------------------------------------------------------------------
// Shared materials (scenery: flat-shaded, rough, never competes with the knife)
// ---------------------------------------------------------------------------
const flat = (color, roughness = 0.85, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, flatShading: true, ...extra });
const mat = {
  wood: flat(P.wood, 0.85),
  darkWood: flat(shade(P.wood, 0.55), 0.85),
  handle: new THREE.MeshStandardMaterial({ color: shade(P.wood, 0.42), roughness: 0.5 }),
  horn: flat(INK, 0.5),
  rock: flat(P.stone, 0.92),
  paleRock: flat(shade(P.stone, 1.15), 0.9),
  moss: flat(P.leaf, 1),
  mossLight: flat(P.moss, 1),
  gravel: flat(P.gravel, 1),
  rake: flat(shade(P.gravel, 0.9), 1),
  paper: new THREE.MeshStandardMaterial({ color: '#fff6e4', emissive: P.glow, emissiveIntensity: TIME === 'dusk' ? 1.3 : 0.55, roughness: 0.9, side: THREE.DoubleSide }),
  water: new THREE.MeshPhysicalMaterial({ color: P.water, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.85 }),
  // Knife: PBR metal (metalness 1); body roughness 0.38 -> 0.12 as it sharpens (style guide 0.25-0.4 -> ~0.1).
  blade: new THREE.MeshPhysicalMaterial({ color: '#e9ecf0', metalness: 1, roughness: 0.38, envMapIntensity: 1.3, side: THREE.DoubleSide }),
  steel: new THREE.MeshStandardMaterial({ color: '#d5d9de', metalness: 1, roughness: 0.25 }),
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function mesh(geo, material, cast = true, receive = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpT = new THREE.Vector3();
/** Bakes a transform into a geometry (non-indexed, so mixed primitives can be merged). */
function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  tmpM.compose(tmpT.set(x, y, z), tmpQ.setFromEuler(tmpE.set(rx, ry, rz)), tmpS.set(sx, sy, sz));
  return g.applyMatrix4(tmpM);
}
/** Several primitives sharing one material -> one draw call. */
function merged(geos, material, cast = true, receive = true) {
  const g = mergeGeometries(geos);
  geos.forEach((x) => x.dispose());
  g.computeVertexNormals();
  return mesh(g, material, cast, receive);
}
/** A low-poly rock: polyhedron with seeded vertex jitter (shared corners stay welded). */
function rockGeo(r, detail = 0, jitter = 0.22) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  const offsets = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    if (!offsets.has(key)) offsets.set(key, 1 - jitter / 2 + rand() * jitter);
    const k = offsets.get(key);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  return g;
}
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// World layout (all procedural, palette-coloured, flat-shaded low poly)
// ---------------------------------------------------------------------------
const onTable = new THREE.Group();
onTable.position.y = TABLE_TOP;
scene.add(onTable);

const STAGE_POS = new THREE.Vector3(1.45, 0, -0.3);
const stage = new THREE.Group();
stage.position.set(STAGE_POS.x, STAGE_TOP, STAGE_POS.z);
scene.add(stage);

// Ground: grass, a raked gravel bed around the work area, and a few moss patches
{
  const ground = mesh(new THREE.CircleGeometry(34, 24), mat.moss, false, true);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const gravel = mesh(new THREE.CircleGeometry(5.6, 32), mat.gravel, false, true);
  gravel.rotation.x = -Math.PI / 2;
  gravel.position.y = 0.002;
  gravel.scale.set(1.15, 1, 1);
  scene.add(gravel);
  const rings = [];
  for (let i = 0; i < 9; i++) rings.push(place(new THREE.RingGeometry(2.4 + i * 0.35, 2.46 + i * 0.35, 48), 0, 0.004, 0, -Math.PI / 2));
  scene.add(merged(rings, mat.rake, false, true));
  const moss = [];
  for (const [x, z, r, sx] of [[-2.4, -1.1, 0.9, 1.4], [2.6, -1.4, 0.7, 1.2], [-3.4, 0.9, 0.6, 1.1]]) {
    moss.push(place(new THREE.CircleGeometry(r, 9), x, 0.006, z, -Math.PI / 2, 0, 0, sx, 1, 1));
  }
  scene.add(merged(moss, mat.mossLight, false, true));
}

// Plank table (main table; whetstone sits on it)
{
  const W = 1.5, D = 0.8, T = 0.045, PLANKS = 5;
  const tops = [];
  for (let i = 0; i < PLANKS; i++) {
    const z = -D / 2 + (i + 0.5) * (D / PLANKS);
    tops.push(place(new THREE.BoxGeometry(W + (rand() - 0.5) * 0.04, T, D / PLANKS - 0.006), (rand() - 0.5) * 0.02, TABLE_TOP - T / 2 - rand() * 0.002, z));
  }
  scene.add(merged(tops, mat.wood));
  const frame = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    frame.push(place(new THREE.BoxGeometry(0.07, TABLE_TOP - T, 0.07), sx * (W / 2 - 0.1), (TABLE_TOP - T) / 2, sz * (D / 2 - 0.08)));
  }
  for (const sx of [-1, 1]) frame.push(place(new THREE.BoxGeometry(0.05, 0.05, D - 0.16), sx * (W / 2 - 0.1), 0.18, 0));
  frame.push(place(new THREE.BoxGeometry(W - 0.2, 0.05, 0.04), 0, 0.18, 0));
  for (const sz of [-1, 1]) frame.push(place(new THREE.BoxGeometry(W - 0.12, 0.06, 0.03), 0, TABLE_TOP - T - 0.03, sz * (D / 2 - 0.08)));
  scene.add(merged(frame, mat.darkWood));
}

// Whetstones on a wooden holder (砥石台). Three stones (粗/中/細); the active one sits in the holder,
// the others rest behind it. Each stone's top is subdivided so it can dish with use (wear profile
// along its length) and darken via vertex colours.
const stoneHolder = new THREE.Group();
{
  const holder = [];
  for (const sx of [-1, 1]) holder.push(place(new THREE.BoxGeometry(0.03, 0.015, STONE_W + 0.07), sx * (STONE_LEN / 2 - 0.03), 0.0075, 0)); // feet
  holder.push(place(new THREE.BoxGeometry(STONE_LEN + 0.05, HOLDER_H - 0.015, STONE_W + 0.03), 0, 0.015 + (HOLDER_H - 0.015) / 2, 0)); // bed
  for (const sx of [-1, 1]) holder.push(place(new THREE.BoxGeometry(0.012, 0.016, STONE_W + 0.03), sx * (STONE_LEN / 2 + 0.008), HOLDER_H + 0.008, 0)); // end stops
  stoneHolder.add(merged(holder, mat.darkWood));
  stoneHolder.position.x = STATION_X;
  onTable.add(stoneHolder);
}
// Where the stones sit: [in the holder, rest slot A, rest slot B] (onTable-local)
const STONE_SLOTS = [
  { x: STATION_X, y: HOLDER_H, z: 0, ry: 0 },
  { x: -0.25, y: 0, z: -0.2, ry: 0.12 },
  { x: 0.2, y: 0, z: -0.2, ry: -0.1 },
];
const stones = STONES.map((def) => {
  const geo = new THREE.BoxGeometry(STONE_LEN, STONE_H, STONE_W, WEAR_COLS, 1, WEAR_ROWS);
  geo.translate(0, STONE_H / 2, 0); // bottom at 0, top surface at STONE_H
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // Every vertex on the top rim (top face + upper row of the side faces) follows the dish, so no cracks.
  const top = [], topCol = [], topProf = [];
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < STONE_H - 1e-5) continue;
    top.push(i);
    topCol.push(Math.round(((p.getX(i) + STONE_LEN / 2) / STONE_LEN) * WEAR_COLS));
    topProf.push(1 - Math.pow((2 * p.getZ(i)) / STONE_W, 4)); // flat-bottomed dish across the width
  }
  const dry = new THREE.Color(def.color);
  const material = new THREE.MeshStandardMaterial({ color: dry, roughness: 0.85, vertexColors: true });
  const m = mesh(geo, material);
  onTable.add(m);
  return {
    def, mesh: m, material, dry, wet: dry.clone().lerp(P.water, 0.35).multiplyScalar(0.85),
    wear: new Float32Array(WEAR_COLS + 1), top: Int32Array.from(top), topCol: Int32Array.from(topCol),
    topProf: Float32Array.from(topProf), dirty: false, slot: 0, wet01: 0,
  };
});
const stoneIndex = (id) => STONES.findIndex((s) => s.id === id);
function placeStones(activeIdx, k = 1, from = null) {
  let rest = 1;
  stones.forEach((s, i) => {
    const slot = i === activeIdx ? 0 : rest++;
    const a = STONE_SLOTS[from ? from[i] : slot], b = STONE_SLOTS[slot];
    s.mesh.position.set(lerp(a.x, b.x, k), lerp(a.y, b.y, k) + Math.sin(k * Math.PI) * 0.06, lerp(a.z, b.z, k));
    s.mesh.rotation.y = lerp(a.ry, b.ry, k);
    if (k >= 1) s.slot = slot;
  });
}
/** Apply a stone's wear profile to its top rim (positions, vertex colour darkening, normals). */
function applyStoneWear(s) {
  s.dirty = false;
  const p = s.mesh.geometry.attributes.position;
  const c = s.mesh.geometry.attributes.color;
  for (let k = 0; k < s.top.length; k++) {
    const i = s.top[k];
    const w = s.wear[s.topCol[k]] * s.topProf[k];
    p.setY(i, STONE_H - w * WEAR_DEPTH);
    const d = 1 - w * 0.4; // worn (and slurry-stained) metal-grey band
    c.setXYZ(i, d, d * 0.97, d * 0.95);
  }
  p.needsUpdate = true;
  c.needsUpdate = true;
  s.mesh.geometry.computeVertexNormals();
}
/** Dish depth (m) under stone-local x at the centre line. */
function stoneDishAt(s, x) {
  const u = clamp((x + STONE_LEN / 2) / STONE_LEN, 0, 1) * WEAR_COLS;
  const i = Math.floor(u), f = u - i;
  return lerp(s.wear[i], s.wear[Math.min(WEAR_COLS, i + 1)], f) * WEAR_DEPTH;
}

// Water bucket for flavour
{
  const bucket = new THREE.Group();
  const shellMat = mat.wood.clone();
  shellMat.side = THREE.DoubleSide;
  const shell = mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.12, 10, 1, true), shellMat);
  shell.position.y = 0.06;
  const floor = mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.01, 10), mat.wood);
  floor.position.y = 0.005;
  const band = mesh(new THREE.TorusGeometry(0.087, 0.005, 4, 10), mat.horn);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.085;
  const water = mesh(new THREE.CircleGeometry(0.086, 10), mat.water, false, false);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.095;
  bucket.add(shell, floor, band, water);
  bucket.position.set(0.42, 0, -0.24);
  onTable.add(bucket);
}

// Oil lantern (行灯): wooden frame, four glowing paper panels, warm point light inside
const LANTERN_POS = new THREE.Vector3(-0.5, 0, -0.22);
const LANTERN_H = 0.3;
{
  const g = new THREE.Group();
  const S = 0.12, H = LANTERN_H;
  const frame = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) frame.push(place(new THREE.BoxGeometry(0.012, H, 0.012), sx * S / 2, H / 2, sz * S / 2));
  for (const y of [0.04, H - 0.006]) {
    for (const s of [-1, 1]) {
      frame.push(place(new THREE.BoxGeometry(S + 0.012, 0.012, 0.012), 0, y, s * S / 2));
      frame.push(place(new THREE.BoxGeometry(0.012, 0.012, S + 0.012), s * S / 2, y, 0));
    }
  }
  frame.push(place(new THREE.BoxGeometry(S * 0.8, 0.008, S * 0.8), 0, 0.05, 0)); // oil-dish shelf
  frame.push(place(new THREE.BoxGeometry(0.012, 0.04, 0.008), -S * 0.3, H + 0.02, 0)); // carry handle
  frame.push(place(new THREE.BoxGeometry(0.012, 0.04, 0.008), S * 0.3, H + 0.02, 0));
  frame.push(place(new THREE.BoxGeometry(S * 0.7, 0.01, 0.01), 0, H + 0.04, 0));
  g.add(merged(frame, mat.darkWood));
  const panels = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    panels.push(place(new THREE.PlaneGeometry(S - 0.006, H - 0.06), Math.sin(a) * (S / 2 - 0.002), 0.04 + (H - 0.05) / 2, Math.cos(a) * (S / 2 - 0.002), 0, a));
  }
  g.add(merged(panels, mat.paper, false, false));
  g.position.copy(LANTERN_POS);
  g.rotation.y = 0.5;
  onTable.add(g);
}

// Round test-cut table
{
  const top = mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.045, 16), mat.wood);
  top.position.set(STAGE_POS.x, STAGE_TOP - 0.0225, STAGE_POS.z);
  const base = merged([
    place(new THREE.CylinderGeometry(0.05, 0.065, STAGE_TOP - 0.045, 8), 0, (STAGE_TOP - 0.045) / 2, 0),
    place(new THREE.CylinderGeometry(0.22, 0.25, 0.04, 8), 0, 0.02, 0),
    place(new THREE.CylinderGeometry(0.16, 0.12, 0.04, 8), 0, STAGE_TOP - 0.065, 0),
  ], mat.darkWood);
  base.position.set(STAGE_POS.x, 0, STAGE_POS.z);
  scene.add(top, base);
}

// Stepping stones, rock clusters, boulders
{
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const r = 0.22 + rand() * 0.06;
    steps.push(place(new THREE.CylinderGeometry(r, r * 1.05, 0.07, 7), -1.7 + i * 0.42 + (i % 2) * 0.05, 0.035, 1.05 + (i % 2) * 0.22 - i * 0.12, 0, rand() * 3, 0, 1, 1, 0.8 + rand() * 0.2));
  }
  scene.add(merged(steps, mat.paleRock));

  const rocks = [];
  const cluster = (cx, cz, n, size) => {
    for (let i = 0; i < n; i++) {
      const r = size * (0.5 + rand() * 0.6);
      rocks.push(place(rockGeo(r), cx + (rand() - 0.5) * size * 2.4, r * 0.45, cz + (rand() - 0.5) * size * 2, rand() * 3, rand() * 3, 0, 1, 0.7, 1));
    }
  };
  cluster(-2.2, -1.1, 5, 0.22);
  cluster(0.8, -1.6, 3, 0.16);
  cluster(2.4, 0.6, 3, 0.14);
  rocks.push(place(rockGeo(0.5, 1, 0.18), 2.7, 0.35, -1.6, 0.3, 0.8, 0, 1.25, 0.85, 1));
  rocks.push(place(rockGeo(0.32, 1, 0.2), -3.0, 0.2, 0.3, 0.2, 1.4, 0, 1.2, 0.8, 1));
  scene.add(merged(rocks, mat.rock));
}

// ---------------------------------------------------------------------------
// Bamboo grove (instanced, gently swaying, no per-frame allocation)
// ---------------------------------------------------------------------------
const bamboo = (() => {
  const SEG_H = 0.42;
  const stalks = [];
  for (let i = 0; i < 34; i++) {
    const a = -1.25 + (i / 33) * 2.5 + (rand() - 0.5) * 0.08;
    const r = 3.6 + rand() * 2.2;
    stalks.push({
      x: Math.sin(a) * r,
      z: -Math.cos(a) * r * 0.75 - 0.6,
      segs: 8 + Math.floor(rand() * 6),
      radius: 0.03 + rand() * 0.025,
      lean: (rand() - 0.5) * 0.12,
      phase: rand() * Math.PI * 2,
      tint: 0.85 + rand() * 0.25,
    });
  }
  const totalSegs = stalks.reduce((n, s) => n + s.segs, 0);
  // Open-ended cylinders keep a stalk under the 500-tri budget (instanced).
  const segGeo = new THREE.CylinderGeometry(1, 1, SEG_H, 7, 1, true);
  segGeo.translate(0, SEG_H / 2, 0);
  const nodeGeo = new THREE.CylinderGeometry(1.18, 1.18, 0.03, 7, 1, true);
  const leafGeo = new THREE.ConeGeometry(0.05, 0.36, 3);
  leafGeo.rotateZ(Math.PI / 2);
  leafGeo.scale(1, 1, 0.25);
  leafGeo.translate(0.18, 0, 0);

  const segMesh = new THREE.InstancedMesh(segGeo, flat(shade(P.leaf, 1.25), 0.6), totalSegs);
  const nodeMesh = new THREE.InstancedMesh(nodeGeo, flat(P.moss, 0.7, { side: THREE.DoubleSide }), totalSegs);
  const LEAVES_PER = 14;
  const leafMesh = new THREE.InstancedMesh(leafGeo, flat(P.leaf, 0.8, { side: THREE.DoubleSide }), stalks.length * LEAVES_PER);
  segMesh.castShadow = true;
  leafMesh.castShadow = true;
  const color = new THREE.Color();
  let k = 0;
  stalks.forEach((s, si) => {
    for (let j = 0; j < s.segs; j++, k++) segMesh.setColorAt(k, color.setRGB(s.tint, s.tint, s.tint * 0.95));
    for (let j = 0; j < LEAVES_PER; j++) leafMesh.setColorAt(si * LEAVES_PER + j, color.setRGB(0.85 + rand() * 0.3, 0.9 + rand() * 0.15, 0.85));
    s.leaves = Array.from({ length: LEAVES_PER }, () => ({
      seg: s.segs - 4 + Math.floor(rand() * 4),
      yaw: rand() * Math.PI * 2,
      droop: -0.2 - rand() * 0.6,
      scale: 0.7 + rand() * 0.6,
    }));
    s.jointPos = Array.from({ length: s.segs }, () => new THREE.Vector3());
  });
  scene.add(segMesh, nodeMesh, leafMesh);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const lsc = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function update(t) {
    let si = 0, li = 0;
    for (const s of stalks) {
      const sway = Math.sin(t * 0.8 + s.phase) * 0.018 + Math.sin(t * 1.9 + s.phase * 2) * 0.006;
      p.set(s.x, 0, s.z);
      sc.set(s.radius, 1, s.radius);
      for (let j = 0; j < s.segs; j++) {
        e.set(0, 0, s.lean + sway * (j / s.segs) * 2.2);
        q.setFromEuler(e);
        m4.compose(p, q, sc);
        segMesh.setMatrixAt(si, m4);
        s.jointPos[j].copy(p);
        dir.set(0, SEG_H, 0).applyQuaternion(q);
        p.add(dir);
        m4.compose(p, q, sc);
        nodeMesh.setMatrixAt(si, m4);
        si++;
      }
      for (const leaf of s.leaves) {
        e.set(0, leaf.yaw + sway * 3, leaf.droop + sway * 4, 'YXZ');
        q.setFromEuler(e);
        m4.compose(s.jointPos[leaf.seg], q, lsc.setScalar(leaf.scale));
        leafMesh.setMatrixAt(li++, m4);
      }
    }
    segMesh.instanceMatrix.needsUpdate = true;
    nodeMesh.instanceMatrix.needsUpdate = true;
    leafMesh.instanceMatrix.needsUpdate = true;
  }
  update(0);
  return { update };
})();

// ---------------------------------------------------------------------------
// Knife: gyuto (牛刀), 21 cm blade with a curved belly, pointed tip, bolster, western handle.
// Local frame: x along the edge (heel 0 -> tip BLADE_LEN), y up to the spine, z thickness.
// Pivot at the heel / handle junction (05-model-specs).
// ---------------------------------------------------------------------------
const BLADE_LEN = 0.21;
const BLADE_H = 0.046;
const TIP_Y = 0.017;
const BELLY_START = 0.085;
const SPINE_DROP = 0.1;
const HALF_THICK = 0.0011;
const NX = SEGS * 6 + 1; // columns along the edge (shared by blade and gleam line)
const V_ROWS = [0, 0.03, 0.08, 0.2, 0.4, 0.65, 0.85, 1]; // edge -> spine (dense at the bevel)
const GLEAM_ROWS = 3; // the first rows of V_ROWS form the bevel where the gleam line lives

const edgeY = (x) => (x <= BELLY_START ? 0 : TIP_Y * Math.pow((x - BELLY_START) / (BLADE_LEN - BELLY_START), 2.1));
const spineY = (x) => (x <= SPINE_DROP ? BLADE_H - x * 0.012 : lerp(BLADE_H - SPINE_DROP * 0.012, TIP_Y, Math.pow((x - SPINE_DROP) / (BLADE_LEN - SPINE_DROP), 1.7)));
const edgeSlope = (x) => (edgeY(Math.min(BLADE_LEN, x + 0.002)) - edgeY(Math.max(0, x - 0.002))) / 0.004;

function bladeVertex(target, x, v, side) {
  const taper = 1 - 0.65 * Math.pow(x / BLADE_LEN, 2);
  // Convex grind: thin at the edge, full thickness toward the spine.
  const t = HALF_THICK * taper * (0.05 + 0.95 * Math.pow(v, 0.6));
  return target.set(x, lerp(edgeY(x), spineY(x), v), side * t);
}

function buildBladeGeometry() {
  const pos = [];
  const idx = [];
  const v3 = new THREE.Vector3();
  const NV = V_ROWS.length;
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i < NX; i++) {
      for (let j = 0; j < NV; j++) {
        bladeVertex(v3, (i / (NX - 1)) * BLADE_LEN, V_ROWS[j], side);
        pos.push(v3.x, v3.y, v3.z);
      }
    }
    for (let i = 0; i < NX - 1; i++) {
      for (let j = 0; j < NV - 1; j++) {
        const a = base + i * NV + j, b = base + (i + 1) * NV + j, c = b + 1, d = a + 1;
        if (side > 0) idx.push(a, b, c, a, c, d);
        else idx.push(a, c, b, a, d, c);
      }
    }
  }
  // Spine strip (own vertices so the corner stays crisp)
  const spine = pos.length / 3;
  for (let i = 0; i < NX; i++) {
    for (const side of [1, -1]) {
      bladeVertex(v3, (i / (NX - 1)) * BLADE_LEN, 1, side);
      pos.push(v3.x, v3.y, v3.z);
    }
  }
  for (let i = 0; i < NX - 1; i++) {
    const a = spine + i * 2, b = a + 2;
    idx.push(a, b + 1, b, a, a + 1, b + 1);
  }
  // Heel cap
  const heel = pos.length / 3;
  for (const side of [1, -1]) {
    for (let j = 0; j < NV; j++) {
      bladeVertex(v3, 0, V_ROWS[j], side);
      pos.push(v3.x, v3.y, v3.z);
    }
  }
  for (let j = 0; j < NV - 1; j++) idx.push(heel + j, heel + NV + j, heel + NV + j + 1, heel + j, heel + NV + j + 1, heel + j + 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** The gleaming edge line: a ribbon over the bevel, coloured per segment (one draw call, shared by both knives). */
function buildGleamGeometry() {
  const pos = [];
  const idx = [];
  const info = []; // per vertex: segment, row fraction, x
  const v3 = new THREE.Vector3();
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i < NX; i++) {
      const x = (i / (NX - 1)) * BLADE_LEN;
      for (let j = 0; j < GLEAM_ROWS; j++) {
        bladeVertex(v3, x, V_ROWS[j], side);
        pos.push(v3.x, v3.y, v3.z + side * 0.00004);
        info.push(Math.min(SEGS - 1, Math.floor((i / (NX - 1)) * SEGS)), j / (GLEAM_ROWS - 1), x / BLADE_LEN);
      }
    }
    for (let i = 0; i < NX - 1; i++) {
      for (let j = 0; j < GLEAM_ROWS - 1; j++) {
        const a = base + i * GLEAM_ROWS + j, b = a + GLEAM_ROWS;
        idx.push(a, b, b + 1, a, b + 1, a + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.length), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  geo.userData.info = new Float32Array(info);
  return geo;
}

const bladeGeo = buildBladeGeometry();
const gleamGeo = buildGleamGeometry();
const gleamMat = new THREE.MeshBasicMaterial({
  vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
});

function buildKnife() {
  const knife = new THREE.Group();
  const blade = mesh(bladeGeo, mat.blade);
  const gleam = mesh(gleamGeo, gleamMat, false, false);
  gleam.renderOrder = 2;
  const HY = BLADE_H - 0.015; // handle axis height (in line with the spine)
  const bolster = mesh(new THREE.CapsuleGeometry(0.0065, 0.016, 4, 12).scale(1.3, 1.35, 0.62), mat.steel);
  bolster.position.set(-0.004, HY - 0.003, 0);
  const handle = mesh(new THREE.CapsuleGeometry(0.0115, 0.1, 4, 14).rotateZ(Math.PI / 2).scale(1, 1, 0.72), mat.handle);
  handle.position.set(-0.07, HY, 0);
  const rivets = merged([-0.03, -0.065, -0.1].map((x) => place(new THREE.CylinderGeometry(0.0022, 0.0022, 0.0175, 8), x, HY, 0, Math.PI / 2)), mat.steel, false, false);
  const butt = mesh(new THREE.SphereGeometry(0.0085, 10, 6).scale(0.6, 1.1, 0.75), mat.steel);
  butt.position.set(-0.128, HY + 0.0005, 0);
  knife.add(blade, gleam, bolster, handle, rivets, butt);
  return knife;
}

/** Edge x (local) touched by the stone for edge coordinate u in [0, 1]. */
const edgeXAt = (u) => lerp(0.012, BLADE_LEN - 0.008, u);

// Sharpening knife: root (slides along stone) -> tilt (blade angle) -> contact (rocks onto the belly) -> knife
const knifeRoot = new THREE.Group();
knifeRoot.rotation.y = KNIFE_YAW;
knifeRoot.position.set(STATION_X, STONE_TOP + 0.0005, 0);
const knifeTilt = new THREE.Group();
const knifeContact = new THREE.Group();
const sharpKnife = buildKnife();
knifeRoot.add(knifeTilt);
knifeTilt.add(knifeContact);
knifeContact.add(sharpKnife);
onTable.add(knifeRoot);

// Test-cut knife. slashRig sits at the target's cut centre, tilted so its local y runs up the cut
// plane; chopRig.position.y = distance of the edge from that centre along the slash line.
const slashRig = new THREE.Group();
slashRig.rotation.z = CUT_TILT;
const chopRig = new THREE.Group();
chopRig.rotation.y = Math.PI / 2; // blade plane = the cut plane, edge pointing down the slash
const chopKnife = buildKnife();
chopKnife.position.x = -0.09; // centre the edge over the target
chopRig.add(chopKnife);
chopRig.visible = false;
slashRig.add(chopRig);
stage.add(slashRig);

// Chopping block on the stage
const BLOCK_H = 0.05;
{
  const block = mesh(new THREE.CylinderGeometry(0.17, 0.18, BLOCK_H, 12), mat.wood);
  block.position.y = BLOCK_H / 2;
  stage.add(block);
}

// ---------------------------------------------------------------------------
// Particles (sparks, water droplets, gleam glints): pooled, allocation-free
// ---------------------------------------------------------------------------
function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const dotTex = makeDotTexture();

class Particles {
  constructor(max, { size, additive, gravity }) {
    this.max = max;
    this.gravity = gravity;
    this.pos = new Float32Array(max * 3).fill(-999);
    this.col = new Float32Array(max * 4);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.base = new Float32Array(max * 3);
    this.cursor = 0;
    this.alive = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size, map: dotTex, vertexColors: true, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(p, v, color, life) {
    const i = this.cursor;
    const i3 = i * 3;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.base[i3] = color.r; this.base[i3 + 1] = color.g; this.base[i3 + 2] = color.b;
    this.life[i] = this.maxLife[i] = life;
    this.alive = this.max;
  }

  update(dt, floorY) {
    if (!this.alive) return; // nothing to simulate or upload
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3, i4 = i * 4;
      if (this.life[i] <= 0) {
        this.pos[i3 + 1] = -999;
        this.col[i4 + 3] = 0;
        continue;
      }
      alive++;
      this.vel[i3 + 1] -= this.gravity * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < floorY) {
        this.pos[i3 + 1] = floorY;
        this.vel[i3 + 1] *= -0.3;
        this.vel[i3] *= 0.5;
        this.vel[i3 + 2] *= 0.5;
      }
      this.col[i4] = this.base[i3];
      this.col[i4 + 1] = this.base[i3 + 1];
      this.col[i4 + 2] = this.base[i3 + 2];
      this.col[i4 + 3] = Math.min(1, (this.life[i] / this.maxLife[i]) * 1.5);
    }
    this.alive = alive;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

// Pool sizes: <= 150 per system on mobile.
const sparks = new Particles(isMobile ? 120 : 220, { size: 0.012, additive: true, gravity: 5 });
const drops = new Particles(isMobile ? 100 : 180, { size: 0.01, additive: false, gravity: 4 });
const glints = new Particles(isMobile ? 30 : 60, { size: 0.016, additive: true, gravity: 0.3 });
const tmpV = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const SPARK_COLORS = ['#ffd27a', '#ffb347', '#fff2c4'].map((c) => new THREE.Color(c));
const HEAT_COLORS = [CLIMAX.heat, new THREE.Color('#fff2c4')];
const DROP_COLOR = new THREE.Color('#cfe8ff');
const ICE_COLOR = new THREE.Color('#E8F1F8');
const STRAW_COLORS = ['#DCD3C3', '#B08A63', '#C9D8C5'].map((c) => new THREE.Color(c));
const CHIP_COLORS = ['#7C7A75', '#5C5650', '#DCD3C3'].map((c) => new THREE.Color(c));
// Slurry (研ぎ汁): muddy grey droplets tinted by each stone (stone colour mixed with palette stone grey)
const SLURRY_GREY = new THREE.Color('#7C7A75');
const SLURRY_COLORS = STONES.map((d) => [0.55, 0.75].map((k) => new THREE.Color(d.color).lerp(SLURRY_GREY, k).multiplyScalar(0.85)));
const GLINT_COLORS = [CLIMAX.gleam, new THREE.Color('#ffffff')];

function burst(system, at, n, speed, colors, life) {
  for (let i = 0; i < n; i++) {
    tmpV.set((Math.random() - 0.5) * 2, Math.random() * 1.2, (Math.random() - 0.5) * 2).multiplyScalar(speed);
    system.emit(at, tmpV, colors[i % colors.length], life * (0.6 + Math.random() * 0.6));
  }
}

// ---------------------------------------------------------------------------
// Audio (WebAudio, unlocked on first gesture for iOS)
// ---------------------------------------------------------------------------
const audio = {
  ctx: null,
  // Must be called from a user-activation event (pointerup / touchend / click / keydown);
  // touchstart does not count on iOS Safari or Chrome.
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Sparse clicks = the "grit" crackle of a coarse stone.
    this.gritBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const gd = this.gritBuf.getChannelData(0);
    for (let n = 0; n < 900; n++) {
      const at = (Math.random() * (gd.length - 40)) | 0;
      const amp = (Math.random() < 0.5 ? -1 : 1) * (0.3 + Math.random() * 0.7);
      for (let j = 0; j < 30; j++) gd[at + j] += amp * Math.exp(-j / 5) * (Math.random() * 2 - 1);
    }
    // Continuous grind = body (bandpass noise) + grit crackle (highpassed clicks) + hiss (high band).
    const layer = (buffer, type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start(0, Math.random() * buffer.duration);
      return { f, g };
    };
    this.body = layer(this.noise, 'bandpass', 900, 0.9);
    this.grit = layer(this.gritBuf, 'highpass', 1800, 0.7);
    this.hiss = layer(this.noise, 'bandpass', 4000, 1.5);
    this.grindOn = false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  },
  /**
   * Grind sound follows the stroke: level 0..1 (speed x pressure), freq = body centre (Hz),
   * timbre = the active stone's sound table. Ramped with setTargetAtTime so it never zips.
   */
  setGrind(level, freq = 500, timbre = STONES[0].sound, burr = 0) {
    if (!this.ctx) return;
    if (level <= 0 && !this.grindOn) return; // already silent: don't pile up automation events
    this.grindOn = level > 0;
    const t = this.ctx.currentTime;
    const s = timbre;
    this.body.g.gain.setTargetAtTime(level * 0.55 * s.gain, t, 0.05);
    this.body.f.frequency.setTargetAtTime(freq, t, 0.06);
    this.body.f.Q.setTargetAtTime(s.q, t, 0.1);
    this.grit.g.gain.setTargetAtTime(level * s.gain * (s.grit + burr * 0.4), t, 0.04);
    this.grit.f.frequency.setTargetAtTime(1400 + freq * 0.8, t, 0.08);
    this.hiss.g.gain.setTargetAtTime(level * (s.hiss + burr * 0.05), t, 0.06);
    this.hiss.f.frequency.setTargetAtTime(s.hissF * (0.85 + level * 0.3), t, 0.08);
  },
  noiseBurst(duration, type, f0, f1, vol) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + duration + 0.05);
  },
  tone(freq, duration, vol, type = 'sine', delay = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + duration + 0.05);
  },
  /** 刃鳴 (the "DING"): a struck-steel bell with inharmonic partials. Pitch climbs with the level. */
  ding(level, segment) {
    if (!this.ctx) return;
    const f = 1320 * Math.pow(2, (level * 3 + (segment % 3)) / 12);
    this.tone(f, 1.1, 0.16);
    this.tone(f * 2.76, 0.6, 0.05);
    this.tone(f * 5.4, 0.25, 0.025);
  },
  /** The whole edge reached a new stage: short rising arpeggio. */
  chime(level) {
    if (!this.ctx) return;
    const root = 880 * Math.pow(2, (level * 2) / 12);
    [0, 4, 7, 12].forEach((s, i) => this.tone(root * Math.pow(2, s / 12), 0.9, 0.12, 'sine', i * 0.07));
  },
  tick(high) {
    if (!this.ctx) return;
    this.tone(high ? 1800 : 1100, 0.06, 0.05, 'triangle');
  },
  touch() {
    if (!this.ctx) return;
    this.noiseBurst(0.06, 'bandpass', 2400, 1200, 0.18);
    this.tone(640, 0.08, 0.05, 'triangle');
  },
  click() {
    if (!this.ctx) return;
    this.tone(520, 0.08, 0.1, 'triangle');
    this.tone(1040, 0.05, 0.04);
  },
  slice() {
    if (!this.ctx) return;
    this.noiseBurst(0.22, 'highpass', 1500, 7000, 0.5);
    this.tone(2600, 0.5, 0.08);
    this.tone(3900, 0.35, 0.04);
  },
  clank() {
    if (!this.ctx) return;
    this.tone(190, 0.35, 0.3, 'triangle');
    this.tone(523, 0.5, 0.12, 'square');
    this.noiseBurst(0.12, 'lowpass', 3000, 400, 0.4);
  },
  whoosh() {
    if (!this.ctx) return;
    this.noiseBurst(0.18, 'bandpass', 400, 2200, 0.25);
  },
  /** Temple-bell strike (inharmonic partials, long decay): a new test-cut target unlocked. */
  bell() {
    if (!this.ctx) return;
    const f = 392;
    [[1, 2.6, 0.2], [2.0, 1.8, 0.07], [2.76, 1.4, 0.07], [5.4, 0.7, 0.03], [8.9, 0.35, 0.015]]
      .forEach(([r, d, v]) => this.tone(f * r, d, v));
    this.tone(f * 1.003, 2.6, 0.08); // slight beating, like a real bell
    this.noiseBurst(0.05, 'bandpass', 3000, 1500, 0.12);
  },
  /** Blade bounces off: bright clink + dull knock. */
  clink() {
    if (!this.ctx) return;
    this.tone(2900, 0.35, 0.12, 'triangle');
    this.tone(4350, 0.2, 0.05);
    this.tone(160, 0.25, 0.25, 'triangle');
    this.noiseBurst(0.08, 'highpass', 4000, 2000, 0.25);
  },
  /** Low swell as time slows down. */
  slowmo() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 1.05);
    this.noiseBurst(0.9, 'lowpass', 1200, 200, 0.12);
  },
  /** Stone set into the holder. */
  stoneSwap() {
    if (!this.ctx) return;
    this.tone(210, 0.12, 0.18, 'triangle');
    this.noiseBurst(0.07, 'lowpass', 1800, 300, 0.3);
  },
  /** Heavy target: low boom under the slice. */
  boom(weight) {
    if (!this.ctx) return;
    this.tone(70 + 30 / (1 + weight), 0.5 + weight * 0.1, 0.3, 'sine');
    this.noiseBurst(0.3, 'lowpass', 900, 120, 0.25 + weight * 0.05);
  },
};

// ---------------------------------------------------------------------------
// Tweens
// ---------------------------------------------------------------------------
const tweens = new Set();
let timeScale = 1; // < 1 during the test-cut slow motion
/** real = advance on wall-clock time (ignores slow motion and the hitstop freeze). */
function tween(duration, fn, ease = (t) => t, real = false) {
  return new Promise((resolve) => tweens.add({ t: 0, duration, fn, ease, resolve, real }));
}
const wait = (s) => tween(s, () => {});
const waitReal = (s) => tween(s, () => {}, undefined, true);
function updateTweens(gameDt, realDt) {
  for (const tw of tweens) {
    tw.t += tw.real ? realDt : gameDt;
    const k = Math.min(1, tw.t / tw.duration);
    tw.fn(tw.ease(k));
    if (k >= 1) {
      tweens.delete(tw);
      tw.resolve();
    }
  }
}

// ---------------------------------------------------------------------------
// HUD (DOM writes only when a value changes)
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
  sharpFill: $('sharpFill'), sharpText: $('sharpText'),
  angleLight: $('angleLight'), angleText: $('angleText'), angleTarget: $('angleTarget'),
  pressFill: $('pressFill'), pressZone: $('pressZone'), pressText: $('pressText'),
  segs: $('edgeSegs'),
  hint: $('hint'), testBtn: $('testBtn'), toast: $('toast'),
  result: $('result'), resultTitle: $('resultTitle'), resultBody: $('resultBody'),
  againBtn: $('againBtn'), restartBtn: $('restartBtn'), nextBtn: $('nextBtn'),
  slider: $('angleSlider'), hud: $('hud'), bottom: $('bottom'),
  stones: $('stones'), targets: $('targets'), ticks: $('sharpTicks'), capMark: $('capMark'),
  bars: [$('cineTop'), $('cineBottom'), $('cineLeft'), $('cineRight')],
  title: $('title'), order: $('order'), orderHud: $('orderHud'), menuBtn: $('menuBtn'),
  startBtn: $('startBtn'), freeBtn: $('freeBtn'), acceptBtn: $('acceptBtn'), orderBackBtn: $('orderBackBtn'),
  orderNo: $('orderNo'), orderName: $('orderName'), orderFrom: $('orderFrom'), orderLine: $('orderLine'),
  orderKnife: $('orderKnife'), orderTarget: $('orderTarget'),
  resultScore: $('resultScore'), retryBtn: $('retryBtn'), nextOrderBtn: $('nextOrderBtn'), titleBtn: $('titleBtn'),
};
for (const t of TARGETS) {
  if (t.need <= 0) continue;
  const tick = document.createElement('i');
  tick.style.left = `${t.need * 100}%`;
  ui.ticks.appendChild(tick);
}
const stoneBtns = STONES.map((d) => {
  const b = document.createElement('button');
  b.innerHTML = `<b>${d.name}</b><small>${d.grit}</small><i style="background:${d.color}"></i>`;
  b.setAttribute('aria-label', `${d.name}砥石 ${d.grit}`);
  ui.stones.appendChild(b);
  return b;
});
const targetBtns = TARGETS.map((t) => {
  const b = document.createElement('button');
  b.innerHTML = `<span>${t.name}</span><small></small>`;
  ui.targets.appendChild(b);
  return b;
});
const sliderThumb = ui.slider.querySelector('.thumb');
const sliderTrack = ui.slider.querySelector('.track');
const sliderZone = ui.slider.querySelector('.zone');
const angleToPct = (a) => (1 - (a - ANGLE_MIN) / (ANGLE_MAX - ANGLE_MIN)) * 100;
ui.pressZone.style.left = `${PRESS_LO * 100}%`;
ui.pressZone.style.width = `${(PRESS_HI - PRESS_LO) * 100}%`;
sliderZone.style.top = `${angleToPct(BAND_HI)}%`;
sliderZone.style.height = `${angleToPct(BAND_LO) - angleToPct(BAND_HI)}%`;
ui.angleTarget.textContent = `目標 ${BAND_LO}°–${BAND_HI}°`;
const segEls = Array.from({ length: SEGS }, () => {
  const el = document.createElement('i');
  el.appendChild(document.createElement('b'));
  ui.segs.appendChild(el);
  return el;
});
const DEFAULT_HINT = ui.hint.textContent;

const domCache = new Map();
function setDom(el, prop, value) {
  let cache = domCache.get(el);
  if (!cache) domCache.set(el, (cache = {}));
  if (cache[prop] === value) return;
  cache[prop] = value;
  if (prop === 'text') el.textContent = value;
  else if (prop === 'class') el.className = value;
  else el.style[prop] = value;
}

let toastTimer = 0;
function toast(text, seconds = 0.9) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), seconds * 1000);
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const game = {
  mode: 'sharpen', // 'sharpen' | 'test' | 'result'
  shortMask: 0, // bit i: target i is unlocked but current sharpness is below its need
  sharpness: 0,
  angle: START_ANGLE,
  pressure: 0,
  knifeX: 0,
  knifeTargetX: 0,
  speed: 0,
  hold: 0,
  wet: 0,
  hintTimer: 0,
  sparkAcc: 0,
  dropAcc: 0,
  inBand: false,
  burr: 0,
  edgeU: 0.5,
  stage: 0, // lowest segment level reached across the whole edge
  stone: 0, // index into STONES
  unlocked: 0, // highest unlocked target index (sticky: dulling doesn't re-lock)
  selected: 0, // target chosen for the next test cut
  best: -1, // best target index cut so far
  lastDir: 0,
  wearTimer: 0,
};
// Cinematic state (exposed through window.__knife for headless tests)
const cine = {
  phase: 'idle', // idle | enter | windup | slash | freeze | split | recoil | result | exit
  bars: 0, // letterbox amount 0..1 (1 = visible area exactly LETTERBOX_ASPECT)
  target: null, // id of the target on stage during the cinematic
  lastHitstopMs: 0,
  lastResult: null,
};
// Game flow: title -> order -> sharpen -> cut -> result (order mode), or title -> sharpen (free mode).
const flow = {
  screen: 'title', // title | order | sharpen | cut | result
  mode: null, // null (on the title) | 'order' | 'free'
  completed: 0, // successful orders; sets the next order's difficulty
  order: null, // { no, customer, from, knife, line, targetIdx, target, targetName, need, done }
  ready: false, // order mode: sharpness has reached the order's requirement
  result: null, // last order result { success, score, rank, parts }
};
// Per-order grinding stats (edge units travelled while grinding; 1 = one full pass along the edge)
const stats = { dist: 0, angleDist: 0, pressDist: 0, strokes: 0, goalDist: -1 }; // goalDist: dist when the margin goal was reached
const seg = {
  progress: new Float32Array(SEGS),
  level: new Uint8Array(SEGS),
  flash: new Float32Array(SEGS),
  norm: new Float32Array(SEGS),
  shown: new Int16Array(SEGS).fill(-1),
};
const segCenter = (i) => (i + 0.5) / SEGS;
const segWeight = (i, u) => Math.max(0, 1 - Math.abs(segCenter(i) - u) / SEG_WINDOW);
// Normalise so every segment (even the end ones) gains GAIN_PER_PASS per full pass.
for (let i = 0; i < SEGS; i++) {
  let s = 0;
  for (let k = 0; k <= 400; k++) s += segWeight(i, k / 400) / 401;
  seg.norm[i] = s;
}

/** 1 inside the sweet band, smoothly less outside it, never zero (no fail state). */
function angleEfficiency(a) {
  const d = a < BAND_LO ? BAND_LO - a : a > BAND_HI ? a - BAND_HI : 0;
  return d === 0 ? 1 : Math.max(0.06, 0.55 * (1 - d / 6));
}
/** Pressure curve: too light = slow, sweet middle, too heavy = burr and slower. */
function pressureEfficiency(p) {
  if (p < PRESS_LO) return 0.12 + 0.88 * Math.pow(p / PRESS_LO, 1.5);
  if (p <= PRESS_HI) return 1;
  return Math.max(0.3, 1 - ((p - PRESS_HI) / (1 - PRESS_HI)) * 0.7);
}
const angleState = () => (game.angle >= BAND_LO && game.angle <= BAND_HI ? 'good' : game.angle >= BAND_LO - 3 && game.angle <= BAND_HI + 3 ? 'near' : 'bad');
const pressureOK = () => game.pressure >= PRESS_LO && game.pressure <= PRESS_HI;

function setAngle(a) {
  game.angle = clamp(a, ANGLE_MIN, ANGLE_MAX);
}
/** Player input reaches the knife only on the sharpening screen (not behind the title / order card). */
const canSharpen = () => game.mode === 'sharpen' && flow.screen === 'sharpen';

// ---------------------------------------------------------------------------
// Input (pointer events; touch-action: none on the canvas and controls)
// ---------------------------------------------------------------------------
let drag = null; // primary pointer: x -> stroke, y -> angle
let second = null; // secondary pointer: y -> angle
let sliderPointer = null;

function stonePixelsPerUnit() {
  // A full stroke should be a comfortable thumb swipe: 35-60% of the screen width.
  return (window.innerWidth * 0.45) / (KNIFE_TRAVEL * 2);
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (e.pointerType === 'mouse' || audio.ctx) audio.unlock();
  if (!canSharpen()) return;
  try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  if (!drag) {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ppu: stonePixelsPerUnit() };
    game.hold = 0;
    audio.touch();
    knifeRoot.getWorldPosition(tmpP);
    burst(drops, tmpP, 6, 0.25, [DROP_COLOR], 0.5);
  } else if (!second) {
    second = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
}, { passive: false });

canvas.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId === drag.id) {
    e.preventDefault();
    game.knifeTargetX = clamp(game.knifeTargetX + (e.clientX - drag.x) / drag.ppu, -KNIFE_TRAVEL, KNIFE_TRAVEL);
    if (!second) setAngle(game.angle + (drag.y - e.clientY) * ANGLE_PER_PX);
    drag.x = e.clientX;
    drag.y = e.clientY;
  } else if (second && e.pointerId === second.id) {
    e.preventDefault();
    setAngle(game.angle + (second.y - e.clientY) * ANGLE_PER_PX);
    second.x = e.clientX;
    second.y = e.clientY;
  }
}, { passive: false });

function endPointer(e) {
  if (drag && e.pointerId === drag.id) {
    // Promote the second finger to primary so a stroke can continue seamlessly.
    drag = second ? { id: second.id, x: second.x, y: second.y, ppu: drag.ppu } : null;
    second = null;
  } else if (second && e.pointerId === second.id) {
    second = null;
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('lostpointercapture', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (canSharpen()) setAngle(game.angle - Math.sign(e.deltaY) * 0.5);
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!canSharpen()) return;
  if (e.key === 'ArrowUp') setAngle(game.angle + 0.5);
  if (e.key === 'ArrowDown') setAngle(game.angle - 0.5);
});
// iOS Safari: block pinch / double-tap zoom and rubber-band scrolling.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = performance.now();
  if (now - lastTouchEnd < 300 && e.target === canvas) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
['pointerup', 'touchend', 'click', 'keydown'].forEach((type) => window.addEventListener(type, () => audio.unlock(), { passive: true }));

// Secondary angle slider (works alongside the stroke finger)
function sliderSet(e) {
  const r = sliderTrack.getBoundingClientRect();
  setAngle(ANGLE_MAX - ((e.clientY - r.top) / r.height) * (ANGLE_MAX - ANGLE_MIN));
}
ui.slider.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (e.pointerType === 'mouse' || audio.ctx) audio.unlock();
  if (!canSharpen()) return;
  sliderPointer = e.pointerId;
  try { ui.slider.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  audio.tick(false);
  sliderSet(e);
}, { passive: false });
ui.slider.addEventListener('pointermove', (e) => {
  if (e.pointerId === sliderPointer) sliderSet(e);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  ui.slider.addEventListener(type, (e) => { if (e.pointerId === sliderPointer) sliderPointer = null; });
}

function onButton(el, fn) {
  el.addEventListener('click', () => {
    audio.unlock();
    audio.click();
    fn();
  });
}
onButton(ui.testBtn, () => { if (canSharpen()) runTest(TARGETS[cutIdx()].id); });
onButton(ui.againBtn, () => backToSharpen(false));
onButton(ui.restartBtn, () => backToSharpen(true));
onButton(ui.nextBtn, () => { if (game.mode === 'result') runTest(TARGETS[game.selected].id); });
onButton(ui.startBtn, () => startOrder());
onButton(ui.freeBtn, () => startFree());
onButton(ui.acceptBtn, () => acceptOrder());
onButton(ui.orderBackBtn, () => showTitle());
onButton(ui.menuBtn, () => showTitle());
onButton(ui.retryBtn, () => backToSharpen(false));
onButton(ui.nextOrderBtn, () => startOrder());
onButton(ui.titleBtn, () => showTitle());
stoneBtns.forEach((b, i) => b.addEventListener('click', () => { audio.unlock(); if (flow.screen === 'sharpen') selectStone(i); }));
targetBtns.forEach((b, i) => b.addEventListener('click', () => {
  audio.unlock();
  if (!canSharpen() || flow.mode === 'order') return;
  if (i > game.unlocked) {
    audio.tick(false);
    toast(`需要鋒利度 ${Math.round(TARGETS[i].need * 100)}%`, 1.1);
    return;
  }
  audio.click();
  selectTarget(i);
}));

// ---------------------------------------------------------------------------
// Sharpening simulation
// ---------------------------------------------------------------------------
const contact = new THREE.Vector3();
let lastAngleDeg = Math.round(START_ANGLE);
let stoneSwitching = false;
let stoneSwap = null; // resolves when the current stone swap tween ends

function onSegmentLevel(i, level) {
  seg.flash[i] = 1;
  audio.ding(level, i);
  // glints at that part of the edge
  const x = edgeXAt(segCenter(i));
  sharpKnife.localToWorld(tmpP.set(x, edgeY(x) + 0.002, 0));
  burst(glints, tmpP, 5 + level * 2, 0.12, GLINT_COLORS, 0.5);
  let stage = SEG_LEVELS.length;
  for (let k = 0; k < SEGS; k++) stage = Math.min(stage, seg.level[k]);
  if (stage > game.stage) {
    game.stage = stage;
    audio.chime(stage);
    toast(stage >= SEG_LEVELS.length ? '刃鳴！全刃完成' : `全刃 第 ${stage} 段`, 1.1);
  }
}

function selectStone(i, instant = false) {
  if (i < 0 || i >= STONES.length) return;
  if (!instant && (i === game.stone || stoneSwitching || game.mode !== 'sharpen')) return;
  const from = stones.map((s) => s.slot);
  game.stone = i;
  const def = STONES[i];
  stoneBtns.forEach((b, k) => b.classList.toggle('on', k === i));
  ui.capMark.style.display = def.cap >= 1 ? 'none' : '';
  ui.capMark.style.left = `${def.cap * 100}%`;
  if (instant) {
    placeStones(i);
    return;
  }
  audio.click();
  stoneSwitching = true;
  drag = second = null; // lift the knife while the stones swap
  audio.setGrind(0);
  toast(`${def.name}砥 ${def.grit}`, 0.8);
  stoneSwap = tween(0.35, (k) => placeStones(i, k, from), easeInOut).then(() => {
    stoneSwitching = false;
    audio.stoneSwap();
    knifeRoot.getWorldPosition(tmpP);
    burst(drops, tmpP, 6, 0.3, SLURRY_COLORS[i], 0.5);
  });
}

function refreshTargets() {
  targetBtns.forEach((b, i) => {
    const t = TARGETS[i];
    const locked = i > game.unlocked;
    b.classList.toggle('locked', locked);
    b.classList.toggle('on', i === game.selected);
    const short = !locked && game.sharpness < t.need - 1e-6; // unlocks are permanent; the edge may have dulled since
    b.classList.toggle('short', short);
    b.lastChild.textContent = locked ? `🔒${Math.round(t.need * 100)}%` : short ? `不足 ${Math.round(t.need * 100)}%` : i <= game.best ? '✓ 已斬' : t.need > 0 ? `${Math.round(t.need * 100)}%` : '入門';
    b.setAttribute('aria-label', locked ? `${t.name}（需要鋒利度 ${Math.round(t.need * 100)}%）` : short ? `${t.name}（目前鋒利度不足，需要 ${Math.round(t.need * 100)}%）` : t.name);
  });
  ui.testBtn.textContent = `試刀・${TARGETS[cutIdx()].name}`;
}

/** Target the test-cut button cuts: the order's target in order mode, otherwise the selected chip. */
const cutIdx = () => (flow.mode === 'order' && flow.order ? flow.order.targetIdx : game.selected);

function selectTarget(i) {
  game.selected = clamp(i, 0, game.unlocked);
  refreshTargets();
  showStageTarget(game.selected);
}

/** Sticky unlocks: crossing a threshold rings the bell and selects the new target (free mode; silent in order mode). */
function checkUnlocks(quiet = flow.mode === 'order') {
  let changed = false;
  while (game.unlocked < TARGETS.length - 1 && game.sharpness >= TARGETS[game.unlocked + 1].need - 1e-6) {
    game.unlocked++;
    changed = true;
    if (!quiet) {
      audio.bell();
      toast(`解鎖試刀：${TARGETS[game.unlocked].name}`, 1.5);
      const b = targetBtns[game.unlocked];
      b.classList.remove('fresh');
      void b.offsetWidth; // restart the CSS animation
      b.classList.add('fresh');
    }
  }
  if (changed) {
    if (flow.mode === 'order') refreshTargets(); // the order fixes the target; chips are hidden
    else selectTarget(game.unlocked);
  }
  // Refresh the labels when an unlocked target drops below / climbs back over its requirement.
  let mask = 0;
  for (let i = 1; i <= game.unlocked; i++) if (game.sharpness < TARGETS[i].need - 1e-6) mask |= 1 << i;
  if (mask !== game.shortMask) {
    game.shortMask = mask;
    if (!changed) refreshTargets();
  }
}

function recomputeSharpness() {
  let sum = 0;
  for (let i = 0; i < SEGS; i++) sum += seg.progress[i];
  game.sharpness = sum / SEGS;
}

/** A successful cut costs a little edge (levels/dings already earned are kept). */
function dullEdge(amount) {
  if (amount <= 0) return;
  for (let i = 0; i < SEGS; i++) seg.progress[i] = Math.max(0, seg.progress[i] - amount);
  recomputeSharpness();
  setKnifeFinish(game.sharpness);
}

function updateSharpening(dt, t) {
  const st = STONES[game.stone];
  const stone = stones[game.stone];
  const down = !!drag && !stoneSwitching;
  const prevX = game.knifeX;
  game.knifeX = damp(game.knifeX, game.knifeTargetX, 22, dt);
  // Speed normalised to a 0.42 m stroke so the pressure feel doesn't depend on the stone length.
  const v = ((game.knifeX - prevX) / Math.max(dt, 1e-4)) * (0.42 / (KNIFE_TRAVEL * 2));
  // Rise fast, fall slowly: the brief stop at each stroke reversal shouldn't knock pressure out of the zone.
  game.speed = damp(game.speed, Math.abs(v), Math.abs(v) > game.speed ? 10 : 2.5, dt);

  // Pressure: leaning in while held, plus stroke speed.
  game.hold = down ? Math.min(1, game.hold + dt * 2.5) : 0;
  const targetPressure = down ? 0.25 * game.hold + game.speed * 0.7 : 0;
  game.pressure = damp(game.pressure, clamp(targetPressure, 0, 1), down ? 5 : 4, dt);

  const grinding = down && game.speed > 0.04;
  if (grinding) {
    // Hands are never perfectly steady: a little drift the player must correct.
    setAngle(game.angle + (Math.sin(t * 1.3) + Math.sin(t * 2.9 + 1)) * 0.9 * dt);
    stone.wet01 = Math.min(1, stone.wet01 + dt * 0.5);
  }
  for (const s of stones) {
    if (s !== stone || !grinding) s.wet01 = Math.max(0, s.wet01 - dt * 0.04);
    s.material.roughness = lerp(0.85, 0.3, s.wet01);
    s.material.color.lerpColors(s.dry, s.wet, s.wet01);
  }

  // Edge coverage: the part of the edge on the stone follows the stroke position.
  const prevU = game.edgeU;
  game.edgeU = (game.knifeX + KNIFE_TRAVEL) / (KNIFE_TRAVEL * 2);
  const du = Math.abs(game.edgeU - prevU);
  game.burr = damp(game.burr, grinding && game.pressure > PRESS_HI ? 1 : 0, 3, dt);
  const stoneX = game.knifeX * 0.75; // contact point in stone-local x
  if (grinding && du > 0) {
    const eff = angleEfficiency(game.angle) * pressureEfficiency(game.pressure) * st.rate;
    stats.dist += du;
    if (game.angle >= BAND_LO && game.angle <= BAND_HI) stats.angleDist += du;
    if (pressureOK()) stats.pressDist += du;
    for (let i = 0; i < SEGS; i++) {
      const w = segWeight(i, game.edgeU);
      if (w <= 0) continue;
      const p = seg.progress[i];
      const room = st.cap - p;
      if (room <= 0) continue; // this grit can't refine the edge any further
      // Slows in the last third of the stone's range so the cap is approached, not slammed into.
      const ease = 0.3 + 0.7 * Math.min(1, (room / st.cap) * 3);
      seg.progress[i] = Math.min(st.cap, p + ((du * eff * GAIN_PER_PASS * w) / seg.norm[i]) * (1 - 0.55 * p) * ease);
      while (seg.level[i] < SEG_LEVELS.length && seg.progress[i] >= SEG_LEVELS[seg.level[i]] - 1e-6) {
        seg.level[i]++;
        onSegmentLevel(i, seg.level[i]);
      }
    }
    // Stone wear: a gaussian contact patch dishes the top where the blade rides.
    const amt = du * (0.3 + game.pressure) * st.wear * WEAR_RATE;
    const inv = 1 / (2 * WEAR_SIGMA * WEAR_SIGMA);
    for (let c = 0; c <= WEAR_COLS; c++) {
      const dx = -STONE_LEN / 2 + (c / WEAR_COLS) * STONE_LEN - stoneX;
      stone.wear[c] = Math.min(1, stone.wear[c] + amt * Math.exp(-dx * dx * inv));
    }
    stone.dirty = true;
  }
  game.wearTimer -= dt;
  if (game.wearTimer <= 0 && stone.dirty) {
    game.wearTimer = 0.2; // throttled: a few geometry updates per second is plenty for slow wear
    applyStoneWear(stone);
  }
  recomputeSharpness();
  checkUnlocks();
  if (flow.mode === 'order' && flow.order) {
    if (stats.goalDist < 0 && game.sharpness >= flow.order.goal - 1e-6) stats.goalDist = stats.dist;
    const ready = game.sharpness >= flow.order.need - 1e-6;
    if (ready !== flow.ready) {
      flow.ready = ready;
      updateOrderHud();
      if (ready && flow.screen === 'sharpen') {
        audio.bell();
        toast('已達委託要求・可以試刀了', 1.5);
      }
    }
  }

  // Angle band entry feedback, and a soft tick per degree while steering outside it
  const inBand = angleState() === 'good';
  if (inBand !== game.inBand) {
    game.inBand = inBand;
    if (inBand) audio.tick(true);
  }
  const deg = Math.round(game.angle);
  if (deg !== lastAngleDeg && !inBand && (drag || sliderPointer !== null)) audio.tick(false);
  lastAngleDeg = deg;

  // Knife pose: the contact point on the edge rides the (possibly dished) stone; the belly rocks onto it.
  const ex = edgeXAt(game.edgeU);
  knifeRoot.position.x = STATION_X + stoneX;
  knifeRoot.position.y = STONE_TOP + 0.0005 - (stoneSwitching ? 0 : stoneDishAt(stone, stoneX));
  knifeRoot.position.z = Math.sin(game.knifeX * 18) * 0.004;
  knifeTilt.rotation.x = THREE.MathUtils.degToRad(90 - game.angle);
  knifeContact.rotation.z = -Math.atan(edgeSlope(ex));
  sharpKnife.position.set(-ex, -edgeY(ex), 0);
  setKnifeFinish(game.sharpness);

  // Particles at the contact point: sparks on the coarse stone, muddy slurry on medium / fine.
  knifeRoot.getWorldPosition(contact);
  if (grinding) {
    const dirX = Math.sign(v) || 1;
    const slurry = SLURRY_COLORS[game.stone];
    if (dirX !== game.lastDir) stats.strokes++; // one stroke per push / pull
    if (game.lastDir && dirX !== game.lastDir && game.speed > 0.15 && st.fx === 'slurry') {
      burst(drops, contact, 4, 0.35, slurry, 0.45); // splash at the stroke reversal
    }
    game.lastDir = dirX;
    const drive = game.speed * (0.3 + game.pressure);
    if (st.fx === 'spark') {
      game.sparkAcc += dt * drive * 110 * (1 + game.burr * 2);
      while (game.sparkAcc >= 1) {
        game.sparkAcc -= 1;
        tmpV.set(-dirX * (0.5 + Math.random() * 1.3), 0.3 + Math.random() * 1.1, (Math.random() - 0.5) * 0.9);
        sparks.emit(contact, tmpV, SPARK_COLORS[(Math.random() * 3) | 0], 0.12 + Math.random() * 0.25);
      }
    }
    game.dropAcc += dt * drive * (st.fx === 'spark' ? 18 : game.stone === 1 ? 85 : 55);
    while (game.dropAcc >= 1) {
      game.dropAcc -= 1;
      tmpP.copy(contact).add(tmpV.set((Math.random() - 0.5) * 0.08, 0.002, (Math.random() - 0.5) * 0.05));
      tmpV.set(dirX * (0.2 + Math.random() * 0.5) * game.speed * 1.6, 0.2 + Math.random() * 0.5, (Math.random() - 0.5) * 0.35);
      drops.emit(tmpP, tmpV, slurry[(Math.random() * 2) | 0], 0.45 + Math.random() * 0.4);
    }
  } else {
    game.lastDir = 0;
  }

  // Grind sound: level follows speed x pressure, pitch follows speed; timbre per grit; rougher with a burr.
  const sd = st.sound;
  const level = grinding ? Math.min(1, game.speed * 1.3) * (0.35 + 0.65 * game.pressure) * (inBand ? 1 : 0.75) : 0;
  const freq = lerp(sd.f0, sd.f1, clamp(game.speed, 0, 1)) * (0.9 + game.pressure * 0.25) * (inBand ? 1.08 : 0.92) * (1 - game.burr * 0.3);
  audio.setGrind(level, freq, sd, game.burr);

  // Coaching hint (throttled to avoid flicker); gentle tone, never "fail".
  game.hintTimer -= dt;
  if (game.hintTimer <= 0) {
    game.hintTimer = 0.3;
    const capped = st.cap < 1 && game.sharpness >= st.cap - 0.01;
    let msg = DEFAULT_HINT;
    if (down) {
      if (game.angle > BAND_HI) msg = '角度稍陡 ↓ 手指往下一點';
      else if (game.angle < BAND_LO) msg = '角度稍平 ↑ 手指往上一點';
      else if (capped) msg = `${st.name}砥最多磨到 ${Math.round(st.cap * 100)}%，換更細的砥石`;
      else if (!grinding) msg = '角度剛好，左右來回推！';
      else if (game.pressure < PRESS_LO) msg = '壓力偏輕，推快一點';
      else if (game.pressure > PRESS_HI) msg = '太用力會起毛邊，放慢一點';
      else msg = '很好！刃口在發亮';
    } else if (capped) {
      msg = `${st.name}砥已到極限 ${Math.round(st.cap * 100)}%，點左側換砥石`;
    } else if (game.sharpness > 0.03) {
      msg = '推到左右兩端，讓整條刃口都亮起來';
    }
    setDom(ui.hint, 'text', msg);
  }
}

function setKnifeFinish(s) {
  mat.blade.roughness = lerp(0.38, 0.12, s);
}

// Gleam line colours (both faces): segment progress + completion flash + a slow highlight sweep.
const gleamColors = gleamGeo.attributes.color;
const gleamInfo = gleamGeo.userData.info;
function updateGleam(dt, t) {
  for (let i = 0; i < SEGS; i++) seg.flash[i] = Math.max(0, seg.flash[i] - dt * 1.6);
  const arr = gleamColors.array;
  const sweep = ((t * 0.35) % 1.6) - 0.3;
  const g = CLIMAX.gleam;
  for (let k = 0, n = gleamColors.count; k < n; k++) {
    const s = gleamInfo[k * 3], row = gleamInfo[k * 3 + 1], x = gleamInfo[k * 3 + 2];
    const p = seg.progress[s];
    const lit = seg.level[s] > 0 ? 0.3 + 0.7 * p : p * 0.6; // first level = clearly visible
    const shimmer = seg.level[s] > 0 ? 1 + 0.7 * Math.max(0, 1 - Math.abs(x - sweep) * 8) : 1;
    const b = (lit * shimmer + seg.flash[s] * 1.5) * (1 - row * 0.85);
    arr[k * 3] = g.r * b;
    arr[k * 3 + 1] = g.g * b;
    arr[k * 3 + 2] = g.b * b;
  }
  gleamColors.needsUpdate = true;
}

function updateHUD() {
  const s = Math.round(game.sharpness * 100);
  setDom(ui.sharpFill, 'width', `${s}%`);
  setDom(ui.sharpText, 'text', `${s}%`);
  const st = angleState();
  setDom(ui.angleLight, 'class', st === 'bad' ? '' : st);
  setDom(ui.angleText, 'class', st === 'bad' ? '' : st);
  setDom(ui.angleText, 'text', `${game.angle.toFixed(1)}°`);
  setDom(ui.pressFill, 'width', `${Math.round(game.pressure * 100)}%`);
  setDom(ui.pressFill, 'class', `fill${pressureOK() ? ' good' : game.pressure > PRESS_HI ? ' high' : ''}`);
  setDom(ui.pressText, 'text', !drag ? '' : pressureOK() ? '剛好' : game.pressure > PRESS_HI ? '太重' : '太輕');
  setDom(sliderThumb, 'top', `${angleToPct(game.angle)}%`);
  setDom(sliderThumb, 'class', `thumb ${st}`);
  const cur = drag ? Math.min(SEGS - 1, Math.floor(game.edgeU * SEGS)) : -1;
  for (let i = 0; i < SEGS; i++) {
    const pct = Math.round(seg.progress[i] * 20) * 5;
    if (seg.shown[i] !== pct) {
      seg.shown[i] = pct;
      segEls[i].firstChild.style.height = `${pct}%`;
    }
    setDom(segEls[i], 'class', `l${seg.level[i]}${i === cur ? ' cur' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Test-cut targets. Each one is built ONCE at load as a whole mesh plus two pre-cut halves
// (split along a 30° plane at build time, cut faces capped with their own material, pivots at
// the cut-face centre, per 05-model-specs). The halves stay hidden until the cut. No runtime slicing.
// Target-local frame: bottom at y = 0 (top of the chopping block), cut plane through `c`.
// ---------------------------------------------------------------------------
const CUT_N = new THREE.Vector3(Math.cos(CUT_TILT), Math.sin(CUT_TILT), 0); // cut-plane normal
const CUT_U = new THREE.Vector3(-Math.sin(CUT_TILT), Math.cos(CUT_TILT), 0); // in-plane, up the slash line
const CUT_D = CUT_U.clone().negate(); // slash direction
const CUT_Z = new THREE.Vector3(0, 0, 1); // in-plane, along the edge

/** Build-time split of a closed mesh by the cut plane through c. Returns both capped halves. */
function splitGeometry(src, c) {
  const g = src.index ? src.toNonIndexed() : src.clone();
  if (!g.attributes.normal) g.computeVertexNormals();
  const P = g.attributes.position, N = g.attributes.normal, UV = g.attributes.uv;
  const tmp = new THREE.Vector3();
  const halves = [];
  for (const side of [-1, 1]) {
    const pos = [], nor = [], uv = [], cap = [], seen = new Set();
    const vtx = (i) => ({
      p: new THREE.Vector3().fromBufferAttribute(P, i),
      n: new THREE.Vector3().fromBufferAttribute(N, i),
      uv: UV ? new THREE.Vector2().fromBufferAttribute(UV, i) : new THREE.Vector2(),
    });
    const push = (v) => { pos.push(v.p.x, v.p.y, v.p.z); nor.push(v.n.x, v.n.y, v.n.z); uv.push(v.uv.x, v.uv.y); };
    for (let t = 0; t < P.count; t += 3) {
      const tri = [vtx(t), vtx(t + 1), vtx(t + 2)];
      const d = tri.map((v) => side * CUT_N.dot(tmp.copy(v.p).sub(c)));
      const poly = [];
      for (let k = 0; k < 3; k++) { // Sutherland–Hodgman against one plane
        const a = tri[k], b = tri[(k + 1) % 3], da = d[k], db = d[(k + 1) % 3];
        if (da >= 0) poly.push(a);
        if ((da >= 0) !== (db >= 0)) {
          const f = da / (da - db);
          const q = { p: a.p.clone().lerp(b.p, f), n: a.n.clone().lerp(b.n, f).normalize(), uv: a.uv.clone().lerp(b.uv, f) };
          poly.push(q);
          const key = `${q.p.x.toFixed(5)},${q.p.y.toFixed(5)},${q.p.z.toFixed(5)}`;
          if (!seen.has(key)) { seen.add(key); cap.push(q.p.clone()); }
        }
      }
      for (let k = 1; k + 1 < poly.length; k++) { push(poly[0]); push(poly[k]); push(poly[k + 1]); }
    }
    const surfaceCount = pos.length / 3;
    // Cap: order the section outline around its centroid in the plane basis (U, Z) and fan it.
    const centroid = new THREE.Vector3();
    cap.forEach((p) => centroid.add(p));
    centroid.divideScalar(Math.max(1, cap.length));
    const pu = (p) => tmp.copy(p).sub(centroid).dot(CUT_U);
    const pz = (p) => tmp.copy(p).sub(centroid).dot(CUT_Z);
    cap.sort((a, b) => Math.atan2(pz(a), pu(a)) - Math.atan2(pz(b), pu(b)));
    let R = 1e-6;
    cap.forEach((p) => (R = Math.max(R, p.distanceTo(centroid))));
    const out = CUT_N.clone().multiplyScalar(-side);
    const ca = new THREE.Vector3(), cb = new THREE.Vector3();
    const capVert = (p) => ({ p, n: out, uv: new THREE.Vector2(0.5 + pu(p) / (2 * R), 0.5 + pz(p) / (2 * R)) });
    for (let k = 0; k < cap.length; k++) {
      let a = cap[k], b = cap[(k + 1) % cap.length];
      if (ca.subVectors(a, centroid).cross(cb.subVectors(b, centroid)).dot(out) < 0) [a, b] = [b, a];
      push(capVert(centroid)); push(capVert(a)); push(capVert(b));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.addGroup(0, surfaceCount, 0);
    geo.addGroup(surfaceCount, pos.length / 3 - surfaceCount, 1);
    geo.translate(-centroid.x, -centroid.y, -centroid.z); // pivot at the cut-face centre
    halves.push({ geo, pivot: centroid, side, cap });
  }
  // How far the section reaches up / down the slash line: where the blade enters and leaves.
  let sTop = -Infinity, sBottom = Infinity;
  for (const p of halves[0].cap) {
    const s = tmp.copy(p).sub(c).dot(CUT_U);
    sTop = Math.max(sTop, s);
    sBottom = Math.min(sBottom, s);
  }
  g.dispose();
  return { halves, sTop, sBottom };
}

function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function radialTex(stops) {
  return canvasTex(128, (g, n) => {
    const gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    g.fillStyle = gr;
    g.fillRect(0, 0, n, n);
  });
}
/** Flatten everything below y0 (a flat base so rocks / ice sit on the block). */
function flattenBelow(geo, y0) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) < y0) p.setY(i, y0);
  geo.translate(0, -y0, 0);
  return geo;
}

const STRAW = new THREE.Color('#DCD3C3').lerp(new THREE.Color('#B08A63'), 0.35);
// Per target: geometry, surface / cap materials, cut centre, props (not cut), separation of the halves, impact fx.
//   anim: upper half (on the +normal side) slides `slide` down the cut, opens by `gap`, falls `fall`, spins `spin`;
//         lower half opens by `gapLow` and tilts `tilt`; both hop by `hop`.
const TARGET_BUILD = {
  paper: () => ({
    geo: new THREE.BoxGeometry(0.18, 0.22, 0.002).translate(0, 0.02 + 0.11, 0),
    surface: new THREE.MeshStandardMaterial({ color: '#F7F7F2', roughness: 0.9, side: THREE.DoubleSide }),
    cap: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, side: THREE.DoubleSide }),
    props: [merged([
      place(new THREE.BoxGeometry(0.22, 0.02, 0.03), 0, 0.01, 0),
      place(new THREE.BoxGeometry(0.012, 0.05, 0.012), -0.1, 0.045, 0),
      place(new THREE.BoxGeometry(0.012, 0.05, 0.012), 0.1, 0.045, 0),
    ], mat.darkWood)],
    anim: { slide: 0.07, gap: 0.006, fall: 0.07, spin: 0.5, flutter: 0.6, gapLow: 0.002, tilt: 0.04, hop: 0 },
    fx: 'paper', weight: 0,
  }),
  makiwara: () => ({
    geo: new THREE.CylinderGeometry(0.04, 0.042, 0.26, 12, 4).translate(0, 0.015 + 0.13, 0),
    surface: new THREE.MeshStandardMaterial({
      roughness: 0.95,
      map: canvasTex(128, (g, n) => { // rolled straw mat: fibres + two rope ties
        g.fillStyle = `#${STRAW.getHexString()}`;
        g.fillRect(0, 0, n, n);
        for (let i = 0; i < 70; i++) {
          g.fillStyle = Math.random() < 0.5 ? 'rgba(255,248,230,0.35)' : 'rgba(90,70,40,0.25)';
          g.fillRect(Math.random() * n, 0, 1 + Math.random() * 2, n);
        }
        g.fillStyle = '#5C5650';
        for (const y of [0.28, 0.72]) g.fillRect(0, y * n - 3, n, 6);
      }),
    }),
    cap: new THREE.MeshStandardMaterial({
      roughness: 0.9,
      map: canvasTex(128, (g, n) => { // cross-section: tight straw spiral around a green bamboo core
        g.fillStyle = `#${STRAW.getHexString()}`;
        g.fillRect(0, 0, n, n);
        g.strokeStyle = 'rgba(110,85,50,0.5)';
        for (let r = n * 0.16; r < n * 0.5; r += 4) { g.beginPath(); g.arc(n / 2, n / 2, r, 0, Math.PI * 2); g.stroke(); }
        g.fillStyle = '#C9D8C5';
        g.beginPath(); g.arc(n / 2, n / 2, n * 0.14, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#6F8F6A';
        g.beginPath(); g.arc(n / 2, n / 2, n * 0.09, 0, Math.PI * 2); g.fill();
      }),
    }),
    props: [merged([
      place(new THREE.CylinderGeometry(0.07, 0.08, 0.015, 10), 0, 0.0075, 0),
      place(new THREE.CylinderGeometry(0.006, 0.006, 0.05, 6), 0, 0.03, 0),
    ], mat.darkWood)],
    anim: { slide: 0.11, gap: 0.012, fall: 0.1, spin: 1.2, flutter: 0, gapLow: 0.002, tilt: 0.05, hop: 0 },
    fx: 'straw', weight: 1,
  }),
  iron: () => ({
    geo: new THREE.BoxGeometry(0.28, 0.04, 0.045).translate(0, 0.012 + 0.02, 0),
    surface: new THREE.MeshStandardMaterial({ color: '#5d6166', metalness: 0.85, roughness: 0.38, flatShading: true }),
    cap: new THREE.MeshStandardMaterial({
      color: '#8a8f96', metalness: 0.5, roughness: 0.3, emissive: '#ffffff', emissiveIntensity: 2.2,
      emissiveMap: radialTex([[0, '#FFF2C4'], [0.35, '#F4C95D'], [0.75, '#B04A33'], [1, '#2B2A28']]),
    }),
    props: [merged([
      place(new THREE.BoxGeometry(0.03, 0.012, 0.07), -0.1, 0.006, 0),
      place(new THREE.BoxGeometry(0.03, 0.012, 0.07), 0.1, 0.006, 0),
    ], mat.darkWood)],
    anim: { slide: 0.008, gap: 0.03, fall: 0, spin: 0.12, flutter: 0, gapLow: 0.03, tilt: 0.1, hop: 0.03 },
    fx: 'metal', weight: 2,
  }),
  boulder: () => {
    const geo = flattenBelow(rockGeo(0.1, 1, 0.22).scale(1.25, 0.95, 1.0), -0.06);
    return {
      geo,
      surface: flat(P.stone, 0.92),
      cap: new THREE.MeshStandardMaterial({
        roughness: 0.8,
        map: canvasTex(128, (g, n) => { // fresh granite face: lighter than the weathered skin, speckled
          g.fillStyle = '#9a968e';
          g.fillRect(0, 0, n, n);
          const cols = ['#DCD3C3', '#5C5650', '#7C7A75', '#2B2A28'];
          for (let i = 0; i < 500; i++) {
            g.fillStyle = cols[i % 4];
            g.fillRect(Math.random() * n, Math.random() * n, 1 + Math.random() * 3, 1 + Math.random() * 3);
          }
        }),
      }),
      props: [],
      anim: { slide: 0.012, gap: 0.035, fall: 0, spin: 0.35, flutter: 0, gapLow: 0.02, tilt: 0.22, hop: 0.012 },
      fx: 'rock', weight: 3,
    };
  },
  iceberg: () => {
    const geo = new THREE.IcosahedronGeometry(0.08, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const n = 0.8 + hash3(Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000)) * 0.35;
      p.setXYZ(i, x * n, y * n * (y > 0 ? 1.6 : 0.7), z * n * 0.9); // a small peaked floe
    }
    flattenBelow(geo, -0.03);
    geo.translate(0, 0.008, 0); // floats in its tray
    return {
      geo,
      surface: new THREE.MeshPhysicalMaterial({ color: '#9FB7C9', roughness: 0.1, metalness: 0, clearcoat: 1, flatShading: true, emissive: '#1C2A3A', envMapIntensity: 1.5 }),
      cap: new THREE.MeshStandardMaterial({
        roughness: 0.05, emissive: '#ffffff', emissiveIntensity: 0.9,
        map: radialTex([[0, '#FFFFFF'], [0.5, '#E8F1F8'], [1, '#9FB7C9']]),
        emissiveMap: radialTex([[0, '#E8F1F8'], [0.6, '#9FB7C9'], [1, '#1C2A3A']]),
      }),
      props: [
        mesh(new THREE.CylinderGeometry(0.14, 0.13, 0.012, 14).translate(0, 0.006, 0), mat.darkWood),
        mesh(new THREE.CircleGeometry(0.128, 14).rotateX(-Math.PI / 2).translate(0, 0.0125, 0), mat.water, false, true),
      ],
      anim: { slide: 0.06, gap: 0.015, fall: 0.03, spin: 0.55, flutter: 0, gapLow: 0.004, tilt: 0.07, hop: 0 },
      fx: 'ice', weight: 4,
    };
  },
};

const targets = TARGETS.map((t) => {
  const b = TARGET_BUILD[t.id]();
  const group = new THREE.Group();
  group.position.y = BLOCK_H;
  b.geo.computeBoundingBox();
  const box = b.geo.boundingBox;
  const c = new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, 0).addScalar(1e-4); // off any vertex
  const whole = mesh(b.geo, b.surface);
  const split = splitGeometry(b.geo, c);
  const halves = split.halves.map((h) => {
    const m = mesh(h.geo, [b.surface, b.cap]);
    m.position.copy(h.pivot);
    m.visible = false;
    group.add(m);
    return { mesh: m, home: h.pivot.clone(), side: h.side };
  });
  group.add(whole, ...b.props);
  group.visible = false;
  stage.add(group);
  return {
    def: t, group, whole, halves, c, sTop: split.sTop, sBottom: split.sBottom, cap: b.cap,
    capGlow: b.cap.emissiveIntensity ?? 0, anim: b.anim, fx: b.fx, weight: b.weight,
    height: box.max.y, halfW: Math.max(-box.min.x, box.max.x),
  };
});

let stageTarget = targets[0];
function resetTarget(target) {
  target.whole.visible = true;
  for (const h of target.halves) {
    h.mesh.visible = false;
    h.mesh.position.copy(h.home);
    h.mesh.rotation.set(0, 0, 0);
  }
  target.group.position.set(0, BLOCK_H, 0);
  target.group.scale.setScalar(1);
  target.cap.emissiveIntensity = target.capGlow;
}
function showStageTarget(i) {
  targets.forEach((t, k) => {
    t.group.visible = k === i;
    if (k === i) resetTarget(t);
  });
  stageTarget = targets[i];
}

function animatePieces(target, k) {
  const a = target.anim;
  const e = easeOutCubic(k);
  for (const h of target.halves) {
    const m = h.mesh;
    m.position.copy(h.home);
    if (h.side > 0) { // upper piece: slides down the cut, opens, falls, spins
      m.position.addScaledVector(CUT_D, a.slide * e).addScaledVector(CUT_N, a.gap * e);
      m.position.y += a.hop * 4 * k * (1 - k) - a.fall * k * k;
      m.rotation.z = -a.spin * e;
      m.rotation.x = a.flutter * Math.sin(k * 9) * k;
    } else {
      m.position.addScaledVector(CUT_N, -a.gapLow * e);
      m.position.y += a.hop * 2 * k * (1 - k);
      m.rotation.z = a.tilt * easeOutBounce(k);
    }
  }
}

function impactFX(target, at, success) {
  const fx = target.fx;
  if (!success) {
    burst(sparks, at, 14, 0.9, HEAT_COLORS, 0.3); // small clink of sparks
    if (fx === 'ice') burst(drops, at, 8, 0.5, [ICE_COLOR], 0.5);
    if (fx === 'rock') burst(drops, at, 8, 0.5, CHIP_COLORS, 0.5);
    return;
  }
  if (fx === 'metal') burst(sparks, at, 36, 1.3, HEAT_COLORS, 0.5);
  if (fx === 'rock') { burst(drops, at, 30, 0.8, CHIP_COLORS, 0.8); burst(sparks, at, 14, 1.0, HEAT_COLORS, 0.35); }
  if (fx === 'ice') burst(drops, at, 36, 0.9, [ICE_COLOR, DROP_COLOR], 0.9);
  if (fx === 'straw') burst(drops, at, 18, 0.5, STRAW_COLORS, 0.7);
  if (fx === 'paper') burst(drops, at, 8, 0.25, [ICE_COLOR], 0.6);
  burst(glints, at, 10, 0.4, GLINT_COLORS, 0.4);
}

// Hitstop (true freeze, capped) -> then a camera shake that decays to zero.
let hitstop = 0;
let freezeAcc = 0;
let shake = 0;
let shakeAmp = 0;
let pendingShake = 0;
let afterFreeze = 'slash';
function startHitstop(seconds, amp, next) {
  hitstop = Math.min(HITSTOP_MAX, seconds);
  freezeAcc = 0;
  pendingShake = amp;
  afterFreeze = next;
  cine.phase = 'freeze';
}

const flashEl = document.getElementById('flash');
function flash(color, opacity, ms) {
  flashEl.style.transition = 'none';
  flashEl.style.background = color;
  flashEl.style.opacity = opacity;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    flashEl.style.transition = `opacity ${ms}ms ease-out`;
    flashEl.style.opacity = 0;
  }));
}

/** World position of the point s along the slash line (target space). */
function slashPoint(s, out) {
  out.copy(CUT_U).multiplyScalar(s).add(slashRig.position);
  return stage.localToWorld(out);
}

async function slashSuccess(target, sHigh) {
  const sBlock = -target.c.y / CUT_U.y; // where the slash line meets the block
  const sEnd = Math.max(target.sBottom - 0.01, sBlock + 0.004);
  let hit = false;
  await tween(SLASH_TIME, (k) => {
    const s = lerp(sHigh, sEnd, k);
    chopRig.position.y = s;
    if (!hit && s <= target.sTop) {
      hit = true;
      // The cut moment: swap the whole mesh for the pre-cut halves, freeze, flash.
      target.whole.visible = false;
      for (const h of target.halves) h.mesh.visible = true;
      startHitstop(target.def.hitstop, 0.005 + target.weight * 0.0025, 'slash');
      audio.slice();
      if (target.weight >= 2) audio.boom(target.weight);
      flash(CLIMAX.slash, 0.75, 260);
      if (target.weight >= 3) setTimeout(() => flash(CLIMAX.accent, 0.3, 90), 40); // red: a few frames only
      impactFX(target, slashPoint(target.sTop, tmpP), true);
    }
  }, (t) => t * (0.55 + 0.45 * t));
  cine.phase = 'split';
  impactFX(target, slashPoint(sEnd + 0.01, tmpP), true);
  if (target.fx === 'metal') tween(2.5, (k) => (target.cap.emissiveIntensity = lerp(target.capGlow, 0.5, k))); // cut cools
  const pieces = tween(0.9, (k) => animatePieces(target, k));
  await waitReal(0.35); // hold the slow motion while the halves start to part
  await tween(0.4, (k) => (timeScale = lerp(SLOWMO_SCALE, 1, k)), easeInOut, true);
  tween(0.3, (k) => (chopRig.position.y = lerp(sEnd, sHigh, k)), easeInOut);
  await pieces;
}

async function slashFail(target, sHigh) {
  await tween(SLASH_TIME * 0.6, (k) => (chopRig.position.y = lerp(sHigh, target.sTop, k)), (t) => t * t);
  startHitstop(FAIL_HITSTOP, 0.009, 'recoil');
  audio.clink();
  impactFX(target, slashPoint(target.sTop, tmpP), false);
  toast('刀被彈開了…再磨利一點', 1.8);
  await waitReal(FAIL_HITSTOP);
  tween(0.15, (k) => (timeScale = lerp(SLOWMO_SCALE, 1, k)), easeOutCubic, true);
  const s0 = target.sTop;
  await tween(0.75, (k) => {
    // Blade kicks back up and glances off with a decaying wobble; the target only shudders.
    const up = Math.sin(Math.min(1, k * 1.8) * Math.PI * 0.5);
    chopRig.position.y = s0 + 0.14 * up;
    slashRig.rotation.z = CUT_TILT - 0.3 * up * (1 - k * 0.5) + Math.sin(k * 32) * 0.08 * (1 - k);
    target.group.position.x = Math.sin(k * 60) * 0.004 * (1 - k);
  });
  target.group.position.x = 0;
  slashRig.rotation.z = CUT_TILT;
}

/**
 * The test-cut cinematic for one target: letterbox in -> windup -> slow-motion slash ->
 * (success) cut freeze + halves part, or (fail) the blade bounces off -> result card.
 * opts.fail forces the bounce. Resolves with { id, success } (null if a cut is already running).
 */
async function runTest(id, opts = {}) {
  // A result-card exit is still unwinding the prior cinematic; never overlap cuts.
  if (game.mode === 'test' || game.mode === 'exit') return null;
  if (game.mode !== 'sharpen' && game.mode !== 'result') return null;
  const idx = TARGETS.findIndex((t) => t.id === id);
  if (idx < 0) return null;
  if (stoneSwitching) {
    await stoneSwap; // finish the stone swap before the cut (it uses game.stone)
    if (game.mode !== 'sharpen' && game.mode !== 'result') return null;
  }
  const def = TARGETS[idx];
  const target = targets[idx];
  const success = !opts.fail && game.sharpness >= def.need - 1e-6;
  ui.result.classList.remove('show');
  game.mode = 'test';
  flow.screen = 'cut';
  cine.phase = 'enter';
  cine.target = id;
  cine.lastHitstopMs = 0;
  drag = second = null;
  sliderPointer = null;
  audio.setGrind(0);
  ui.testBtn.disabled = true;
  ui.slider.classList.add('hidden');
  ui.hud.classList.add('hidden');
  document.body.classList.add('cine');
  chopRig.visible = false;
  showStageTarget(idx);
  target.group.scale.setScalar(0.001);
  const c0 = camBlend, b0 = cine.bars;
  await Promise.all([
    tween(0.9 * (1 - c0) + 0.01, (k) => (camBlend = lerp(c0, 1, k)), easeInOut),
    tween(LETTERBOX_IN * (1 - b0) + 0.01, (k) => (cine.bars = lerp(b0, 1, k)), easeInOut, true),
    wait(0.25).then(() => tween(0.4, (k) => target.group.scale.setScalar(Math.max(0.001, easeOutBounce(k))))),
  ]);
  toast(def.name, 0.8);

  cine.phase = 'windup';
  slashRig.position.copy(target.group.position).add(target.c);
  slashRig.rotation.z = CUT_TILT;
  const sHigh = target.sTop + 0.14;
  chopRig.position.set(0, sHigh + 0.12, 0);
  chopRig.visible = true;
  await tween(0.35, (k) => (chopRig.position.y = lerp(sHigh + 0.12, sHigh, k)), easeOutCubic);
  await tween(0.22, (k) => (chopRig.position.y = sHigh + 0.03 * Math.sin(k * Math.PI) * (1 - k * 0.3)), easeInOut); // anticipation

  cine.phase = 'slash';
  audio.slowmo();
  audio.whoosh();
  await tween(0.1, (k) => (timeScale = lerp(1, SLOWMO_SCALE, k)), easeOutCubic, true);
  if (success) await slashSuccess(target, sHigh);
  else await slashFail(target, sHigh);
  timeScale = 1;
  await wait(success ? 0.35 : 0.2);
  return showResult(idx, success);
}

function showResult(idx, success) {
  const def = TARGETS[idx];
  game.mode = 'result';
  cine.phase = 'result';
  flow.screen = 'result';
  const before = game.sharpness;
  if (success) {
    game.best = Math.max(game.best, idx);
    dullEdge(def.dull);
  }
  const isOrder = flow.mode === 'order' && flow.order && idx === flow.order.targetIdx;
  setResultButtons(isOrder, success);
  if (isOrder) {
    showOrderResult(def, success, before);
    cine.lastResult = { id: def.id, success, sharpness: game.sharpness, hitstopMs: cine.lastHitstopMs, score: flow.result.score, rank: flow.result.rank };
    return cine.lastResult;
  }
  const pct = Math.round(game.sharpness * 100);
  ui.resultTitle.textContent = success ? `${def.name}・一刀兩斷` : '彈開了';
  const lines = [`鋒利度 <b>${pct}%</b>・最高評價 <b>${RANKS[game.best + 1]}</b>`];
  if (success) {
    if (def.dull > 0) lines.push(`刃口略有磨損（${Math.round(before * 100)}% → ${pct}%）`);
    if (idx === TARGETS.length - 1) lines.push('連冰山都一刀兩斷，傳說中的名匠！');
    else if (idx >= game.unlocked || game.sharpness < TARGETS[idx + 1].need - 1e-6) lines.push(`${TARGETS[idx + 1].name} 需要 ${Math.round(TARGETS[idx + 1].need * 100)}%，繼續磨吧`);
  } else {
    lines.push('刀被彈開了…再磨利一點');
    lines.push(`${def.name} 需要 <b>${Math.round(def.need * 100)}%</b>，目前 ${pct}%`);
    const st = STONES[game.stone];
    const need = STONES.find((s) => s.cap >= def.need);
    if (need && st.cap < def.need) lines.push(`${st.name}砥最多 ${Math.round(st.cap * 100)}%，要換「${need.name}」砥（${need.grit}）`);
    else lines.push(`角度保持 ${BAND_LO}°–${BAND_HI}°，讓整條刃口都亮起來。`);
  }
  ui.resultBody.innerHTML = lines.join('<br>');
  // "Next" goes to the next unlocked target after a success, otherwise retries this one.
  const next = success && idx < game.unlocked && game.sharpness >= TARGETS[idx + 1].need ? idx + 1 : idx;
  game.selected = next;
  ui.nextBtn.textContent = next !== idx ? `下一個：${TARGETS[next].name}` : '再切一次';
  refreshTargets();
  ui.result.classList.add('show');
  cine.lastResult = { id: def.id, success, sharpness: game.sharpness, hitstopMs: cine.lastHitstopMs };
  return cine.lastResult;
}

/** Order mode: score the cut, then fill the result card (rank, score, breakdown, customer's line). */
function showOrderResult(def, success, sharp) {
  const o = flow.order;
  const r = scoreOrder(sharp, o.need, success);
  flow.result = r;
  if (success && !o.done) {
    flow.completed++;
    o.done = true;
  }
  const pct = (v) => `${Math.round(v * 100)}%`;
  const P_ = r.parts;
  ui.resultTitle.textContent = success ? `${def.name}・一刀兩斷` : '彈開了';
  ui.resultScore.innerHTML = success
    ? `<span class="rank r${r.rank}">${r.rank}</span><span class="pts">${r.score}<small>分</small></span>`
    : '<span class="rank rF">失敗</span>';
  ui.resultScore.classList.remove('hidden');
  const row = (label, note, value, part) =>
    `<div><span>${label}<em>${note}</em></span><span>${value}${part ? `・${part.pts}/${part.max}` : ''}</span></div>`;
  const brk = [
    row('鋒利度', `要求 ${pct(o.need)}`, pct(sharp), success ? P_.margin : null),
    row('角度準確', `${BAND_LO}°–${BAND_HI}° 內的比例`, stats.dist > 0 ? pct(P_.angle.ratio) : '—', success ? P_.angle : null),
    row('壓力適中', '綠區內的比例', stats.dist > 0 ? pct(P_.pressure.ratio) : '—', success ? P_.pressure : null),
    row('效率', `推拉 ${stats.strokes} 次・${P_.efficiency.par.toFixed(1)} 趟內磨到 ${pct(o.goal)} 得滿分`, `${P_.efficiency.used.toFixed(1)} 趟`, success ? P_.efficiency : null),
  ];
  const lines = [];
  if (success) {
    lines.push(`${o.from} ${o.customer}：「${RANK_LINES[r.rank]}」`);
  } else {
    lines.push('沒關係，再磨一下就好。');
    lines.push(`${def.name} 需要 <b>${pct(def.need)}</b>，目前 ${pct(sharp)}`);
    const st = STONES[game.stone];
    const need = STONES.find((x) => x.cap >= def.need);
    if (need && st.cap < def.need) lines.push(`${st.name}砥最多 ${pct(st.cap)}，換「${need.name}」砥（${need.grit}）`);
  }
  ui.resultBody.innerHTML = `<div class="brk">${brk.join('')}</div>${lines.join('<br>')}`;
  ui.result.classList.add('show');
}

/** Free mode keeps the round-3 buttons; order mode shows 再磨一下 (fail) / 下一個委託 (success) + 回標題. */
function setResultButtons(isOrder, success) {
  ui.againBtn.classList.toggle('hidden', isOrder);
  ui.nextBtn.classList.toggle('hidden', isOrder);
  ui.restartBtn.classList.toggle('hidden', isOrder);
  ui.retryBtn.classList.toggle('hidden', !isOrder || success);
  ui.nextOrderBtn.classList.toggle('hidden', !isOrder || !success);
  ui.titleBtn.classList.toggle('hidden', !isOrder);
  if (!isOrder) ui.resultScore.classList.add('hidden');
}

/** Ideal full passes (perfect angle and pressure, best stone each pass) to raise the edge from -> to. */
function idealPasses(from, to) {
  let p = from, n = 0;
  while (p < to - 1e-6 && n < 2000) {
    let gain = 0;
    for (const st of STONES) {
      const room = st.cap - p;
      if (room <= 0) continue;
      const ease = 0.3 + 0.7 * Math.min(1, (room / st.cap) * 3);
      gain = Math.max(gain, Math.min(st.cap, p + st.rate * GAIN_PER_PASS * (1 - 0.55 * p) * ease) - p);
    }
    if (gain <= 0) break;
    if (p + gain >= to) return n + (to - p) / gain;
    p += gain;
    n++;
  }
  return n;
}

/** Deterministic order score from the final sharpness and this order's grinding stats (see SCORE). */
const marginSpan = (need) => Math.max(0.01, Math.min(SCORE.marginFull, SCORE.marginCeil - need));
function scoreOrder(sharp, need, success) {
  const W = SCORE.weights;
  const span = marginSpan(need);
  const par = Math.max(SCORE.parMin, idealPasses(SCORE.orderStart, need + span) * SCORE.parSlack);
  const hasDist = Number.isFinite(stats.dist) && stats.dist > 0;
  const used = hasDist && Number.isFinite(stats.goalDist) && stats.goalDist >= 0 ? stats.goalDist : hasDist ? stats.dist : 0;
  const ratio = {
    margin: clamp((sharp - need) / span, 0, 1),
    angle: hasDist ? clamp(stats.angleDist / stats.dist, 0, 1) : 0,
    pressure: hasDist ? clamp(stats.pressDist / stats.dist, 0, 1) : 0,
    efficiency: hasDist ? clamp(used <= par ? 1 : par / used, 0, 1) : 0,
  };
  const parts = {};
  let score = 0;
  for (const k of Object.keys(W)) {
    const pts = Math.round(ratio[k] * W[k]);
    parts[k] = { ratio: ratio[k], pts, max: W[k] };
    score += pts;
  }
  parts.efficiency.par = par;
  parts.efficiency.used = used;
  if (!success) return { success, score: null, rank: '失敗', parts };
  const rank = RANK_TABLE.find((r) => score >= r.min).rank;
  return { success, score, rank, parts };
}

async function backToSharpen(reset) {
  if (game.mode !== 'result') return;
  if (flow.screen === 'result') flow.screen = 'sharpen';
  game.mode = 'exit';
  cine.phase = 'exit';
  ui.result.classList.remove('show');
  timeScale = 1;
  if (reset) {
    seg.progress.fill(0);
    seg.level.fill(0);
    seg.flash.fill(0);
    game.sharpness = 0;
    game.stage = 0;
    game.unlocked = 0;
    game.selected = 0;
    game.best = -1;
    setAngle(START_ANGLE);
    game.knifeX = game.knifeTargetX = 0;
    for (const s of stones) {
      s.wear.fill(0);
      s.wet01 = 0;
      applyStoneWear(s);
    }
    selectStone(0, true);
    setKnifeFinish(0);
  }
  game.pressure = 0;
  game.speed = 0;
  const c0 = camBlend, b0 = cine.bars;
  await Promise.all([
    tween(0.8, (k) => (camBlend = lerp(c0, 0, k)), easeInOut),
    tween(LETTERBOX_IN * b0 + 0.01, (k) => (cine.bars = lerp(b0, 0, k)), easeInOut, true),
  ]);
  chopRig.visible = false;
  document.body.classList.remove('cine');
  ui.hud.classList.remove('hidden');
  ui.slider.classList.remove('hidden');
  ui.testBtn.disabled = false;
  refreshTargets();
  showStageTarget(cutIdx());
  cine.target = null;
  cine.phase = 'idle';
  game.mode = 'sharpen';
}

// ---------------------------------------------------------------------------
// Flow screens: title -> order card -> sharpen -> cut -> result
// ---------------------------------------------------------------------------
function releaseInput() {
  drag = second = null;
  sliderPointer = null;
  audio.setGrind(0);
}

function setScreen(screen) {
  flow.screen = screen;
  ui.title.classList.toggle('show', screen === 'title');
  ui.order.classList.toggle('show', screen === 'order');
  document.body.classList.toggle('menu', screen === 'title' || screen === 'order');
  if (screen === 'title' || screen === 'order') releaseInput();
}

function setFlowMode(mode) {
  flow.mode = mode;
  ui.targets.classList.toggle('hidden', mode === 'order');
  ui.orderHud.classList.toggle('hidden', mode !== 'order');
  refreshTargets();
}

function updateOrderHud() {
  const o = flow.order;
  if (!o) return;
  ui.orderHud.innerHTML = `委託・${o.customer}：切開 <b>${o.targetName}</b>（${flow.ready ? '已達要求 ✓' : `需要 ${Math.round(o.need * 100)}%`}）`;
  ui.orderHud.classList.toggle('ready', flow.ready);
}

/** Leave a finished cut (if any) in the background while a menu screen is up. */
function leaveResult() {
  ui.result.classList.remove('show');
  if (game.mode === 'result') backToSharpen(false);
}

function showTitle() {
  if (game.mode === 'test') return;
  setScreen('title');
  setFlowMode(null);
  leaveResult();
}

/** Show the next order card (difficulty = completed orders, clamped at the last target). */
function startOrder() {
  if (game.mode === 'test') return;
  const no = flow.completed;
  const c = CUSTOMERS[no % CUSTOMERS.length];
  const targetIdx = Math.min(no, TARGETS.length - 1);
  const t = TARGETS[targetIdx];
  flow.order = { no: no + 1, customer: c.name, from: c.from, knife: c.knife, line: c.line, targetIdx, target: t.id, targetName: t.name, need: t.need, goal: t.need + marginSpan(t.need), done: false };
  flow.result = null;
  ui.orderNo.textContent = `委託 第 ${no + 1} 件`;
  ui.orderName.textContent = c.name;
  ui.orderFrom.textContent = c.from;
  ui.orderLine.textContent = `「${c.line}」`;
  ui.orderKnife.textContent = c.knife;
  ui.orderTarget.innerHTML = `切開 <b>${t.name}</b>（${t.need > 0 ? `鋒利度需 ${Math.round(t.need * 100)}%` : '暖身：輕鬆磨一磨就好'}）`;
  setScreen('order');
  setFlowMode(null);
  leaveResult();
}

/** Accept the order: dull edge, coarse stone, fresh stats, then sharpen. */
function acceptOrder() {
  if (game.mode === 'test' || game.mode === 'exit') return;
  if (flow.screen !== 'order' || !flow.order) startOrder();
  setFlowMode('order');
  seg.flash.fill(0);
  setSharpness(SCORE.orderStart);
  selectStone(0, true);
  setAngle(START_ANGLE);
  game.knifeX = game.knifeTargetX = 0;
  game.hintTimer = 0;
  game.pressure = 0;
  game.speed = 0;
  game.burr = 0;
  game.hold = 0;
  stats.dist = stats.angleDist = stats.pressDist = stats.strokes = 0;
  stats.goalDist = -1;
  // Stone wear intentionally persists between orders.
  flow.ready = game.sharpness >= flow.order.need - 1e-6;
  flow.result = null;
  updateOrderHud();
  showStageTarget(flow.order.targetIdx);
  setScreen('sharpen');
}

/** Free sharpening (the round-3 sandbox): target chips, free-mode result card. */
function startFree() {
  if (game.mode === 'test') return;
  setFlowMode('free');
  setScreen('sharpen');
  leaveResult();
  if (game.mode === 'sharpen') showStageTarget(game.selected);
}

// ---------------------------------------------------------------------------
// Letterbox: bars sized from the real viewport so the visible area is exactly LETTERBOX_ASPECT
// (top/bottom bars when the screen is narrower, e.g. portrait phones; side bars when wider).
// ---------------------------------------------------------------------------
let lbW = -1, lbH = -1, lbA = -1;
cine.barV = 0;
cine.barH = 0;
function updateLetterbox() {
  const W = window.innerWidth, H = window.innerHeight, a = cine.bars;
  if (W === lbW && H === lbH && a === lbA) return;
  lbW = W; lbH = H; lbA = a;
  const aspect = W / H;
  cine.barV = (aspect < LETTERBOX_ASPECT ? (H - W / LETTERBOX_ASPECT) / 2 : 0) * a;
  cine.barH = (aspect > LETTERBOX_ASPECT ? (W - H * LETTERBOX_ASPECT) / 2 : 0) * a;
  ui.bars[0].style.height = ui.bars[1].style.height = `${cine.barV}px`;
  ui.bars[2].style.width = ui.bars[3].style.width = `${cine.barH}px`;
}

// ---------------------------------------------------------------------------
// Camera framing (fits both portrait phones and landscape screens)
// ---------------------------------------------------------------------------
let camBlend = 0; // 0 = whetstone view, 1 = test stage view
const SHARPEN_DIR = new THREE.Vector3(0.12, 0.8, 0.6).normalize();
const STAGE_DIR = new THREE.Vector3(0.62, 0.42, 0.66).normalize();
const deg2rad = THREE.MathUtils.degToRad;

function fitDistance(halfW, halfH, fovDeg, aspect) {
  const tv = Math.tan(deg2rad(fovDeg) / 2);
  return Math.max(halfW / (tv * aspect), halfH / tv);
}

const camA = new THREE.Vector3();
const camB = new THREE.Vector3();
const lookA = new THREE.Vector3();
const lookB = new THREE.Vector3();

function updateCamera(t, realDt) {
  const aspect = camera.aspect;
  const portrait = aspect < 1;
  const fovA = portrait ? 55 : 45;
  // Cinematic lens: the 2.39:1 window has a CINE_HFOV horizontal FOV; the full frame's vertical FOV is
  // derived from how much of the screen height that window covers, so the subject fits inside the bars.
  const tanH = Math.tan(deg2rad(CINE_HFOV) / 2);
  const tanVBand = tanH / LETTERBOX_ASPECT;
  const fovB = THREE.MathUtils.radToDeg(2 * Math.atan(tanVBand / Math.min(1, aspect / LETTERBOX_ASPECT)));
  const fov = lerp(fovA, fovB, camBlend);
  if (Math.abs(fov - camera.fov) > 1e-4) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  // Look slightly above the stone on portrait so the HUD doesn't cover it.
  lookA.set(STATION_X + (portrait ? 0.09 : 0.06), TABLE_TOP + (portrait ? 0.05 : 0.03), 0.04);
  camA.copy(lookA).addScaledVector(SHARPEN_DIR, fitDistance(portrait ? 0.26 : 0.46, portrait ? 0.16 : 0.26, fovA, aspect));
  const tg = stageTarget;
  lookB.set(stage.position.x, STAGE_TOP + BLOCK_H + tg.height * 0.5, stage.position.z);
  camB.copy(lookB).addScaledVector(STAGE_DIR, Math.max((tg.halfW + 0.12) / tanH, (tg.height * 0.5 + 0.06) / tanVBand));

  camera.position.lerpVectors(camA, camB, camBlend);
  camera.position.x += Math.sin(t * 0.5) * 0.006;
  camera.position.y += Math.sin(t * 0.37 + 1) * 0.004;
  camera.position.z += Math.cos(t * 0.41) * 0.004;
  lookA.lerp(lookB, camBlend);
  camera.lookAt(lookA);
  if (shake > 0) {
    const a = shakeAmp * shake * shake; // decays large -> small, reaches exactly zero
    camera.position.x += (Math.random() - 0.5) * 2 * a;
    camera.position.y += (Math.random() - 0.5) * 2 * a;
    camera.rotateZ((Math.random() - 0.5) * a * 6);
    shake = Math.max(0, shake - realDt / SHAKE_TIME);
  }
}

// Day/dusk palette blends toward the climax palette as the camera moves to the test stage.
rim.position.set(STAGE_POS.x - 1.2, 2.2, STAGE_POS.z - 1.6);
rim.target.position.copy(STAGE_POS);
function updateAtmosphere(t) {
  const k = camBlend;
  skyMat.uniforms.uDark.value = k * 0.97;
  scene.fog.color.copy(P.skyBottom).lerp(CLIMAX.bg, k);
  scene.fog.near = lerp(5, 1.4, k);
  scene.fog.far = lerp(14, 4.2, k);
  hemi.intensity = lerp(P.hemiI, 0.25, k);
  hemi.color.copy(P.hemiSky).lerp(CLIMAX.ambient, k);
  hemi.groundColor.copy(P.hemiGround).lerp(CLIMAX.bg, k);
  sun.intensity = lerp(P.sunI, 0.2, k);
  rim.intensity = lerp(0, 3.2, k);
  scene.environmentIntensity = lerp(P.envI, 0.3, k);
  const flicker = 1 + Math.sin(t * 9) * 0.07 + Math.sin(t * 23) * 0.04;
  lanternLight.intensity = P.lanternI * flicker * (1 - k * 0.85);
  lanternLight.position.set(LANTERN_POS.x, TABLE_TOP + LANTERN_H * 0.45, LANTERN_POS.z);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(w, h);
  if (drag) drag.ppu = stonePixelsPerUnit();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
window.visualViewport?.addEventListener('resize', onResize);
onResize();

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
/** Debug: set every edge segment to v (0–1, or a percentage if > 1; no dings); unlocks are recomputed exactly from v. */
function setSharpness(v) {
  v = Number(v) || 0;
  if (v > 1) v /= 100;
  v = clamp(v, 0, 1);
  seg.progress.fill(v);
  for (let i = 0; i < SEGS; i++) seg.level[i] = SEG_LEVELS.filter((l) => v >= l - 1e-6).length;
  game.sharpness = v;
  game.stage = seg.level[0];
  setKnifeFinish(v);
  game.unlocked = 0;
  while (game.unlocked < TARGETS.length - 1 && v >= TARGETS[game.unlocked + 1].need - 1e-6) game.unlocked++;
  game.selected = Math.min(game.selected, game.unlocked);
  refreshTargets();
  if (game.mode === 'sharpen') showStageTarget(cutIdx());
  return v;
}

selectStone(0, true);
refreshTargets();
showStageTarget(0);
setScreen('title'); // the page opens on the title screen; test hooks still work from here

// Debug: ?demo=0.8 starts with that sharpness and cuts the hardest unlocked target immediately.
if (params.has('demo')) {
  startFree();
  setSharpness(parseFloat(params.get('demo')));
  runTest(TARGETS[game.unlocked].id);
}

// ---------------------------------------------------------------------------
// Main loop (paused while the tab is hidden)
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const FPS_N = 60;
const frameTimes = new Float32Array(FPS_N);
let frameIdx = 0, frameCount = 0, frameSum = 0;
let simT = 0; // world time: stops during the hitstop, slows during slow motion
window.__fps = 0;

function frame() {
  const rawDt = clock.getDelta();
  const realDt = Math.min(rawDt, 0.05); // simulation step (clamped after stalls)

  // Rolling FPS average from the true frame time (allocation-free ring buffer)
  frameSum += rawDt - frameTimes[frameIdx];
  frameTimes[frameIdx] = rawDt;
  frameIdx = (frameIdx + 1) % FPS_N;
  frameCount = Math.min(FPS_N, frameCount + 1);
  window.__fps = frameSum > 0 ? Math.round((frameCount / frameSum) * 10) / 10 : 0;

  // Hitstop: the world is frozen for exactly `hitstop` seconds (leftover frame time carries on),
  // then the camera shake starts.
  let dt = realDt;
  if (hitstop > 0) {
    const frozen = Math.min(hitstop, realDt);
    hitstop -= frozen;
    freezeAcc += frozen;
    dt = realDt - frozen;
    if (hitstop <= 1e-9) {
      hitstop = 0;
      cine.lastHitstopMs = Math.round(freezeAcc * 1000);
      shake = 1;
      shakeAmp = pendingShake;
      if (cine.phase === 'freeze') cine.phase = afterFreeze;
    }
  }
  const gdt = dt * timeScale;
  simT += gdt;

  updateTweens(gdt, realDt);
  if (game.mode === 'sharpen') updateSharpening(dt, simT);
  else game.pressure = damp(game.pressure, 0, 6, dt);
  updateGleam(gdt, simT);
  updateHUD();
  updateAtmosphere(simT);
  updateLetterbox();

  const floorY = camBlend > 0.5 ? STAGE_TOP + BLOCK_H : TABLE_TOP;
  sparks.update(gdt, floorY);
  drops.update(gdt, floorY);
  glints.update(gdt, -10);
  bamboo.update(simT);
  updateCamera(simT, realDt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    renderer.setAnimationLoop(null);
    audio.setGrind(0);
    audio.ctx?.suspend();
  } else {
    clock.getDelta(); // drop the hidden interval
    renderer.setAnimationLoop(frame);
    audio.ctx?.resume().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------
window.__game = {
  get sharpness() { return game.sharpness; },
  get angle() { return game.angle; },
  get pressure() { return game.pressure; },
  get phase() { return game.mode; },
  get segments() { return Array.from(seg.progress); },
  get stage() { return game.stage; },
  band: [BAND_LO, BAND_HI],
};
window.__knife = {
  get phase() { return cine.phase; }, // idle | enter | windup | slash | freeze | split | recoil | result | exit
  get mode() { return game.mode; },
  get letterbox() {
    const W = window.innerWidth, H = window.innerHeight;
    const vw = W - 2 * cine.barH, vh = H - 2 * cine.barV;
    return { amount: cine.bars, barPx: cine.barV, sidePx: cine.barH, visibleHeightRatio: vh / H, visibleWidthRatio: vw / W, visibleAspect: vw / vh, targetAspect: LETTERBOX_ASPECT };
  },
  get target() { return cine.target ?? TARGETS[cutIdx()].id; },
  get selected() { return TARGETS[game.selected].id; },
  get unlocked() { return TARGETS.slice(0, game.unlocked + 1).map((t) => t.id); },
  get timeScale() { return timeScale; },
  get hitstop() { return hitstop; },
  get lastHitstopMs() { return cine.lastHitstopMs; },
  get shake() { return shake; },
  get lastResult() { return cine.lastResult; },
  get sharpness() { return game.sharpness; },
  get stone() { return STONES[game.stone].id; },
  get wear() { return Object.fromEntries(stones.map((s) => [s.def.id, Math.max(...s.wear)])); },
  get halvesVisible() { return stageTarget.halves.every((h) => h.mesh.visible) && !stageTarget.whole.visible; },
  targets: TARGETS,
  stones: STONES,
  constants: { SLOWMO_SCALE, HITSTOP_MAX, FAIL_HITSTOP, LETTERBOX_ASPECT, CUT_TILT_DEG: 30, BAND: [BAND_LO, BAND_HI] },
  /**
   * Run the test-cut cinematic (bypasses the lock; below the requirement it bounces). opts.fail forces a bounce.
   * From the title or order card it switches to free mode first; in order mode it always cuts the order's target.
   */
  testCut(id, opts = {}) {
    if (flow.screen === 'title' || flow.screen === 'order') startFree();
    if (flow.mode === 'order') id = flow.order.target;
    return runTest(id ?? TARGETS[game.selected].id, opts);
  },
  /** Flow snapshot: screen, mode, current order, last order score / rank. */
  flow() {
    const o = flow.order, r = flow.result;
    return {
      screen: flow.screen, mode: flow.mode, completed: flow.completed, ready: flow.ready,
      order: o && { no: o.no, customer: o.customer, from: o.from, knife: o.knife, target: o.target, targetName: o.targetName, need: o.need },
      score: r ? r.score : null, rank: r ? r.rank : null, success: r ? r.success : null,
      breakdown: r && Object.fromEntries(Object.entries(r.parts).map(([k, v]) => [k, { ratio: v.ratio, pts: v.pts, max: v.max }])),
      stats: { ...stats },
    };
  },
  /** title / result -> order card. Returns flow(). */
  startOrder() { startOrder(); return this.flow(); },
  /** order card -> sharpening (opens the next order card first if none is showing). Returns flow(). */
  acceptOrder() { acceptOrder(); return this.flow(); },
  /** -> free sharpening (round-3 sandbox). Returns flow(). */
  startFree() { startFree(); return this.flow(); },
  /** -> title screen. Returns flow(). */
  title() { showTitle(); return this.flow(); },
  scoring: { SCORE, RANK_TABLE },
  /** Snapshot for headless tests. */
  state() {
    return {
      mode: game.mode, phase: cine.phase, cinePhase: cine.phase, timeScale, hitstop, lastHitstopMs: cine.lastHitstopMs,
      shake, letterbox: this.letterbox, target: this.target, selected: this.selected, unlocked: this.unlocked,
      sharpness: game.sharpness, angle: game.angle, pressure: game.pressure, stone: this.stone, wear: this.wear,
      halvesVisible: this.halvesVisible, lastResult: cine.lastResult, fps: window.__fps,
      screen: flow.screen, flowMode: flow.mode,
    };
  },
  /** Debug only. */
  setSharpness,
  setAngle(a) { setAngle(Number(a)); return game.angle; },
  setStone(id) { selectStone(stoneIndex(id)); return STONES[game.stone].id; },
  back(reset = false) { return backToSharpen(reset); },
};
