import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Material knives (素材刀). Each one is a whole run: start dull → climb the grit ladder → test →
// cut its goal target. The rusty kitchen knife is the main metal line; the rest unlock in order.
//   max     highest sharpness the material can hold (鈍度上限), whatever the stone
//   rate    grinding speed multiplier (soft materials grind fast, jelly wobbles off the stone)
//   start   sharpness when the run starts; rust = starting rust on every edge segment (0..1)
//   goal    target id whose clean cut completes the run and unlocks the next material
//   chips   particle colours shed while grinding (replaces the stone slurry tint)
//   grit    extra crackle in the grind sound (crunchy pasta, gritty stone)
//   wobble  blade jiggle amplitude while grinding (jelly)
//   r0/r1   surface roughness dull → sharp (the edge gleam line is drawn for every material)
//   intro / mid / done: original narration (shown at start, on first 利 grade, on the goal cut)
// All copy is original. No textures or models are loaded: every look below is painted on a canvas.
// ---------------------------------------------------------------------------
export const MATERIALS = [
  {
    id: 'rusty', name: '鐵鏽菜刀', short: '鐵鏽', kind: 'metal', max: 1, rate: 1, start: 0.02, rust: 1, goal: 'bottle',
    chips: null, grit: 0, wobble: 0, r0: 0.38, r1: 0.12,
    intro: '老家倉庫最深處挖出來的。它上一次切東西，大概是上個世紀。',
    mid: '鏽底下，原來還睡著一把刀。',
    done: '從廢鐵到一刀斷瓶。這把刀，回來了。',
  },
  {
    id: 'cardboard', name: '紙板刀', short: '紙板', kind: 'cardboard', max: 0.6, rate: 1.7, start: 0, goal: 'bottle',
    chips: ['#C9A57A', '#8A6A48', '#E8D6B8'], grit: 0.25, wobble: 0, r0: 1, r1: 0.85,
    intro: '昨天它還是快遞箱。今天，它想當一把刀。',
    mid: '紙纖維被壓得比你的決心還緊。',
    done: '紙板切開了寶特瓶。快遞箱們，你們也可以有夢想。',
  },
  {
    id: 'pasta', name: '義大利麵刀', short: '麵', kind: 'pasta', max: 0.5, rate: 1.25, start: 0, goal: 'rope',
    chips: ['#F2D27A', '#E3B65A', '#FFF2C4'], grit: 0.6, wobble: 0, r0: 0.7, r1: 0.45,
    intro: '八百根乾麵條，用麵糊黏成一片刀身。煮之前，先讓它切一次東西。',
    mid: '請不要在磨刀途中把它丟進滾水。',
    done: '麵條切斷了繩子。今晚的晚餐，有點捨不得下鍋。',
  },
  {
    id: 'chocolate', name: '巧克力刀', short: '巧克力', kind: 'chocolate', max: 0.66, rate: 1.45, start: 0, goal: 'bottle',
    chips: ['#5A3424', '#3B2116', '#7A4A30'], grit: 0.1, wobble: 0, r0: 0.55, r1: 0.22,
    intro: '七成黑巧克力，冷藏一夜。手心的溫度是它最大的敵人，請磨快一點。',
    mid: '砥石聞起來像甜點店。',
    done: '巧克力刀斷瓶成功。刀已經被吃掉一半了。',
  },
  {
    id: 'jelly', name: '果凍刀', short: '果凍', kind: 'jelly', max: 0.45, rate: 0.7, start: 0, goal: 'rope',
    chips: ['#B23A7A', '#E07AB0', '#7A2A5A'], grit: 0, wobble: 1, r0: 0.18, r1: 0.06,
    intro: '葡萄口味。它在砥石上一直發抖，但它沒有放棄。',
    mid: '抖歸抖，刃口是真的。',
    done: '果凍切開了繩子。物理老師請不要看這一段。',
  },
  {
    id: 'ice', name: '冰刀', short: '冰', kind: 'ice', max: 0.86, rate: 1.2, start: 0, goal: 'boulder',
    chips: ['#E8F1F8', '#CFE8FF', '#FFFFFF'], grit: 0, wobble: 0, r0: 0.2, r1: 0.03,
    intro: '零下十八度冷凍三天。磨刀用的水，就是它自己。',
    mid: '磨得越久，刀越小，刃越利。',
    done: '冰切開了巨石。山應該覺得很沒面子。',
  },
  {
    id: 'stone', name: '石頭刀', short: '石頭', kind: 'stone', max: 0.76, rate: 0.6, start: 0, goal: 'iron',
    chips: ['#7C7A75', '#5C5650', '#B9A493'], grit: 0.8, wobble: 0, r0: 0.95, r1: 0.6,
    intro: '河邊撿的。用石頭磨石頭，聽起來很合理。',
    mid: '它和砥石正在互相理解。',
    done: '石頭斬鐵。人類的工具史，倒退了一萬年，又前進了一萬年。',
  },
];

function canvasTexture(w, h, draw, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// Deterministic pseudo-random so the looks are identical every load (and in screenshots).
function rng(seed) {
  let s = seed % 2147483647;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// Blade UV frame (see buildBladeGeometry): u = heel → tip, v = edge (0) → spine (1).
const PAINT = {
  cardboard(g, w, h) {
    const r = rng(7);
    g.fillStyle = '#B98B5B';
    g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 6) { // corrugation flutes showing through the liner
      g.fillStyle = x % 12 ? 'rgba(90,60,30,0.10)' : 'rgba(255,240,210,0.10)';
      g.fillRect(x, 0, 3, h);
    }
    for (let i = 0; i < 260; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(70,45,20,0.18)' : 'rgba(255,235,200,0.16)';
      g.fillRect(r() * w, r() * h, 1 + r() * 2, 1);
    }
    // A shipping stamp, half worn off: the box it used to be.
    g.save();
    g.translate(w * 0.42, h * 0.55);
    g.rotate(-0.08);
    g.strokeStyle = 'rgba(176,74,51,0.55)';
    g.lineWidth = 3;
    g.strokeRect(-46, -20, 92, 40);
    g.fillStyle = 'rgba(176,74,51,0.55)';
    g.font = 'bold 22px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('易碎品', 0, 1);
    g.restore();
    g.fillStyle = 'rgba(43,42,40,0.35)';
    g.font = '15px sans-serif';
    g.fillText('↑ 此面向上', w * 0.7, h * 0.4);
  },
  pasta(g, w, h) {
    const r = rng(19);
    g.fillStyle = '#E9C46A';
    g.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 3) { // strands run heel → tip
      const k = r();
      g.fillStyle = k < 0.3 ? '#D9AE4E' : k < 0.6 ? '#F2D58A' : k < 0.9 ? '#E6BE60' : '#C99A3C';
      g.fillRect(0, y, w, 2);
      g.fillStyle = 'rgba(255,248,220,0.35)';
      g.fillRect(0, y, w, 0.6);
    }
    for (let i = 0; i < 40; i++) { // flour specks and glue lumps
      g.fillStyle = 'rgba(255,250,235,0.5)';
      g.beginPath();
      g.arc(r() * w, r() * h, 1 + r() * 2, 0, Math.PI * 2);
      g.fill();
    }
  },
  chocolate(g, w, h) {
    g.fillStyle = '#4A2C1E';
    g.fillRect(0, 0, w, h);
    const cols = 7, rows = 2; // the bar's break-apart grid, bevelled squares
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x0 = (i / cols) * w, y0 = (j / rows) * h, cw = w / cols, ch = h / rows;
        g.fillStyle = '#5A3626';
        g.fillRect(x0 + 4, y0 + 4, cw - 8, ch - 8);
        g.fillStyle = 'rgba(255,220,190,0.12)';
        g.fillRect(x0 + 4, y0 + 4, cw - 8, 3);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.fillRect(x0 + 4, y0 + ch - 7, cw - 8, 3);
      }
    }
  },
  jelly(g, w, h) {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#E07AB0');
    grad.addColorStop(0.5, '#B23A7A');
    grad.addColorStop(1, '#7A2A5A');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    const r = rng(3);
    for (let i = 0; i < 26; i++) { // trapped air bubbles
      const x = r() * w, y = r() * h, rad = 1.5 + r() * 4;
      g.strokeStyle = 'rgba(255,230,245,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(x - rad * 0.4, y - rad * 0.5, 1.5, 1.5);
    }
  },
  ice(g, w, h) {
    g.fillStyle = '#CFE3EE';
    g.fillRect(0, 0, w, h);
    const r = rng(23);
    g.strokeStyle = 'rgba(255,255,255,0.75)';
    for (let i = 0; i < 14; i++) { // frost cracks
      let x = r() * w, y = r() * h;
      g.lineWidth = 0.6 + r();
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (r() - 0.5) * 60;
        y += (r() - 0.5) * 30;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let i = 0; i < 60; i++) {
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(r() * w, r() * h, 1, 1);
    }
  },
  stone(g, w, h) {
    g.fillStyle = '#8A8780';
    g.fillRect(0, 0, w, h);
    const r = rng(41);
    const cols = ['#DCD3C3', '#5C5650', '#7C7A75', '#2B2A28', '#B9A493'];
    for (let i = 0; i < 900; i++) {
      g.fillStyle = cols[i % cols.length];
      g.globalAlpha = 0.35 + r() * 0.5;
      g.fillRect(r() * w, r() * h, 1 + r() * 2.5, 1 + r() * 2.5);
    }
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(220,211,195,0.45)'; // a quartz vein
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, h * 0.7);
    g.bezierCurveTo(w * 0.3, h * 0.4, w * 0.6, h * 0.9, w, h * 0.35);
    g.stroke();
  },
};

/** Blade surface material for a non-metal material knife (metal knives keep the shared PBR steel). */
export function makeBladeMaterial(def) {
  const paint = PAINT[def.kind];
  const map = paint ? canvasTexture(256, 64, paint) : null;
  const common = { map, roughness: def.r0, metalness: 0, side: THREE.DoubleSide };
  switch (def.kind) {
    case 'jelly':
      return new THREE.MeshPhysicalMaterial({ ...common, transparent: true, opacity: 0.8, clearcoat: 1, clearcoatRoughness: 0.08, emissive: '#3A0A24', emissiveIntensity: 0.6 });
    case 'ice':
      return new THREE.MeshPhysicalMaterial({ ...common, transparent: true, opacity: 0.78, clearcoat: 1, clearcoatRoughness: 0.02, emissive: '#1C2A3A', emissiveIntensity: 0.5, envMapIntensity: 1.6 });
    case 'chocolate':
      return new THREE.MeshPhysicalMaterial({ ...common, clearcoat: 0.6, clearcoatRoughness: 0.35, sheen: 0.4, sheenColor: new THREE.Color('#7A4A30') });
    case 'stone':
      return new THREE.MeshStandardMaterial({ ...common, flatShading: true });
    default:
      return new THREE.MeshStandardMaterial(common);
  }
}

/** Card icon: a knife silhouette filled with the material's pattern (2D canvas, for the select screen). */
export function drawMaterialIcon(canvas, def, locked) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W = 120, H = 52;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  // Handle
  g.fillStyle = locked ? '#2B2A28' : '#5C4034';
  g.beginPath();
  g.roundRect(4, 20, 34, 11, 5);
  g.fill();
  // Blade outline (heel at x=38, tip at x=116; edge along the bottom, spine sweeping down to the tip)
  const blade = new Path2D();
  blade.moveTo(38, 12);
  blade.lineTo(84, 13);
  blade.quadraticCurveTo(106, 18, 116, 37);
  blade.quadraticCurveTo(96, 42, 70, 42);
  blade.lineTo(38, 42);
  blade.closePath();
  g.save();
  g.clip(blade);
  if (locked) {
    g.fillStyle = '#3E4A61';
    g.fillRect(0, 0, W, H);
  } else if (def.kind === 'metal') {
    const grad = g.createLinearGradient(0, 12, 0, 42);
    grad.addColorStop(0, '#C9CED6');
    grad.addColorStop(0.7, '#E9ECF0');
    grad.addColorStop(1, '#FFFFFF');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    const r = rng(5); // rust blotches
    for (let i = 0; i < 26; i++) {
      g.fillStyle = `rgba(${140 + r() * 40},${60 + r() * 30},${25 + r() * 15},${0.55 + r() * 0.4})`;
      g.beginPath();
      g.arc(38 + r() * 78, 12 + r() * 30, 2 + r() * 6, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    const tmp = document.createElement('canvas');
    tmp.width = 256;
    tmp.height = 64;
    PAINT[def.kind](tmp.getContext('2d'), 256, 64);
    g.drawImage(tmp, 38, 12, 78, 30);
  }
  g.restore();
  g.strokeStyle = locked ? '#808C9A' : 'rgba(245,239,230,0.9)';
  g.lineWidth = 1.5;
  g.stroke(blade);
  if (locked) {
    g.fillStyle = '#F5EFE6';
    g.font = 'bold 16px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('？', 78, 28);
  }
  return canvas;
}

/** Rust overlay textures: a colour map and a cloudy noise field the rust level dissolves through. */
export function makeRustTextures() {
  const r = rng(97);
  const map = canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#8A4A22';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) {
      const k = r();
      g.fillStyle = k < 0.35 ? 'rgba(60,28,12,0.55)' : k < 0.7 ? 'rgba(176,96,44,0.6)' : 'rgba(214,140,70,0.45)';
      g.beginPath();
      g.arc(r() * w, r() * h, 0.6 + r() * 3.2, 0, Math.PI * 2);
      g.fill();
    }
  });
  // Noise: soft blobs summed. Bright = stubborn rust (survives longest as the level drops).
  const alpha = canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 140; i++) {
      const x = r() * w, y = r() * h, rad = 4 + r() * 18;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      const a = 0.12 + r() * 0.22;
      gr.addColorStop(0, `rgba(255,255,255,${a})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    g.globalCompositeOperation = 'source-over';
  });
  alpha.colorSpace = THREE.NoColorSpace;
  return { map, alpha };
}
