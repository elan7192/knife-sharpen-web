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

const TIERS = [
  { key: 'paper', name: '紙', need: 0.2 },
  { key: 'bamboo', name: '竹子', need: 0.45 },
  { key: 'iron', name: '鐵', need: 0.7 },
  { key: 'ice', name: '冰山', need: 0.9 },
];
const RANKS = ['鈍刀', '入門', '利刃', '名刀', '神品'];
const HITSTOP_MAX = 0.12; // seconds; research: hitstop must be capped

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
  stoneTop: new THREE.MeshStandardMaterial({ color: P.stone.clone().lerp(P.wood, 0.3), roughness: 0.85 }),
  stoneBottom: new THREE.MeshStandardMaterial({ color: shade(P.water, 0.9), roughness: 0.9 }),
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
const STONE_DRY = mat.stoneTop.color.clone();
const STONE_WET = STONE_DRY.clone().lerp(P.water, 0.35);

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

// Whetstone on a wooden holder (砥石台)
{
  const stoneGroup = new THREE.Group();
  const holder = [];
  for (const sx of [-1, 1]) holder.push(place(new THREE.BoxGeometry(0.03, 0.015, STONE_W + 0.07), sx * (STONE_LEN / 2 - 0.03), 0.0075, 0)); // feet
  holder.push(place(new THREE.BoxGeometry(STONE_LEN + 0.05, HOLDER_H - 0.015, STONE_W + 0.03), 0, 0.015 + (HOLDER_H - 0.015) / 2, 0)); // bed
  for (const sx of [-1, 1]) holder.push(place(new THREE.BoxGeometry(0.012, 0.016, STONE_W + 0.03), sx * (STONE_LEN / 2 + 0.008), HOLDER_H + 0.008, 0)); // end stops
  stoneGroup.add(merged(holder, mat.darkWood));
  const bottom = mesh(new THREE.BoxGeometry(STONE_LEN, STONE_H * 0.4, STONE_W), mat.stoneBottom);
  bottom.position.y = HOLDER_H + STONE_H * 0.2;
  const top = mesh(new THREE.BoxGeometry(STONE_LEN, STONE_H * 0.6, STONE_W), mat.stoneTop);
  top.position.y = HOLDER_H + STONE_H * 0.7;
  stoneGroup.add(bottom, top);
  stoneGroup.position.x = STATION_X;
  onTable.add(stoneGroup);
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

// Test-cut knife, held blade-vertical above the stage
const chopRig = new THREE.Group();
chopRig.rotation.y = Math.PI / 2;
const chopKnife = buildKnife();
chopKnife.position.x = -0.07; // flat part of the edge over the target
chopRig.add(chopKnife);
chopRig.visible = false;
stage.add(chopRig);

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
const LEAF_COLOR = new THREE.Color('#b7d38a');
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
      if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
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

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.grindFilter = ctx.createBiquadFilter();
    this.grindFilter.type = 'bandpass';
    this.grindFilter.frequency.value = 900;
    this.grindFilter.Q.value = 0.9;
    this.grindGain = ctx.createGain();
    this.grindGain.gain.value = 0;
    src.connect(this.grindFilter).connect(this.grindGain).connect(this.master);
    src.start();
    if (ctx.state === 'suspended') ctx.resume();
  },
  setGrind(level, freq) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.grindGain.gain.setTargetAtTime(level, t, 0.04);
    this.grindFilter.frequency.setTargetAtTime(freq, t, 0.06);
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
};

// ---------------------------------------------------------------------------
// Tweens
// ---------------------------------------------------------------------------
const tweens = new Set();
let timeScale = 1; // < 1 during the test-cut slow motion
function tween(duration, fn, ease = (t) => t) {
  return new Promise((resolve) => tweens.add({ t: 0, duration, fn, ease, resolve }));
}
const wait = (s) => tween(s, () => {});
function updateTweens(dt) {
  for (const tw of tweens) {
    tw.t += dt;
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
  againBtn: $('againBtn'), restartBtn: $('restartBtn'),
  slider: $('angleSlider'), hud: $('hud'), bottom: $('bottom'),
};
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
};
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
  if (game.mode !== 'sharpen') return;
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
  if (game.mode === 'sharpen') setAngle(game.angle - Math.sign(e.deltaY) * 0.5);
}, { passive: false });
window.addEventListener('keydown', (e) => {
  if (game.mode !== 'sharpen') return;
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
  if (game.mode !== 'sharpen') return;
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
onButton(ui.testBtn, () => { if (game.mode === 'sharpen') runTest(); });
onButton(ui.againBtn, () => backToSharpen(false));
onButton(ui.restartBtn, () => backToSharpen(true));

// ---------------------------------------------------------------------------
// Sharpening simulation
// ---------------------------------------------------------------------------
const contact = new THREE.Vector3();
let lastAngleDeg = Math.round(START_ANGLE);

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

function updateSharpening(dt, t) {
  const down = !!drag;
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
    game.wet = Math.min(1, game.wet + dt * 0.5);
  } else {
    game.wet = Math.max(0, game.wet - dt * 0.04);
  }

  // Edge coverage: the part of the edge on the stone follows the stroke position.
  const prevU = game.edgeU;
  game.edgeU = (game.knifeX + KNIFE_TRAVEL) / (KNIFE_TRAVEL * 2);
  const du = Math.abs(game.edgeU - prevU);
  game.burr = damp(game.burr, grinding && game.pressure > PRESS_HI ? 1 : 0, 3, dt);
  if (grinding && du > 0) {
    const eff = angleEfficiency(game.angle) * pressureEfficiency(game.pressure);
    for (let i = 0; i < SEGS; i++) {
      const w = segWeight(i, game.edgeU);
      if (w <= 0) continue;
      const p = seg.progress[i];
      seg.progress[i] = Math.min(1, p + ((du * eff * GAIN_PER_PASS * w) / seg.norm[i]) * (1 - 0.55 * p));
      while (seg.level[i] < SEG_LEVELS.length && seg.progress[i] >= SEG_LEVELS[seg.level[i]] - 1e-6) {
        seg.level[i]++;
        onSegmentLevel(i, seg.level[i]);
      }
    }
  }
  let sum = 0;
  for (let i = 0; i < SEGS; i++) sum += seg.progress[i];
  game.sharpness = sum / SEGS;

  // Angle band entry feedback, and a soft tick per degree while steering outside it
  const inBand = angleState() === 'good';
  if (inBand !== game.inBand) {
    game.inBand = inBand;
    if (inBand) audio.tick(true);
  }
  const deg = Math.round(game.angle);
  if (deg !== lastAngleDeg && !inBand && (drag || sliderPointer !== null)) audio.tick(false);
  lastAngleDeg = deg;

  // Knife pose: the contact point on the edge rides the stone; the belly rocks onto it.
  const ex = edgeXAt(game.edgeU);
  knifeRoot.position.x = STATION_X + game.knifeX * 0.75;
  knifeRoot.position.z = Math.sin(game.knifeX * 18) * 0.004;
  knifeTilt.rotation.x = THREE.MathUtils.degToRad(90 - game.angle);
  knifeContact.rotation.z = -Math.atan(edgeSlope(ex));
  sharpKnife.position.set(-ex, -edgeY(ex), 0);
  setKnifeFinish(game.sharpness);
  mat.stoneTop.roughness = lerp(0.85, 0.3, game.wet);
  mat.stoneTop.color.lerpColors(STONE_DRY, STONE_WET, game.wet);

  // Particles at the contact point
  knifeRoot.getWorldPosition(contact);
  if (grinding) {
    const dirX = Math.sign(v) || 1;
    game.dropAcc += dt * game.speed * 70;
    while (game.dropAcc >= 1) {
      game.dropAcc -= 1;
      tmpP.copy(contact).add(tmpV.set((Math.random() - 0.5) * 0.08, 0.002, (Math.random() - 0.5) * 0.05));
      tmpV.set(dirX * (0.2 + Math.random() * 0.5) * game.speed * 2, 0.3 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4);
      drops.emit(tmpP, tmpV, DROP_COLOR, 0.6 + Math.random() * 0.4);
    }
    // Sparks mostly mean "too much pressure" (burr): a readable warning.
    game.sparkAcc += dt * (Math.max(0, game.pressure - PRESS_HI) * 600 + Math.max(0, game.pressure - 0.3) * 30) * game.speed;
    while (game.sparkAcc >= 1) {
      game.sparkAcc -= 1;
      tmpV.set(-dirX * (0.6 + Math.random() * 1.2), 0.4 + Math.random() * 1.1, (Math.random() - 0.5) * 0.8);
      sparks.emit(contact, tmpV, SPARK_COLORS[(Math.random() * 3) | 0], 0.25 + Math.random() * 0.3);
    }
  }

  // Grind sound: brighter and steadier in the band, rougher with a burr.
  audio.setGrind(grinding ? Math.min(0.55, game.speed * 0.9) * (0.35 + game.pressure) * (inBand ? 1 : 0.7) : 0,
    (500 + game.speed * 1600 + game.pressure * 400) * (inBand ? 1.25 : 0.9) * (1 - game.burr * 0.35));

  // Coaching hint (throttled to avoid flicker); gentle tone, never "fail".
  game.hintTimer -= dt;
  if (game.hintTimer <= 0) {
    game.hintTimer = 0.3;
    let msg = DEFAULT_HINT;
    if (down) {
      if (game.angle > BAND_HI) msg = '角度稍陡 ↓ 手指往下一點';
      else if (game.angle < BAND_LO) msg = '角度稍平 ↑ 手指往上一點';
      else if (!grinding) msg = '角度剛好，左右來回推！';
      else if (game.pressure < PRESS_LO) msg = '壓力偏輕，推快一點';
      else if (game.pressure > PRESS_HI) msg = '太用力會起毛邊，放慢一點';
      else msg = '很好！刃口在發亮';
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
// Test-cut targets
// ---------------------------------------------------------------------------
const WHITE = new THREE.Color(1, 1, 1);
/**
 * Clamps every vertex to one side of the x=0 plane: a cheap, exact "cut" for flat-shaded meshes.
 * Vertices that land on the cut plane get `cutColor` (vertex colours), so the cut face reads clearly.
 */
function halfGeometry(geo, side, cutColor) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const cut = side < 0 ? x >= 0 : x <= 0;
    p.setX(i, cut ? 0 : x);
    (cut ? cutColor : WHITE).toArray(col, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

const TARGET_DEFS = {
  paper: () => ({
    geo: new THREE.BoxGeometry(0.2, 0.24, 0.003, 2, 1, 1).translate(0, 0.12, 0),
    material: new THREE.MeshStandardMaterial({ color: '#F7F7F2', roughness: 0.9, side: THREE.DoubleSide, vertexColors: true }),
    cut: new THREE.Color('#ffffff'),
    halfWidth: 0.1, slide: 0.01, hop: 0, topple: 1.45, twist: 0.15, fx: 'paper', weight: 0,
  }),
  bamboo: () => ({
    geo: new THREE.CylinderGeometry(0.032, 0.032, 0.36, 9, 6).rotateZ(Math.PI / 2).translate(0, 0.032, 0),
    material: flat(shade(PALETTES.day.leaf, 1.3), 0.55, { vertexColors: true }),
    cut: new THREE.Color('#e9f2c4'), // light green-cream fibre
    halfWidth: 0.18, slide: 0.1, hop: 0.07, topple: 0, twist: 0.6, fx: 'wood', weight: 1,
  }),
  iron: () => ({
    geo: new THREE.BoxGeometry(0.32, 0.045, 0.055, 2, 1, 1).translate(0, 0.0225, 0),
    material: new THREE.MeshStandardMaterial({ color: '#5d6166', metalness: 0.85, roughness: 0.38, flatShading: true, vertexColors: true }),
    cut: shade(CLIMAX.heat, 2.4), // hot glow at the cut
    halfWidth: 0.16, slide: 0.06, hop: 0.04, topple: 0, twist: 0.3, fx: 'metal', weight: 2,
  }),
  ice: () => {
    const geo = new THREE.IcosahedronGeometry(0.14, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const n = 0.82 + hash3(Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000)) * 0.32;
      p.setXYZ(i, x * n * 1.15, Math.max(-0.07, y * n * 1.35) + 0.07, z * n);
    }
    return {
      geo,
      material: new THREE.MeshPhysicalMaterial({ color: '#9FB7C9', roughness: 0.12, metalness: 0, clearcoat: 1, flatShading: true, sheen: 0.4, sheenColor: '#ffffff', vertexColors: true }),
      cut: new THREE.Color('#d8f0ff').multiplyScalar(1.6), // bright blue
      halfWidth: 0.14, slide: 0.05, hop: 0, topple: 0.3, twist: 0.2, fx: 'ice', weight: 3,
    };
  },
};

function buildTarget(key) {
  const def = TARGET_DEFS[key]();
  const group = new THREE.Group();
  group.position.y = BLOCK_H;
  const halves = [-1, 1].map((side) => {
    // Pivot at the outer bottom edge so halves topple outward.
    const pivot = new THREE.Group();
    pivot.position.x = side * def.halfWidth;
    const m = mesh(halfGeometry(def.geo, side, def.cut), def.material);
    m.position.x = -side * def.halfWidth;
    pivot.add(m);
    group.add(pivot);
    return { pivot, side };
  });
  if (key === 'bamboo') {
    const nodeMat = flat('#c4c98c', 0.6);
    halves.forEach(({ pivot, side }) => {
      const ring = mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 9).rotateZ(Math.PI / 2), nodeMat);
      ring.position.set(-side * def.halfWidth + side * 0.1, 0.032, 0);
      pivot.add(ring);
    });
  }
  if (key === 'paper') {
    // little clips holding the sheet upright (staging only)
    halves.forEach(({ pivot, side }) => {
      const clip = mesh(new THREE.BoxGeometry(0.02, 0.025, 0.02), mat.horn);
      clip.position.set(-side * def.halfWidth + side * 0.085, 0.0125, 0);
      pivot.add(clip);
    });
  }
  def.geo.dispose();
  const height = new THREE.Box3().setFromObject(group).max.y - BLOCK_H;
  return { group, halves, def, height };
}

function disposeTarget(target) {
  stage.remove(target.group);
  target.group.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      if (o.material !== mat.horn) o.material.dispose();
    }
  });
}

function stageWorld(local) {
  return stage.localToWorld(local.clone());
}

function impactFX(fx, at, success) {
  if (fx === 'metal' || (fx === 'ice' && !success)) burst(sparks, at, success ? 30 : 40, 1.2, HEAT_COLORS, 0.45);
  if (fx === 'ice') burst(drops, at, 36, 0.9, [ICE_COLOR, DROP_COLOR], 0.9);
  if (fx === 'wood' && success) burst(drops, at, 14, 0.5, [LEAF_COLOR], 0.6);
  if (success) burst(glints, at, 10, 0.4, GLINT_COLORS, 0.4);
}

// Hitstop + decaying screen shake (research: cap the stop; shake goes large -> small)
let hitstop = 0;
let shake = 0;
let shakeAmp = 0;
function impact(weight, success) {
  hitstop = Math.min(HITSTOP_MAX, success ? 0.05 + weight * 0.025 : 0.04);
  shake = 1;
  shakeAmp = success ? 0.006 + weight * 0.003 : 0.008;
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

async function chop(target, success) {
  const top = BLOCK_H + target.height;
  const raised = top + 0.2;
  chopRig.position.set(0, raised + 0.15, 0);
  chopRig.rotation.z = 0;
  chopRig.visible = true;
  await tween(0.35, (k) => (chopRig.position.y = lerp(raised + 0.15, raised, k)), easeOutCubic);
  await wait(0.25);
  audio.whoosh();

  if (success) {
    // Slow motion -> slash flash + hitstop/shake -> brief stillness -> halves separate -> normal speed.
    timeScale = 0.15;
    await tween(0.12, (k) => (chopRig.position.y = lerp(raised, BLOCK_H, k)), easeInCubic);
    timeScale = 1;
    audio.slice();
    impact(target.def.weight, true);
    flash(CLIMAX.slash, 0.75, 260);
    if (target.def.fx === 'ice') setTimeout(() => flash(CLIMAX.accent, 0.35, 90), 40); // red: a few frames only
    await wait(0.35);
    impactFX(target.def.fx, stageWorld(new THREE.Vector3(0, BLOCK_H + target.height * 0.5, 0)), true);
    const { slide, hop, topple, twist } = target.def;
    const pieces = tween(0.8, (k) => {
      for (const { pivot, side } of target.halves) {
        const homeX = side * target.def.halfWidth;
        pivot.position.x = homeX + side * slide * easeOutCubic(k);
        pivot.position.y = hop * 4 * k * (1 - k);
        pivot.rotation.z = -side * topple * easeOutBounce(k);
        pivot.rotation.y = side * twist * easeOutCubic(k);
      }
    });
    await wait(0.25);
    await tween(0.3, (k) => (chopRig.position.y = lerp(BLOCK_H, raised, k)), easeInOut);
    await pieces;
  } else {
    await tween(0.1, (k) => (chopRig.position.y = lerp(raised, top, k)), easeInCubic);
    audio.clank();
    impact(0, false);
    impactFX(target.def.fx === 'paper' || target.def.fx === 'wood' ? 'none' : target.def.fx, stageWorld(new THREE.Vector3(0, top, 0)), false);
    toast('彈開了');
    const baseY = target.group.position.y;
    await tween(0.7, (k) => {
      // knife bounces up with a decaying wobble; target shudders
      chopRig.position.y = top + 0.16 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) * (1 - k * 0.3);
      chopRig.rotation.z = Math.sin(k * 26) * 0.3 * (1 - k);
      target.group.position.x = Math.sin(k * 60) * 0.006 * (1 - k);
      target.group.position.y = baseY + Math.abs(Math.sin(k * 30)) * 0.004 * (1 - k);
    });
    chopRig.rotation.z = 0;
  }
}

async function runTest() {
  game.mode = 'test';
  document.body.classList.add('cine');
  drag = second = null;
  sliderPointer = null;
  audio.setGrind(0, 500);
  ui.testBtn.disabled = true;
  ui.slider.classList.add('hidden');
  ui.hud.classList.add('hidden');
  await tween(0.9, (k) => (camBlend = k), easeInOut);

  const passed = [];
  let failedTier = null;
  for (const tier of TIERS) {
    const target = buildTarget(tier.key);
    target.group.scale.setScalar(0.001);
    stage.add(target.group);
    toast(tier.name, 0.8);
    await tween(0.35, (k) => target.group.scale.setScalar(Math.max(0.001, easeOutBounce(k))));
    const ok = game.sharpness >= tier.need;
    await chop(target, ok);
    if (ok) {
      passed.push(tier);
      toast(`${tier.name} ✓`, 0.7);
    } else {
      failedTier = tier;
    }
    await wait(ok ? 0.5 : 0.4);
    await tween(0.25, (k) => target.group.scale.setScalar(Math.max(0.001, 1 - k)));
    disposeTarget(target);
    if (!ok) break;
  }
  chopRig.visible = false;
  showResult(passed, failedTier);
}

function showResult(passed, failedTier) {
  game.mode = 'result';
  const pct = Math.round(game.sharpness * 100);
  ui.resultTitle.textContent = RANKS[passed.length];
  const lines = [`鋒利度 <b>${pct}%</b>`];
  lines.push(passed.length ? `成功斬斷：<b>${passed.map((p) => p.name).join('、')}</b>` : '這次連紙都還切不開');
  if (failedTier) {
    lines.push(`${failedTier.name}：需要 ${Math.round(failedTier.need * 100)}%，再磨一下就好`);
    lines.push(`再穩一點：角度保持 ${BAND_LO}°–${BAND_HI}°，讓整條刃口都亮起來。`);
  } else {
    lines.push('連冰山都一刀兩斷，傳說中的名匠！');
  }
  ui.resultBody.innerHTML = lines.join('<br>');
  ui.result.classList.add('show');
}

async function backToSharpen(reset) {
  ui.result.classList.remove('show');
  document.body.classList.remove('cine');
  if (reset) {
    seg.progress.fill(0);
    seg.level.fill(0);
    seg.flash.fill(0);
    game.sharpness = 0;
    game.stage = 0;
    setAngle(START_ANGLE);
    game.knifeX = game.knifeTargetX = 0;
    game.wet = 0;
  }
  game.pressure = 0;
  game.speed = 0;
  await tween(0.8, (k) => (camBlend = 1 - k), easeInOut);
  ui.hud.classList.remove('hidden');
  ui.slider.classList.remove('hidden');
  ui.testBtn.disabled = false;
  game.mode = 'sharpen';
}

// ---------------------------------------------------------------------------
// Camera framing (fits both portrait phones and landscape screens)
// ---------------------------------------------------------------------------
let camBlend = 0; // 0 = whetstone view, 1 = test stage view
const SHARPEN_DIR = new THREE.Vector3(0.12, 0.8, 0.6).normalize();
const STAGE_DIR = new THREE.Vector3(0.62, 0.42, 0.66).normalize();

function fitDistance(halfW, halfH) {
  const vf = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hf = Math.atan(Math.tan(vf) * camera.aspect);
  return Math.max(halfW / Math.tan(hf), halfH / Math.tan(vf));
}

const camA = new THREE.Vector3();
const camB = new THREE.Vector3();
const lookA = new THREE.Vector3();
const lookB = new THREE.Vector3();

function updateCamera(t, realDt) {
  const portrait = camera.aspect < 1;
  // Look slightly above the stone on portrait so the HUD doesn't cover it.
  lookA.set(STATION_X + (portrait ? 0.09 : 0.06), TABLE_TOP + (portrait ? 0.05 : 0.03), 0.04);
  camA.copy(lookA).addScaledVector(SHARPEN_DIR, fitDistance(portrait ? 0.26 : 0.46, portrait ? 0.16 : 0.26));
  lookB.set(stage.position.x, STAGE_TOP + 0.14, stage.position.z);
  camB.copy(lookB).addScaledVector(STAGE_DIR, fitDistance(portrait ? 0.3 : 0.45, portrait ? 0.3 : 0.38));

  camera.position.lerpVectors(camA, camB, camBlend);
  camera.position.x += Math.sin(t * 0.5) * 0.006;
  camera.position.y += Math.sin(t * 0.37 + 1) * 0.004;
  camera.position.z += Math.cos(t * 0.41) * 0.004;
  if (shake > 0) {
    const a = shakeAmp * shake * shake; // decays large -> small
    camera.position.x += (Math.random() - 0.5) * 2 * a;
    camera.position.y += (Math.random() - 0.5) * 2 * a;
    shake = Math.max(0, shake - realDt / 0.35);
  }
  lookA.lerp(lookB, camBlend);
  camera.lookAt(lookA);
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
  camera.fov = camera.aspect < 1 ? 55 : 45;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(w, h);
  if (drag) drag.ppu = stonePixelsPerUnit();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
window.visualViewport?.addEventListener('resize', onResize);
onResize();

// Debug: ?demo=0.8 starts with that sharpness and runs the test cut immediately.
if (params.has('demo')) {
  seg.progress.fill(clamp(parseFloat(params.get('demo')) || 0, 0, 1));
  for (let i = 0; i < SEGS; i++) seg.level[i] = SEG_LEVELS.filter((l) => seg.progress[i] >= l).length;
  game.sharpness = seg.progress[0];
  game.stage = seg.level[0];
  setKnifeFinish(game.sharpness);
  runTest();
}

// ---------------------------------------------------------------------------
// Main loop (paused while the tab is hidden)
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const FPS_N = 60;
const frameTimes = new Float32Array(FPS_N);
let frameIdx = 0, frameCount = 0, frameSum = 0;
window.__fps = 0;

function frame() {
  const rawDt = clock.getDelta();
  const realDt = Math.min(rawDt, 0.05); // simulation step (clamped after stalls)
  const t = clock.elapsedTime;

  // Rolling FPS average from the true frame time (allocation-free ring buffer)
  frameSum += rawDt - frameTimes[frameIdx];
  frameTimes[frameIdx] = rawDt;
  frameIdx = (frameIdx + 1) % FPS_N;
  frameCount = Math.min(FPS_N, frameCount + 1);
  window.__fps = frameSum > 0 ? Math.round((frameCount / frameSum) * 10) / 10 : 0;

  // Hitstop: the world nearly freezes (still creeping), then resumes.
  let dt = realDt;
  if (hitstop > 0) {
    hitstop -= realDt;
    dt = realDt * 0.05;
  }

  updateTweens(dt * timeScale);
  if (game.mode === 'sharpen') updateSharpening(dt, t);
  else game.pressure = damp(game.pressure, 0, 6, dt);
  updateGleam(dt, t);
  updateHUD();
  updateAtmosphere(t);

  const floorY = camBlend > 0.5 ? STAGE_TOP + BLOCK_H : TABLE_TOP;
  sparks.update(dt * timeScale, floorY);
  drops.update(dt * timeScale, floorY);
  glints.update(dt * timeScale, -10);
  bamboo.update(t);
  updateCamera(t, realDt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(frame);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    renderer.setAnimationLoop(null);
    audio.setGrind(0, 500);
    audio.ctx?.suspend();
  } else {
    clock.getDelta(); // drop the hidden interval
    renderer.setAnimationLoop(frame);
    audio.ctx?.resume();
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
