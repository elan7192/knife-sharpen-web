import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const TARGET_ANGLE = 15;
const ANGLE_TOL = 3;
const ANGLE_MIN = 0;
const ANGLE_MAX = 30;
const START_ANGLE = 24;
const ANGLE_PER_PX = 0.06; // degrees per pixel of vertical finger movement
const PRESS_LO = 0.4;
const PRESS_HI = 0.72;
const STONE_LEN = 0.42;
const STONE_W = 0.13;
const STONE_TOP = 0.085; // stone surface height above the table top
const KNIFE_TRAVEL = STONE_LEN / 2 - 0.04;
const KNIFE_YAW = 2.44; // handle toward the player's right hand
const STATION_X = -0.35; // whetstone sits on the cloth, clear of the leaves baked into the table model

const TIERS = [
  { key: 'paper', name: '紙', need: 0.2 },
  { key: 'bamboo', name: '竹子', need: 0.45 },
  { key: 'iron', name: '鐵', need: 0.7 },
  { key: 'ice', name: '冰山', need: 0.9 },
];
const RANKS = ['鈍刀', '入門', '利刃', '名刀', '神品'];

const DRACO_PATH = 'https://unpkg.com/three@0.170.0/examples/jsm/libs/draco/gltf/';
const MODEL_TIMEOUT_MS = 12000;

const isTouch = matchMedia('(pointer: coarse)').matches;
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

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
const SKY = new THREE.Color('#a8bfae');
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 5, 14);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
pmrem.dispose();

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.02, 40);

// Lights
const hemi = new THREE.HemisphereLight('#e8f0ff', '#5a4a36', 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff1dc', 1.9);
sun.position.set(2.2, 4.5, 2.0);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(isTouch ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 12 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
const lanternLight = new THREE.PointLight('#ffb35c', 1.2, 3, 2);
scene.add(lanternLight);

// ---------------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------------
const mat = {
  wood: new THREE.MeshStandardMaterial({ color: '#8a5a36', roughness: 0.8, flatShading: true }),
  darkWood: new THREE.MeshStandardMaterial({ color: '#4a2f1d', roughness: 0.75, flatShading: true }),
  handle: new THREE.MeshStandardMaterial({ color: '#7a5434', roughness: 0.65 }),
  horn: new THREE.MeshStandardMaterial({ color: '#1a1512', roughness: 0.35 }),
  stoneTop: new THREE.MeshStandardMaterial({ color: '#c06b3e', roughness: 0.85 }),
  stoneBottom: new THREE.MeshStandardMaterial({ color: '#7b8789', roughness: 0.9 }),
  rubber: new THREE.MeshStandardMaterial({ color: '#2a2d2b', roughness: 0.95 }),
  rock: new THREE.MeshStandardMaterial({ color: '#7d7f78', roughness: 0.95, flatShading: true }),
  sand: new THREE.MeshStandardMaterial({ color: '#d6ccb4', roughness: 1 }),
  water: new THREE.MeshPhysicalMaterial({ color: '#4d6b6e', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.85 }),
  blade: new THREE.MeshPhysicalMaterial({ color: '#e6e9ee', metalness: 1, roughness: 0.6, envMapIntensity: 1.4 }),
};

// ---------------------------------------------------------------------------
// World layout
// ---------------------------------------------------------------------------
let tableTop = 0.78; // updated once the table model is fitted
const onTable = new THREE.Group();
onTable.position.y = tableTop;
scene.add(onTable);

const STAGE_POS = new THREE.Vector3(1.55, 0, -0.35);
let stageTop = 0.7;
const stage = new THREE.Group();
stage.position.set(STAGE_POS.x, stageTop, STAGE_POS.z);
scene.add(stage);

function enableShadows(obj, cast = true, receive = true) {
  obj.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
  return obj;
}

function mesh(geo, material, cast = true, receive = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

// Ground: raked sand + a moss ring
{
  const ground = mesh(new THREE.CircleGeometry(30, 48), mat.sand, false, true);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const rakeMat = new THREE.MeshStandardMaterial({ color: '#c9bea4', roughness: 1 });
  for (let i = 0; i < 9; i++) {
    const ring = mesh(new THREE.RingGeometry(2.4 + i * 0.35, 2.46 + i * 0.35, 64), rakeMat, false, true);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    scene.add(ring);
  }
  const moss = mesh(new THREE.CircleGeometry(0.9, 9), new THREE.MeshStandardMaterial({ color: '#5f7a3c', roughness: 1, flatShading: true }), false, true);
  moss.rotation.x = -Math.PI / 2;
  moss.position.set(-2.4, 0.003, -1.1);
  moss.scale.set(1.4, 1, 1);
  scene.add(moss);
}

// Whetstone on a wooden holder with a rubber base
const stoneGroup = new THREE.Group();
{
  const base = mesh(new THREE.BoxGeometry(STONE_LEN + 0.08, 0.02, STONE_W + 0.06), mat.rubber);
  base.position.y = 0.01;
  const holder = mesh(new THREE.BoxGeometry(STONE_LEN + 0.04, 0.025, STONE_W + 0.03), mat.darkWood);
  holder.position.y = 0.0325;
  const bottom = mesh(new THREE.BoxGeometry(STONE_LEN, 0.015, STONE_W), mat.stoneBottom);
  bottom.position.y = 0.0525;
  const top = mesh(new THREE.BoxGeometry(STONE_LEN, 0.025, STONE_W), mat.stoneTop);
  top.position.y = STONE_TOP - 0.0125;
  stoneGroup.add(base, holder, bottom, top);
  stoneGroup.position.x = STATION_X;
}
onTable.add(stoneGroup);

// Water bucket for flavour
{
  const bucket = new THREE.Group();
  const shell = mesh(new THREE.CylinderGeometry(0.11, 0.095, 0.14, 12, 1, true), mat.wood);
  shell.material = shell.material.clone();
  shell.material.side = THREE.DoubleSide;
  shell.position.y = 0.07;
  const floor = mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.01, 12), mat.wood);
  floor.position.y = 0.005;
  const band = mesh(new THREE.TorusGeometry(0.105, 0.006, 4, 12), mat.horn);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.1;
  const water = mesh(new THREE.CircleGeometry(0.102, 12), mat.water, false, false);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.11;
  bucket.add(shell, floor, band, water);
  bucket.position.set(0.0, 0, -0.4);
  onTable.add(bucket);
}

// ---------------------------------------------------------------------------
// Bamboo grove (instanced, gently swaying)
// ---------------------------------------------------------------------------
const bamboo = (() => {
  const SEG_H = 0.42;
  const stalks = [];
  let rnd = 7;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
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
      tint: 0.8 + rand() * 0.3,
    });
  }
  const totalSegs = stalks.reduce((n, s) => n + s.segs, 0);
  const segGeo = new THREE.CylinderGeometry(1, 1, SEG_H, 7);
  segGeo.translate(0, SEG_H / 2, 0);
  const nodeGeo = new THREE.CylinderGeometry(1.18, 1.18, 0.03, 7);
  const leafGeo = new THREE.ConeGeometry(0.05, 0.36, 3);
  leafGeo.rotateZ(Math.PI / 2);
  leafGeo.scale(1, 1, 0.25);
  leafGeo.translate(0.18, 0, 0);

  const segMesh = new THREE.InstancedMesh(segGeo, new THREE.MeshStandardMaterial({ color: '#6f9a45', roughness: 0.6, flatShading: true }), totalSegs);
  const nodeMesh = new THREE.InstancedMesh(nodeGeo, new THREE.MeshStandardMaterial({ color: '#c2c98a', roughness: 0.7, flatShading: true }), totalSegs);
  const LEAVES_PER = 14;
  const leafMesh = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: '#4f7f35', roughness: 0.8, flatShading: true, side: THREE.DoubleSide }), stalks.length * LEAVES_PER);
  segMesh.castShadow = true;
  leafMesh.castShadow = true;
  const color = new THREE.Color();
  let k = 0;
  stalks.forEach((s, si) => {
    for (let j = 0; j < s.segs; j++, k++) segMesh.setColorAt(k, color.setRGB(s.tint, s.tint, s.tint * 0.9));
    for (let j = 0; j < LEAVES_PER; j++) leafMesh.setColorAt(si * LEAVES_PER + j, color.setRGB(0.8 + rand() * 0.4, 0.9 + rand() * 0.2, 0.8));
    s.leaves = Array.from({ length: LEAVES_PER }, () => ({
      seg: s.segs - 4 + Math.floor(rand() * 4),
      yaw: rand() * Math.PI * 2,
      droop: -0.2 - rand() * 0.6,
      scale: 0.7 + rand() * 0.6,
    }));
  });
  scene.add(segMesh, nodeMesh, leafMesh);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const dir = new THREE.Vector3();

  function update(t) {
    let si = 0, li = 0;
    for (const s of stalks) {
      const sway = Math.sin(t * 0.8 + s.phase) * 0.018 + Math.sin(t * 1.9 + s.phase * 2) * 0.006;
      p.set(s.x, 0, s.z);
      const joints = [];
      for (let j = 0; j < s.segs; j++) {
        const bend = s.lean + sway * (j / s.segs) * 2.2;
        e.set(0, 0, bend);
        q.setFromEuler(e);
        sc.set(s.radius, 1, s.radius);
        m4.compose(p, q, sc);
        segMesh.setMatrixAt(si, m4);
        joints.push({ pos: p.clone(), q: q.clone() });
        dir.set(0, SEG_H, 0).applyQuaternion(q);
        p.add(dir);
        sc.set(s.radius, 1, s.radius);
        m4.compose(p, q, sc);
        nodeMesh.setMatrixAt(si, m4);
        si++;
      }
      for (const leaf of s.leaves) {
        const jt = joints[leaf.seg];
        e.set(0, leaf.yaw + sway * 3, leaf.droop + sway * 4, 'YXZ');
        q.setFromEuler(e);
        sc.setScalar(leaf.scale);
        m4.compose(jt.pos, q, sc);
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
// Knife
// ---------------------------------------------------------------------------
const BLADE_LEN = 0.245;
const BLADE_H = 0.046;
const CONTACT_X = 0.12; // point along the edge that rides the stone

function buildKnife() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(0.17, 0);
  shape.quadraticCurveTo(0.228, 0.002, BLADE_LEN, 0.039);
  shape.lineTo(0, BLADE_H);
  shape.lineTo(0, 0);
  const depth = 0.0026;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 10 });
  geo.translate(0, 0, -depth / 2);
  // Flat-grind taper: thin at the edge, full thickness at the spine.
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setZ(i, pos.getZ(i) * lerp(0.08, 1, clamp(y / BLADE_H, 0, 1)));
  }
  geo.computeVertexNormals();

  const knife = new THREE.Group();
  const blade = mesh(geo, mat.blade);
  const handle = mesh(new THREE.CylinderGeometry(0.0115, 0.0125, 0.125, 8), mat.handle);
  handle.rotation.z = Math.PI / 2;
  handle.position.set(-0.075, 0.032, 0);
  const ferrule = mesh(new THREE.CylinderGeometry(0.0128, 0.0128, 0.02, 8), mat.horn);
  ferrule.rotation.z = Math.PI / 2;
  ferrule.position.set(-0.008, 0.032, 0);
  knife.add(blade, handle, ferrule);
  knife.position.x = -CONTACT_X;
  return knife;
}

// Sharpening knife: root (slides along stone) -> tilt (blade angle) -> knife
const knifeRoot = new THREE.Group();
knifeRoot.rotation.y = KNIFE_YAW;
knifeRoot.position.set(STATION_X, STONE_TOP + 0.0005, 0);
const knifeTilt = new THREE.Group();
knifeRoot.add(knifeTilt);
knifeTilt.add(buildKnife());
onTable.add(knifeRoot);

// Test-cut knife, held blade-vertical above the stage
const chopRig = new THREE.Group();
chopRig.rotation.y = Math.PI / 2;
chopRig.add(buildKnife());
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
// GLB models (optional, each with a primitive fallback)
// ---------------------------------------------------------------------------
const gltfLoader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath(DRACO_PATH);
gltfLoader.setDRACOLoader(draco);

const modelCache = new Map();
function loadGLB(name) {
  if (!modelCache.has(name)) {
    const load = gltfLoader.loadAsync(`./models/${name}.glb`).then((g) => g.scene);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), MODEL_TIMEOUT_MS));
    modelCache.set(name, Promise.race([load, timeout]));
  }
  return modelCache.get(name).then((root) => root.clone(true));
}

/** Scales a model uniformly so it fits inside `fit` (any axis may be omitted), sits on y=0, centred in xz. */
function normalize(root, fit) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const ratios = ['x', 'y', 'z'].filter((a) => fit[a] && size[a] > 0).map((a) => fit[a] / size[a]);
  const s = ratios.length ? Math.min(...ratios) : 1;
  const center = box.getCenter(new THREE.Vector3());
  root.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  root.scale.setScalar(s);
  const wrap = new THREE.Group();
  wrap.add(root);
  return { wrap, size: size.multiplyScalar(s) };
}

async function placeModel(name, { fit, position, rotY = 0, parent = scene }, fallback) {
  let obj, size;
  try {
    ({ wrap: obj, size } = normalize(await loadGLB(name), fit));
    enableShadows(obj);
  } catch {
    obj = enableShadows(fallback());
    size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  }
  obj.position.copy(position);
  obj.rotation.y = rotY;
  parent.add(obj);
  return { obj, size };
}

/**
 * Height of the dominant flat surface of `obj` (e.g. a table top), found by casting rays down over
 * its central area. More robust than the bounding box, which includes props lying on the surface.
 */
function surfaceHeight(obj, halfX, halfZ) {
  obj.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const counts = new Map();
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      ray.set(new THREE.Vector3(obj.position.x + (i / 3) * halfX, 10, obj.position.z + (j / 3) * halfZ), down);
      const hit = ray.intersectObject(obj, true)[0];
      if (!hit) continue;
      const y = Math.round(hit.point.y * 200) / 200;
      counts.set(y, (counts.get(y) || 0) + 1);
    }
  }
  let best = null, bestN = 0;
  for (const [y, n] of counts) if (n > bestN) [best, bestN] = [y, n];
  return best;
}

// Primitive fallbacks
function fallbackTable() {
  const g = new THREE.Group();
  const top = mesh(new THREE.BoxGeometry(2, 0.06, 1.5), mat.wood);
  top.position.y = 0.75;
  g.add(top);
  for (const [x, z] of [[-0.9, -0.65], [0.9, -0.65], [-0.9, 0.65], [0.9, 0.65]]) {
    const leg = mesh(new THREE.BoxGeometry(0.08, 0.72, 0.08), mat.darkWood);
    leg.position.set(x, 0.36, z);
    g.add(leg);
  }
  return g;
}
function fallbackRoundTable() {
  const g = new THREE.Group();
  const top = mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.05, 16), mat.wood);
  top.position.y = 0.675;
  const post = mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.65, 8), mat.darkWood);
  post.position.y = 0.325;
  const foot = mesh(new THREE.CylinderGeometry(0.25, 0.28, 0.04, 12), mat.darkWood);
  foot.position.y = 0.02;
  g.add(top, post, foot);
  return g;
}
function fallbackRocks(n = 4, spread = 0.5, size = 0.3) {
  const g = new THREE.Group();
  for (let i = 0; i < n; i++) {
    const r = size * (0.5 + 0.5 * ((i * 37) % 10) / 10);
    const rock = mesh(new THREE.DodecahedronGeometry(r, 0), mat.rock);
    rock.position.set(Math.cos(i * 2.4) * spread * (i / n), r * 0.6, Math.sin(i * 2.4) * spread * (i / n));
    rock.rotation.set(i, i * 2, 0);
    g.add(rock);
  }
  return g;
}
function fallbackBoulder() {
  const m = new THREE.MeshStandardMaterial({ color: '#b9a27a', roughness: 1, flatShading: true });
  const b = mesh(new THREE.IcosahedronGeometry(0.5, 0), m);
  b.scale.set(1.2, 0.9, 1);
  b.position.y = 0.4;
  return new THREE.Group().add(b);
}
function fallbackSteppingStones() {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const s = mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.08, 7), mat.rock);
    s.position.set((i % 2) * 0.15, 0.04, i * 0.65 - 1);
    g.add(s);
  }
  return g;
}
function fallbackFlagstone() {
  const s = mesh(new THREE.BoxGeometry(0.85, 0.05, 0.85), new THREE.MeshStandardMaterial({ color: '#8e8a80', roughness: 1 }));
  s.position.y = 0.025;
  return new THREE.Group().add(s);
}
function fallbackLantern() {
  const g = new THREE.Group();
  const base = mesh(new THREE.BoxGeometry(0.1, 0.02, 0.1), mat.horn);
  base.position.y = 0.01;
  const glow = mesh(new THREE.BoxGeometry(0.08, 0.12, 0.08), new THREE.MeshStandardMaterial({ color: '#ffe2b0', emissive: '#ffae52', emissiveIntensity: 1.2 }));
  glow.position.y = 0.08;
  const roof = mesh(new THREE.ConeGeometry(0.09, 0.06, 4), mat.horn);
  roof.position.y = 0.17;
  roof.rotation.y = Math.PI / 4;
  g.add(base, glow, roof);
  return g;
}

const LANTERN_POS = new THREE.Vector3(-0.72, 0, -0.42);
const LANTERN_H = 0.24;

const modelJobs = [
  placeModel('plank-table', { fit: { x: 2.2, y: 0.78, z: 1.7 }, position: new THREE.Vector3() }, fallbackTable).then(({ obj, size }) => {
    tableTop = surfaceHeight(obj, size.x * 0.3, size.z * 0.25) ?? size.y;
    onTable.position.y = tableTop;
  }),
  placeModel('round-table', { fit: { x: 1.1, y: 0.7, z: 1.1 }, position: new THREE.Vector3(STAGE_POS.x, 0, STAGE_POS.z) }, fallbackRoundTable).then(({ obj, size }) => {
    stageTop = surfaceHeight(obj, size.x * 0.25, size.z * 0.25) ?? size.y;
    stage.position.y = stageTop;
  }),
  placeModel('oil-lantern', { fit: { y: LANTERN_H }, position: LANTERN_POS, rotY: 0.6, parent: onTable }, fallbackLantern),
  placeModel('stepping-stones', { fit: { z: 2.6 }, position: new THREE.Vector3(-1.75, 0, 1.0), rotY: 0.35 }, fallbackSteppingStones),
  placeModel('rock-cluster', { fit: { y: 0.45 }, position: new THREE.Vector3(-2.3, 0, -1.15), rotY: 0.8 }, () => fallbackRocks(5, 0.6, 0.25)),
  placeModel('rock-cluster', { fit: { y: 0.3 }, position: new THREE.Vector3(0.9, 0, -1.9), rotY: 2.1 }, () => fallbackRocks(3, 0.4, 0.18)),
  placeModel('sandstone-boulder', { fit: { y: 0.95 }, position: new THREE.Vector3(2.9, 0, -1.7), rotY: -0.5 }, fallbackBoulder),
  placeModel('sandstone-boulder', { fit: { y: 0.5 }, position: new THREE.Vector3(-3.2, 0, 0.4), rotY: 1.4 }, fallbackBoulder),
  ...[-0.9, 0.05, 1.0, 1.95].map((x, i) =>
    placeModel('flagstone-path-tile-01', { fit: { x: 0.9, z: 0.9 }, position: new THREE.Vector3(x, 0, 1.45 + (i % 2) * 0.08), rotY: i * 1.3 }, fallbackFlagstone)
  ),
];
Promise.allSettled(modelJobs).then(() => draco.dispose());

// ---------------------------------------------------------------------------
// Particles (sparks + water droplets)
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
    this.cursor = (this.cursor + 1) % this.max;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.base.set([color.r, color.g, color.b], i * 3);
    this.life[i] = this.maxLife[i] = life;
  }

  update(dt, floorY) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3;
      if (this.life[i] <= 0) {
        this.pos[i3 + 1] = -999;
        this.col[i * 4 + 3] = 0;
        continue;
      }
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
      const k = this.life[i] / this.maxLife[i];
      this.col.set([this.base[i3], this.base[i3 + 1], this.base[i3 + 2], Math.min(1, k * 1.5)], i * 4);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

const sparks = new Particles(260, { size: 0.012, additive: true, gravity: 5 });
const drops = new Particles(220, { size: 0.01, additive: false, gravity: 4 });
const tmpV = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const SPARK_COLORS = ['#ffd27a', '#ffb347', '#fff2c4'].map((c) => new THREE.Color(c));
const DROP_COLOR = new THREE.Color('#cfe8ff');
const ICE_COLOR = new THREE.Color('#e8f8ff');

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
      if (this.ctx.state === 'suspended') this.ctx.resume();
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
  tone(freq, duration, vol, type = 'sine') {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + duration + 0.05);
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
// HUD
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const ui = {
  sharpFill: $('sharpFill'), sharpText: $('sharpText'),
  angleLight: $('angleLight'), angleText: $('angleText'),
  pressFill: $('pressFill'), pressZone: $('pressZone'),
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
sliderZone.style.top = `${angleToPct(TARGET_ANGLE + ANGLE_TOL)}%`;
sliderZone.style.height = `${angleToPct(TARGET_ANGLE - ANGLE_TOL) - angleToPct(TARGET_ANGLE + ANGLE_TOL)}%`;
const DEFAULT_HINT = ui.hint.textContent;

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
};

const angleError = () => Math.abs(game.angle - TARGET_ANGLE);
const angleOK = () => angleError() <= ANGLE_TOL;
const pressureOK = () => game.pressure >= PRESS_LO && game.pressure <= PRESS_HI;

function setAngle(a) {
  game.angle = clamp(a, ANGLE_MIN, ANGLE_MAX);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let drag = null; // primary pointer: x -> stroke, y -> angle
let second = null; // secondary pointer: y -> angle

function stonePixelsPerUnit() {
  const a = new THREE.Vector3(STATION_X - STONE_LEN / 2, STONE_TOP, 0);
  const b = new THREE.Vector3(STATION_X + STONE_LEN / 2, STONE_TOP, 0);
  onTable.localToWorld(a).project(camera);
  onTable.localToWorld(b).project(camera);
  const px = Math.abs(b.x - a.x) * 0.5 * window.innerWidth;
  // Keep strokes comfortable on large screens: never require more than ~45% of the width per stone length.
  return clamp(px, 200, window.innerWidth * 0.45) / STONE_LEN;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || audio.ctx) audio.unlock();
  if (game.mode !== 'sharpen') return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  if (!drag) {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ppu: stonePixelsPerUnit() };
    game.hold = 0;
  } else if (!second) {
    second = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (drag && e.pointerId === drag.id) {
    game.knifeTargetX = clamp(game.knifeTargetX + (e.clientX - drag.x) / drag.ppu, -KNIFE_TRAVEL, KNIFE_TRAVEL);
    if (!second) setAngle(game.angle + (drag.y - e.clientY) * ANGLE_PER_PX);
    drag.x = e.clientX;
    drag.y = e.clientY;
  } else if (second && e.pointerId === second.id) {
    setAngle(game.angle + (second.y - e.clientY) * ANGLE_PER_PX);
    second.x = e.clientX;
    second.y = e.clientY;
  }
});

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
// iOS Safari pinch / double-tap zoom guards
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
['pointerup', 'touchend', 'click', 'keydown'].forEach((type) => window.addEventListener(type, () => audio.unlock(), { passive: true }));

// Secondary angle slider (works alongside the stroke finger)
function sliderSet(e) {
  const r = sliderTrack.getBoundingClientRect();
  setAngle(ANGLE_MAX - ((e.clientY - r.top) / r.height) * (ANGLE_MAX - ANGLE_MIN));
}
ui.slider.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || audio.ctx) audio.unlock();
  if (game.mode !== 'sharpen') return;
  ui.slider.setPointerCapture(e.pointerId);
  sliderSet(e);
});
ui.slider.addEventListener('pointermove', (e) => {
  if (ui.slider.hasPointerCapture(e.pointerId)) sliderSet(e);
});

ui.testBtn.addEventListener('click', () => {
  if (game.mode === 'sharpen') runTest();
});
ui.againBtn.addEventListener('click', () => backToSharpen(false));
ui.restartBtn.addEventListener('click', () => backToSharpen(true));

// ---------------------------------------------------------------------------
// Sharpening simulation
// ---------------------------------------------------------------------------
const contact = new THREE.Vector3();

function updateSharpening(dt, t) {
  const down = !!drag;
  const prevX = game.knifeX;
  game.knifeX = damp(game.knifeX, game.knifeTargetX, 22, dt);
  const v = (game.knifeX - prevX) / Math.max(dt, 1e-4);
  game.speed = damp(game.speed, Math.abs(v), 10, dt);

  // Pressure: leaning in while held, plus stroke speed.
  game.hold = down ? Math.min(1, game.hold + dt * 2.5) : 0;
  const targetPressure = down ? 0.2 * game.hold + game.speed * 0.8 : 0;
  game.pressure = damp(game.pressure, clamp(targetPressure, 0, 1), down ? 6 : 4, dt);

  const grinding = down && game.speed > 0.05;
  if (grinding) {
    // Hands are never perfectly steady: a little drift the player must correct.
    setAngle(game.angle + (Math.sin(t * 1.3) + Math.sin(t * 2.9 + 1)) * 0.9 * dt);
    game.wet = Math.min(1, game.wet + dt * 0.5);
  } else {
    game.wet = Math.max(0, game.wet - dt * 0.04);
  }

  if (grinding && angleOK() && pressureOK()) {
    const quality = 1 - (angleError() / ANGLE_TOL) * 0.5;
    game.sharpness = Math.min(1, game.sharpness + dt * 0.075 * quality * (1 - game.sharpness * 0.45));
  } else if (grinding && (angleError() > 7 || game.pressure > 0.88)) {
    game.sharpness = Math.max(0, game.sharpness - dt * 0.025);
  }

  // Knife pose
  knifeRoot.position.x = STATION_X + game.knifeX;
  knifeRoot.position.z = Math.sin(game.knifeX * 9) * 0.008;
  knifeTilt.rotation.x = THREE.MathUtils.degToRad(90 - game.angle);
  mat.blade.roughness = lerp(0.6, 0.05, game.sharpness);
  mat.stoneTop.roughness = lerp(0.85, 0.3, game.wet);

  // Particles at the contact point
  knifeRoot.getWorldPosition(contact);
  if (grinding) {
    const dirX = Math.sign(v) || 1;
    game.dropAcc += dt * game.speed * 90;
    while (game.dropAcc >= 1) {
      game.dropAcc -= 1;
      tmpP.copy(contact).add(tmpV.set((Math.random() - 0.5) * 0.12, 0.002, (Math.random() - 0.5) * 0.08));
      tmpV.set(dirX * (0.2 + Math.random() * 0.5) * game.speed * 2, 0.3 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4);
      drops.emit(tmpP, tmpV, DROP_COLOR, 0.6 + Math.random() * 0.4);
    }
    game.sparkAcc += dt * Math.max(0, game.pressure - 0.3) * game.speed * 260;
    while (game.sparkAcc >= 1) {
      game.sparkAcc -= 1;
      tmpV.set(-dirX * (0.6 + Math.random() * 1.2), 0.4 + Math.random() * 1.1, (Math.random() - 0.5) * 0.8);
      sparks.emit(contact, tmpV, SPARK_COLORS[(Math.random() * 3) | 0], 0.25 + Math.random() * 0.3);
    }
  }

  audio.setGrind(grinding ? Math.min(0.55, game.speed * 0.9) * (0.35 + game.pressure) : 0, 500 + game.speed * 1600 + game.pressure * 600);

  // Coaching hint (throttled to avoid flicker)
  game.hintTimer -= dt;
  if (game.hintTimer <= 0) {
    game.hintTimer = 0.3;
    let msg = DEFAULT_HINT;
    if (down) {
      if (game.angle > TARGET_ANGLE + ANGLE_TOL) msg = '角度太陡 ↓ 手指往下';
      else if (game.angle < TARGET_ANGLE - ANGLE_TOL) msg = '角度太平 ↑ 手指往上';
      else if (!grinding) msg = '角度正確，來回推拉！';
      else if (game.pressure < PRESS_LO) msg = '壓力太輕，推快一點';
      else if (game.pressure > PRESS_HI) msg = '壓力太重，放慢一點';
      else msg = '很好！保持角度與節奏';
    }
    if (ui.hint.textContent !== msg) ui.hint.textContent = msg;
  }
}

function updateHUD() {
  const s = Math.round(game.sharpness * 100);
  ui.sharpFill.style.width = `${s}%`;
  ui.sharpText.textContent = `${s}%`;
  const err = angleError();
  ui.angleLight.className = err <= ANGLE_TOL ? 'good' : err <= ANGLE_TOL * 2 ? 'near' : '';
  ui.angleText.textContent = `${game.angle.toFixed(1)}°`;
  ui.pressFill.style.width = `${Math.round(game.pressure * 100)}%`;
  ui.pressFill.className = `fill${pressureOK() ? ' good' : game.pressure > PRESS_HI ? ' high' : ''}`;
  sliderThumb.style.top = `${angleToPct(game.angle)}%`;
}

// ---------------------------------------------------------------------------
// Test-cut targets
// ---------------------------------------------------------------------------
/** Clamps every vertex to one side of the x=0 plane: a cheap, exact "cut" for flat-shaded meshes. */
function halfGeometry(geo, side) {
  const g = geo.clone();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, side < 0 ? Math.min(p.getX(i), 0) : Math.max(p.getX(i), 0));
  g.computeVertexNormals();
  return g;
}

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

const TARGET_DEFS = {
  paper: () => ({
    geo: new THREE.BoxGeometry(0.2, 0.24, 0.003, 2, 1, 1).translate(0, 0.12, 0),
    material: new THREE.MeshStandardMaterial({ color: '#f4efe2', roughness: 0.9, side: THREE.DoubleSide }),
    halfWidth: 0.1, slide: 0.01, hop: 0, topple: 1.45, twist: 0.15, fx: 'paper',
  }),
  bamboo: () => ({
    geo: new THREE.CylinderGeometry(0.032, 0.032, 0.36, 9, 6).rotateZ(Math.PI / 2).translate(0, 0.032, 0),
    material: new THREE.MeshStandardMaterial({ color: '#7fa64a', roughness: 0.55, flatShading: true }),
    halfWidth: 0.18, slide: 0.1, hop: 0.07, topple: 0, twist: 0.6, fx: 'wood',
  }),
  iron: () => ({
    geo: new THREE.BoxGeometry(0.32, 0.045, 0.055, 2, 1, 1).translate(0, 0.0225, 0),
    material: new THREE.MeshStandardMaterial({ color: '#5d6166', metalness: 0.85, roughness: 0.38, flatShading: true }),
    halfWidth: 0.16, slide: 0.06, hop: 0.04, topple: 0, twist: 0.3, fx: 'metal',
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
      material: new THREE.MeshPhysicalMaterial({ color: '#cdeeff', roughness: 0.12, metalness: 0, clearcoat: 1, flatShading: true, sheen: 0.4, sheenColor: '#ffffff' }),
      halfWidth: 0.14, slide: 0.05, hop: 0, topple: 0.3, twist: 0.2, fx: 'ice',
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
    const m = mesh(halfGeometry(def.geo, side), def.material);
    m.position.x = -side * def.halfWidth;
    pivot.add(m);
    group.add(pivot);
    return { pivot, side };
  });
  if (key === 'bamboo') {
    const nodeMat = new THREE.MeshStandardMaterial({ color: '#c4c98c', roughness: 0.6, flatShading: true });
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
      o.material.dispose?.();
    }
  });
}

function stageWorld(local) {
  return stage.localToWorld(local.clone());
}

function impactFX(fx, at, success) {
  if (fx === 'metal' || (fx === 'ice' && !success)) burst(sparks, at, success ? 30 : 45, 1.2, SPARK_COLORS, 0.45);
  if (fx === 'ice') burst(drops, at, 40, 0.9, [ICE_COLOR, DROP_COLOR], 0.9);
  if (fx === 'wood' && success) burst(drops, at, 14, 0.5, [new THREE.Color('#b7d38a')], 0.6);
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
    await tween(0.12, (k) => (chopRig.position.y = lerp(raised, BLOCK_H, k)), easeInCubic);
    audio.slice();
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
    impactFX(target.def.fx === 'paper' || target.def.fx === 'wood' ? 'none' : target.def.fx, stageWorld(new THREE.Vector3(0, top, 0)), false);
    toast('彈開！');
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
  drag = second = null;
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
  lines.push(passed.length ? `成功斬斷：<b>${passed.map((p) => p.name).join('、')}</b>` : '連紙都切不開…');
  if (failedTier) {
    lines.push(`${failedTier.name}：刀被彈開（需要 ${Math.round(failedTier.need * 100)}%）`);
    lines.push('提示：保持 15° 並讓壓力停在綠區。');
  } else {
    lines.push('連冰山都一刀兩斷，傳說中的名匠！');
  }
  ui.resultBody.innerHTML = lines.join('<br>');
  ui.result.classList.add('show');
}

async function backToSharpen(reset) {
  ui.result.classList.remove('show');
  if (reset) {
    game.sharpness = 0;
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
const SHARPEN_DIR = new THREE.Vector3(0.12, 0.72, 0.68).normalize();
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

function updateCamera(t) {
  const portrait = camera.aspect < 1;
  // Look slightly above the stone on portrait so the HUD doesn't cover it.
  lookA.set(STATION_X + (portrait ? 0.035 : 0), tableTop + (portrait ? 0.07 : 0.04), 0.02);
  camA.copy(lookA).addScaledVector(SHARPEN_DIR, fitDistance(portrait ? 0.34 : 0.55, portrait ? 0.18 : 0.3));
  lookB.set(stage.position.x, stageTop + 0.14, stage.position.z);
  camB.copy(lookB).addScaledVector(STAGE_DIR, fitDistance(portrait ? 0.3 : 0.45, portrait ? 0.3 : 0.38));

  camera.position.lerpVectors(camA, camB, camBlend);
  camera.position.x += Math.sin(t * 0.5) * 0.012;
  camera.position.y += Math.sin(t * 0.37 + 1) * 0.008;
  camera.position.z += Math.cos(t * 0.41) * 0.008;
  lookA.lerp(lookB, camBlend);
  camera.lookAt(lookA);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.fov = camera.aspect < 1 ? 55 : 45;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);
onResize();

document.addEventListener('visibilitychange', () => {
  if (!audio.ctx) return;
  if (document.hidden) audio.ctx.suspend();
  else audio.ctx.resume();
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  updateTweens(dt);
  if (game.mode === 'sharpen') updateSharpening(dt, t);
  else game.pressure = damp(game.pressure, 0, 6, dt);
  updateHUD();

  lanternLight.position.set(LANTERN_POS.x, tableTop + LANTERN_H * 0.55, LANTERN_POS.z);
  lanternLight.intensity = 1.1 + Math.sin(t * 9) * 0.08 + Math.sin(t * 23) * 0.05;

  const floorY = camBlend > 0.5 ? stageTop + BLOCK_H : tableTop;
  sparks.update(dt, floorY);
  drops.update(dt, floorY);
  bamboo.update(t);
  updateCamera(t);
  renderer.render(scene, camera);
});
