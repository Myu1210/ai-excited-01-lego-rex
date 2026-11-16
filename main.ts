// "The Lego T. Rex Woke Up" — ai-excited-01 entry.
// A giant T. rex built from glossy plastic toy bricks lunges out of an open
// toy box in a kid's bedroom at dusk, roaring at the viewer, while a little
// boy in star pajamas recoils in delighted terror and the instruction booklet
// lies open on the floor. Pure stdlib TypeScript rasterizer, fully seeded:
// two runs write byte-identical PNGs. No text anywhere in the image.
import * as fs from "node:fs";
import * as zlib from "node:zlib";

// ---------------- seeded PRNG (fixed seed; zero Math.random / Date) ----------------
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x1e60101);

// Deterministic coordinate hash for grain (same value whatever the draw order).
function hash01(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % 10000) / 10000;
}

// ---------------- framebuffer ----------------
const W = 1024;
const H = 1024;
const img = new Uint8Array(W * H * 3);

type RGB = [number, number, number];
function cl(v: number): number { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
function shade(c: RGB, f: number): RGB {
  return [cl(c[0] * f), cl(c[1] * f), cl(c[2] * f)];
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [cl(a[0] + (b[0] - a[0]) * t), cl(a[1] + (b[1] - a[1]) * t), cl(a[2] + (b[2] - a[2]) * t)];
}
function px(x: number, y: number, c: RGB): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = cl(c[0]); img[i + 1] = cl(c[1]); img[i + 2] = cl(c[2]);
}
function pxA(x: number, y: number, c: RGB, a: number): void {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  if (a >= 1) { px(x, y, c); return; }
  const i = (y * W + x) * 3;
  img[i] = cl(img[i] + (c[0] - img[i]) * a);
  img[i + 1] = cl(img[i + 1] + (c[1] - img[i + 1]) * a);
  img[i + 2] = cl(img[i + 2] + (c[2] - img[i + 2]) * a);
}
// Additive light (for the lamp glow).
function pxAdd(x: number, y: number, c: RGB, a: number): void {
  if (a <= 0) return;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  img[i] = cl(img[i] + c[0] * a);
  img[i + 1] = cl(img[i + 1] + c[1] * a);
  img[i + 2] = cl(img[i + 2] + c[2] * a);
}

function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB, a = 1): void {
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(W - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(H - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) pxA(x, y, c, a);
}

// Scanline polygon fill.
function poly(pts: number[][], c: RGB, a = 1): void {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const ya = Math.max(0, Math.floor(minY)), yb = Math.min(H - 1, Math.ceil(maxY));
  for (let y = ya; y <= yb; y++) {
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) {
        xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k])), x1 = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) pxA(x, y, c, a);
    }
  }
}

function ell(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  const ya = Math.max(0, Math.floor(cy - ry)), yb = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = ya; y <= yb; y++) {
    const dy = (y - cy) / ry;
    if (dy < -1 || dy > 1) continue;
    const dx = rx * Math.sqrt(1 - dy * dy);
    const x0 = Math.max(0, Math.ceil(cx - dx)), x1 = Math.min(W - 1, Math.floor(cx + dx));
    for (let x = x0; x <= x1; x++) pxA(x, y, c, a);
  }
}

function circ(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  ell(cx, cy, r, r, c, a);
}

function thickLine(x0: number, y0: number, x1: number, y1: number, w: number, c: RGB, a = 1): void {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(d / Math.max(1, w * 0.4)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    circ(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, c, a);
  }
}

// Rotated rectangle (brick, pencil, lid).
function rotRect(cx: number, cy: number, w: number, h: number, ang: number, c: RGB, a = 1): void {
  const co = Math.cos(ang), si = Math.sin(ang);
  const hw = w / 2, hh = h / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => [
    cx + dx * co - dy * si, cy + dx * si + dy * co,
  ]);
  poly(corners, c, a);
}

// Four-point star (pajama print, poster sparkle).
function star4(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  const pts: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const ang = (i * Math.PI) / 4 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.28;
    pts.push([cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr]);
  }
  poly(pts, c, a);
}

// One glossy toy-brick stud: dark rim, bright top-left highlight.
function stud(cx: number, cy: number, r: number, base: RGB): void {
  circ(cx, cy, r, shade(base, 0.72));
  circ(cx - r * 0.18, cy - r * 0.22, r * 0.78, base);
  circ(cx - r * 0.3, cy - r * 0.34, r * 0.34, shade(base, 1.45));
}

// Scatter studs over an elliptical region, jittered by the seeded rng.
function studField(cx: number, cy: number, rx: number, ry: number, base: RGB, spacing: number, skip = 0.25): void {
  for (let gy = cy - ry; gy <= cy + ry; gy += spacing) {
    for (let gx = cx - rx; gx <= cx + rx; gx += spacing) {
      const dx = (gx - cx) / rx, dy = (gy - cy) / ry;
      if (dx * dx + dy * dy > 0.92) continue;
      if (hash01(Math.round(gx), Math.round(gy)) < skip) continue;
      stud(gx + (rng() - 0.5) * 5, gy + (rng() - 0.5) * 5, spacing * 0.30, base);
    }
  }
}

// Vertical gradient band.
function vgrad(y0: number, y1: number, top: RGB, bot: RGB): void {
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++) {
    const t = (y - y0) / Math.max(1, y1 - y0);
    fillRect(0, y, W - 1, y, mix(top, bot, t));
  }
}

// ---------------- palette ----------------
const TEAL_TOP: RGB = [22, 62, 78];
const TEAL_BOT: RGB = [40, 102, 118];
const WOOD: RGB = [158, 104, 58];
const WOOD_DARK: RGB = [122, 76, 40];
const WOOD_LIGHT: RGB = [186, 128, 74];
const REX_RED: RGB = [216, 52, 40];
const REX_DARK: RGB = [168, 30, 26];
const REX_BELLY: RGB = [242, 132, 42];
const REX_JAW: RGB = [246, 202, 62];
const REX_GREEN: RGB = [62, 172, 92];
const SKIN: RGB = [240, 192, 152];
const PJ_BLUE: RGB = [52, 112, 202];
const PJ_DARK: RGB = [36, 82, 164];
const CREAM: RGB = [244, 230, 200];

// ---------------- room ----------------
function drawRoom(): void {
  // Deep teal-blue wall, upper 2/3.
  vgrad(0, 684, TEAL_TOP, TEAL_BOT);
  // Subtle wall mottling (plaster texture).
  for (let i = 0; i < 900; i++) {
    const x = rng() * W, y = rng() * 660;
    circ(x, y, 6 + rng() * 22, rng() < 0.5 ? [30, 84, 100] : [48, 112, 128], 0.10);
  }
  // Warm wood floor, bottom 1/3.
  vgrad(684, H, [172, 116, 66], [138, 88, 48]);
  // Plank seams + wood grain.
  for (let py = 700; py < H; py += 62) {
    fillRect(0, py, W - 1, py + 2, WOOD_DARK, 0.85);
    fillRect(0, py + 3, W - 1, py + 4, WOOD_LIGHT, 0.35);
  }
  for (let i = 0; i < 90; i++) {
    const y0 = 690 + rng() * 320;
    const x0 = rng() * W;
    const len = 120 + rng() * 320;
    const amp = 2 + rng() * 4;
    const ph = rng() * 6.28;
    for (let s = 0; s < len; s += 3) {
      const x = x0 + s;
      if (x >= W) break;
      const y = y0 + Math.sin(s / 46 + ph) * amp;
      px(x, y, rng() < 0.5 ? WOOD_DARK : WOOD_LIGHT);
      pxA(x, y + 1, rng() < 0.5 ? WOOD_DARK : WOOD_LIGHT, 0.5);
    }
  }
  // Baseboard.
  fillRect(0, 664, W - 1, 684, [232, 222, 200]);
  fillRect(0, 664, W - 1, 667, [255, 248, 232]);
  fillRect(0, 680, W - 1, 684, [190, 178, 152]);
}

function drawWindow(): void {
  // Top-right window: night sky, moon, stars.
  const x0 = 758, y0 = 52, x1 = 978, y1 = 332;
  fillRect(x0 - 8, y0 - 8, x1 + 8, y1 + 8, [238, 226, 198]);
  fillRect(x0, y0, x1, y1, [14, 26, 58]);
  // Stars.
  for (let i = 0; i < 42; i++) {
    const sx = x0 + 8 + rng() * (x1 - x0 - 16);
    const sy = y0 + 8 + rng() * (y1 - y0 - 16);
    const r = rng() < 0.2 ? 2.4 : 1.2;
    circ(sx, sy, r, [255, 244, 200], 0.9);
  }
  // Moon with craters.
  circ(908, 128, 30, [250, 240, 200]);
  circ(898, 120, 6, [214, 202, 164]);
  circ(918, 138, 4.5, [214, 202, 164]);
  circ(908, 142, 3, [224, 212, 172]);
  circ(912, 116, 3.5, [224, 212, 172]);
  // Mullions.
  fillRect((x0 + x1) / 2 - 4, y0, (x0 + x1) / 2 + 4, y1, [238, 226, 198]);
  fillRect(x0, (y0 + y1) / 2 - 4, x1, (y0 + y1) / 2 + 4, [238, 226, 198]);
  // Sill + soft moonlight spill on the wall.
  fillRect(x0 - 14, y1 + 8, x1 + 14, y1 + 18, [222, 208, 178]);
  ell(868, 200, 150, 120, [120, 150, 190], 0.10);
}

function drawPosters(): void {
  // Rocket poster (left wall).
  const rx0 = 56, ry0 = 96, rx1 = 226, ry1 = 296;
  fillRect(rx0, ry0, rx1, ry1, [246, 238, 214]);
  fillRect(rx0 + 6, ry0 + 6, rx1 - 6, ry1 - 6, [30, 52, 92]);
  // Rocket: body, nose, fins, flame, porthole.
  poly([[141, 128], [158, 168], [158, 232], [124, 232], [124, 168]], [238, 60, 48]);
  poly([[141, 128], [158, 168], [124, 168]], [250, 90, 70]);
  poly([[124, 210], [104, 246], [124, 236]], [238, 60, 48]);
  poly([[158, 210], [178, 246], [158, 236]], [238, 60, 48]);
  poly([[141, 232], [152, 262], [141, 278], [130, 262]], [252, 160, 40]);
  circ(141, 192, 10, [180, 220, 240]);
  circ(141, 192, 10, [120, 170, 200], 0.35);
  star4(96, 140, 7, [255, 220, 90]);
  star4(188, 150, 5, [255, 220, 90]);
  star4(196, 262, 6, [255, 220, 90]);
  star4(88, 258, 5, [255, 220, 90]);
  circ(104, 196, 2.5, [255, 244, 200]);
  circ(184, 208, 2.5, [255, 244, 200]);
  // Slight curl shadow at the poster corner.
  poly([[rx1 - 26, ry1], [rx1, ry1], [rx1, ry1 - 26]], [200, 188, 158], 0.8);

  // Dinosaur poster (wall, left of window).
  const dx0 = 596, dy0 = 66, dx1 = 736, dy1 = 248;
  fillRect(dx0, dy0, dx1, dy1, [246, 238, 214]);
  fillRect(dx0 + 6, dy0 + 6, dx1 - 6, dy1 - 6, [168, 214, 150]);
  // Long-neck dino silhouette + sun + ground.
  circ(700, 106, 16, [252, 196, 60]);
  poly([[640, 216], [648, 150], [668, 118], [690, 106], [706, 112], [700, 126], [676, 140], [668, 176], [676, 216]], [46, 130, 70]);
  // Head with snout, distinct from the neck.
  circ(706, 112, 11, [46, 130, 70]);
  poly([[712, 104], [726, 110], [714, 120]], [46, 130, 70]);
  circ(708, 110, 2.5, [20, 40, 20]);
  poly([[640, 216], [676, 216], [688, 190], [700, 216], [716, 216], [712, 186], [690, 178], [668, 186], [656, 200]], [46, 130, 70]);
  poly([[676, 216], [700, 216], [716, 200], [730, 216]], [46, 130, 70]);
  fillRect(dx0 + 6, 216, dx1 - 6, 222, [120, 170, 90]);
  star4(626, 108, 5, [255, 220, 90]);
  star4(716, 160, 4, [255, 220, 90]);
}

function drawShelf(): void {
  // Bookshelf edge at the right.
  const x0 = 952;
  fillRect(x0, 380, W - 1, 684, [96, 62, 34]);
  fillRect(x0, 380, x0 + 6, 684, [120, 80, 44]);
  const shelfYs = [452, 540, 628];
  const spineCols: RGB[] = [[200, 60, 50], [60, 120, 200], [240, 180, 40], [60, 160, 90], [150, 80, 180], [230, 120, 60]];
  for (const sy of shelfYs) {
    fillRect(x0, sy, W - 1, sy + 8, [120, 80, 44]);
    let bx = x0 + 10;
    while (bx < W - 10) {
      const bw = 8 + rng() * 10;
      const bh = 26 + rng() * 26;
      const c = spineCols[Math.floor(rng() * spineCols.length)];
      fillRect(bx, sy - bh, bx + bw, sy, c);
      fillRect(bx, sy - bh, bx + bw, sy - bh + 3, shade(c, 1.3));
      bx += bw + 2 + rng() * 4;
    }
  }
  // A toy ball on the middle shelf.
  circ(992, 512, 16, [230, 60, 60]);
  ell(984, 504, 6, 10, [255, 220, 220], 0.7);
}

function drawTableLamp(): void {
  // Bedside table, left.
  fillRect(34, 556, 216, 572, [96, 62, 34]);
  fillRect(40, 572, 210, 660, [120, 80, 44]);
  fillRect(52, 588, 198, 620, [104, 66, 36]);
  circ(192, 604, 4, [240, 200, 120]);
  fillRect(44, 660, 58, 684, [96, 62, 34]);
  fillRect(192, 660, 206, 684, [96, 62, 34]);
  // Books on the table.
  fillRect(168, 540, 210, 548, [60, 120, 200]);
  fillRect(170, 548, 208, 556, [200, 60, 50]);
  // Lamp: base, stem, glowing shade.
  ell(118, 552, 26, 8, [60, 60, 80]);
  thickLine(118, 550, 118, 500, 7, [60, 60, 80]);
  poly([[86, 500], [150, 500], [164, 448], [72, 448]], [255, 196, 90]);
  poly([[86, 500], [150, 500], [164, 448], [72, 448]], [255, 220, 140], 0.35);
  ell(118, 448, 46, 8, [255, 214, 120]);
  // Warm light pooling on the table top.
  ell(118, 556, 90, 14, [255, 190, 100], 0.3);
}

function drawToyBox(): void {
  // Open toy box, centre-bottom. Interior dark, front panel wood, rim.
  poly([[330, 700], [762, 700], [762, 906], [330, 906]], [74, 44, 24]);
  // Front panel with wood grain + a painted star.
  poly([[338, 712], [754, 712], [754, 898], [338, 898]], WOOD);
  for (let i = 0; i < 26; i++) {
    const y0 = 720 + rng() * 170;
    const x0 = 340 + rng() * 380;
    const len = 60 + rng() * 160;
    for (let s = 0; s < len; s += 3) {
      const x = x0 + s;
      if (x > 750) break;
      px(x, y0 + Math.sin(s / 40 + i) * 2, rng() < 0.5 ? WOOD_DARK : WOOD_LIGHT);
    }
  }
  fillRect(338, 712, 754, 720, WOOD_LIGHT);
  star4(546, 806, 26, [246, 202, 62]);
  star4(546, 806, 15, [220, 170, 40]);
  // Rim.
  fillRect(330, 694, 762, 712, [140, 90, 48]);
  fillRect(330, 694, 762, 698, WOOD_LIGHT);
  // Inside the box: dark with a few buried bricks peeking out.
  poly([[352, 700], [740, 700], [740, 664], [352, 664]], [40, 24, 14]);
  rotRect(420, 682, 46, 22, 0.2, [60, 160, 90]);
  rotRect(500, 678, 40, 20, -0.3, [240, 180, 40]);
  rotRect(620, 684, 48, 22, 0.1, [60, 120, 200]);
  // Lid, mid-flip above the right side of the box.
  poly([[756, 668], [872, 560], [930, 590], [812, 700]], [126, 82, 42]);
  poly([[772, 662], [868, 574], [912, 598], [814, 686]], WOOD);
  stud(830, 610, 7, WOOD);
  stud(856, 640, 7, WOOD);
  // Soft shadow under the box.
  ell(546, 912, 260, 22, [30, 16, 8], 0.45);
}

// ---------------- booklet + pencil (the punchline, foreground floor) ----------------
function miniRex(cx: number, cy: number, s: number, complete: number): void {
  // Tiny step-diagram rex: body, legs, head, tail, plates — no words, no text.
  const body: RGB = complete >= 1 ? REX_RED : [200, 120, 110];
  ell(cx, cy, 26 * s, 15 * s, body);
  if (complete >= 1) {
    poly([[cx - 12 * s, cy + 8 * s], [cx - 6 * s, cy + 8 * s], [cx - 9 * s, cy + 20 * s]], body);
    poly([[cx + 8 * s, cy + 8 * s], [cx + 14 * s, cy + 8 * s], [cx + 11 * s, cy + 20 * s]], body);
  }
  if (complete >= 2) {
    poly([[cx + 20 * s, cy - 4 * s], [cx + 34 * s, cy - 12 * s], [cx + 30 * s, cy + 2 * s]], body);
    circ(cx + 26 * s, cy - 8 * s, 8 * s, body);
    poly([[cx + 26 * s, cy - 12 * s], [cx + 36 * s, cy - 8 * s], [cx + 28 * s, cy - 2 * s]], REX_JAW);
    circ(cx + 28 * s, cy - 10 * s, 1.6 * s, [20, 20, 20]);
  }
  if (complete >= 3) {
    poly([[cx - 14 * s, cy - 8 * s], [cx - 8 * s, cy - 20 * s], [cx - 2 * s, cy - 8 * s]], REX_GREEN);
    poly([[cx + 2 * s, cy - 10 * s], [cx + 8 * s, cy - 22 * s], [cx + 14 * s, cy - 10 * s]], REX_GREEN);
  }
}

function drawBooklet(): void {
  // Open instruction booklet lying on the floor, two pages, step diagrams.
  poly([[384, 884], [648, 870], [648, 988], [384, 998]], [210, 196, 160], 0.9);
  poly([[384, 884], [516, 876], [516, 992], [384, 998]], [250, 242, 220]);
  poly([[516, 876], [648, 870], [648, 988], [516, 992]], [242, 232, 206]);
  // Centre spine.
  thickLine(516, 876, 516, 992, 3, [180, 164, 128]);
  // Step boxes on the left page (steps 1-2) and right page (step 3 + arrow).
  const steps: [number, number, number][] = [[424, 912, 1], [468, 952, 2], [560, 912, 3]];
  for (const [bx, by, n] of steps) {
    fillRect(bx - 36, by - 28, bx + 36, by + 28, [255, 252, 244]);
    fillRect(bx - 36, by - 28, bx + 36, by - 24, [200, 60, 50]);
    miniRex(bx, by + 4, 1.0, n);
  }
  // Small "next step" arrow (a plain triangle-arrow shape, no text).
  poly([[602, 946], [630, 960], [602, 974], [606, 960]], [200, 60, 50]);
  // Pencil beside the booklet.
  rotRect(700, 962, 130, 12, 0.42, [246, 202, 62]);
  rotRect(758, 990, 22, 12, 0.42, [240, 200, 170]);
  rotRect(768, 994, 10, 12, 0.42, [40, 40, 40]);
  rotRect(646, 936, 12, 12, 0.42, [200, 90, 110]);
  // Booklet shadow.
  ell(520, 992, 150, 12, [30, 16, 8], 0.35);
}

// ---------------- the boy ----------------
function drawBoy(): void {
  // Little boy (~7) in blue star pajamas, bottom-left, recoiling in delighted terror.
  // Shadow.
  ell(180, 988, 110, 16, [30, 16, 8], 0.4);
  // Legs (pajama pants) + slippers.
  poly([[128, 900], [168, 900], [160, 972], [120, 972]], PJ_BLUE);
  poly([[196, 900], [236, 900], [244, 972], [204, 972]], PJ_BLUE);
  ell(138, 980, 26, 12, [240, 120, 60]);
  ell(226, 980, 26, 12, [240, 120, 60]);
  // Torso.
  poly([[118, 836], [246, 836], [252, 912], [112, 912]], PJ_BLUE);
  // Fabric folds on the pajamas.
  thickLine(150, 850, 142, 906, 4, PJ_DARK, 0.7);
  thickLine(196, 848, 200, 908, 4, PJ_DARK, 0.7);
  thickLine(232, 852, 226, 906, 4, PJ_DARK, 0.7);
  // Star print.
  star4(150, 872, 9, [255, 220, 90]);
  star4(210, 892, 7, [255, 220, 90]);
  star4(182, 858, 6, [255, 255, 255]);
  star4(140, 946, 6, [255, 220, 90]);
  star4(222, 940, 6, [255, 255, 255]);
  // Arms raised: sleeves up to the hands at the mouth.
  poly([[122, 842], [150, 830], [168, 800], [150, 786], [128, 812], [112, 836]], PJ_BLUE);
  poly([[242, 842], [214, 830], [196, 800], [214, 786], [236, 812], [252, 836]], PJ_BLUE);
  // Neck + head.
  fillRect(168, 812, 196, 838, SKIN);
  ell(182, 768, 56, 60, SKIN);
  // Hair flying back (to the left), spiky.
  poly([[126, 748], [150, 700], [168, 722], [182, 692], [200, 720], [218, 700], [232, 730], [238, 716], [236, 752], [220, 722], [182, 712], [148, 724]], [74, 46, 30]);
  poly([[126, 748], [118, 712], [140, 728]], [74, 46, 30]);
  // Ears.
  circ(128, 772, 9, SKIN);
  circ(236, 772, 9, SKIN);
  // HUGE eyes (delighted terror).
  ell(158, 758, 17, 21, [255, 255, 255]);
  ell(206, 758, 17, 21, [255, 255, 255]);
  circ(160, 762, 8, [24, 20, 16]);
  circ(208, 762, 8, [24, 20, 16]);
  circ(157, 758, 3, [255, 255, 255]);
  circ(205, 758, 3, [255, 255, 255]);
  // Raised eyebrows.
  thickLine(140, 728, 174, 722, 5, [74, 46, 30]);
  thickLine(190, 722, 224, 728, 5, [74, 46, 30]);
  // Open mouth (dark) with both hands pressed over it.
  ell(182, 800, 16, 12, [90, 30, 28]);
  ell(182, 800, 10, 7, [140, 40, 36]);
  // Hands: fingers over the mouth.
  ell(164, 798, 15, 20, SKIN);
  ell(200, 798, 15, 20, SKIN);
  for (let f = 0; f < 4; f++) {
    thickLine(156 + f * 5, 786, 156 + f * 5, 806, 5, shade(SKIN, 0.92));
    thickLine(192 + f * 5, 786, 192 + f * 5, 806, 5, shade(SKIN, 0.92));
  }
  // Blush + cheek highlight.
  ell(142, 786, 10, 7, [250, 150, 120], 0.6);
  ell(222, 786, 10, 7, [250, 150, 120], 0.6);
}

// ---------------- the Lego T. rex ----------------
function drawRex(): void {
  // Shadow of the lunging rex on the floor.
  ell(600, 906, 300, 24, [30, 16, 8], 0.4);

  // ---- tail, sweeping right ----
  poly([[600, 560], [720, 520], [860, 540], [940, 580], [905, 640], [760, 660], [620, 660]], REX_RED);
  poly([[600, 560], [720, 520], [860, 540], [940, 580], [905, 640], [760, 660], [620, 660]], REX_DARK, 0.18);
  // Tail underside shading.
  poly([[640, 640], [760, 655], [900, 630], [880, 660], [740, 668], [640, 664]], REX_DARK, 0.35);
  // Tail tip brick seam.
  thickLine(880, 552, 868, 632, 3, REX_DARK, 0.6);

  // ---- body: tilted torso, lunging up toward the head ----
  poly([[452, 540], [560, 452], [690, 470], [726, 580], [688, 690], [560, 736], [462, 716], [420, 620]], REX_RED);
  poly([[452, 540], [560, 452], [690, 470], [726, 580], [688, 690], [560, 736], [462, 716], [420, 620]], REX_DARK, 0.10);
  // Orange belly.
  ell(566, 652, 118, 80, REX_BELLY);
  ell(566, 652, 118, 80, [220, 110, 30], 0.15);
  // Brick seams across the body.
  thickLine(440, 580, 700, 540, 3, REX_DARK, 0.55);
  thickLine(430, 640, 710, 620, 3, REX_DARK, 0.5);
  thickLine(500, 470, 520, 720, 3, REX_DARK, 0.45);
  thickLine(620, 460, 650, 720, 3, REX_DARK, 0.45);
  // Studs over the body and belly.
  studField(570, 580, 140, 110, REX_RED, 34, 0.2);
  studField(566, 652, 100, 62, REX_BELLY, 30, 0.3);

  // ---- hind legs (drawn over the body, in front of the box rim) ----
  // Left leg: thick thigh tapering to the ankle, foot planted on the box rim.
  poly([[486, 636], [566, 628], [552, 692], [500, 706], [470, 672]], REX_RED);
  thickLine(486, 636, 470, 672, 3, REX_DARK, 0.5);
  thickLine(566, 628, 552, 692, 3, REX_DARK, 0.4);
  stud(516, 662, 7, REX_RED);
  // Foot pointing left along the rim, three toes with notches between them.
  poly([[470, 690], [520, 686], [524, 716], [478, 726], [430, 726], [404, 716], [396, 700]], REX_RED);
  thickLine(428, 704, 432, 726, 3, REX_DARK, 0.7);
  thickLine(456, 702, 460, 726, 3, REX_DARK, 0.7);
  for (const tx of [400, 428, 456]) {
    poly([[tx, 720], [tx + 16, 720], [tx + 8, 742]], REX_RED);
    poly([[tx + 4, 732], [tx + 12, 732], [tx + 8, 746]], [250, 248, 240]);
  }
  // Right leg, bent, foot raised beside the box.
  poly([[636, 660], [710, 642], [724, 694], [684, 724], [650, 696]], REX_RED);
  thickLine(636, 660, 650, 696, 3, REX_DARK, 0.5);
  stud(682, 682, 7, REX_RED);
  poly([[676, 714], [730, 704], [738, 730], [690, 742], [672, 730]], REX_RED);
  thickLine(700, 712, 704, 736, 3, REX_DARK, 0.7);
  for (const tx of [680, 702, 722]) {
    poly([[tx, 730], [tx + 12, 730], [tx + 6, 744]], [250, 248, 240]);
  }

  // ---- neck ----
  poly([[520, 480], [600, 400], [668, 420], [640, 520], [560, 560]], REX_RED);
  poly([[520, 480], [600, 400], [668, 420], [640, 520], [560, 560]], REX_DARK, 0.12);

  // ---- tiny arms ----
  poly([[520, 520], [560, 500], [576, 540], [540, 556]], REX_RED);
  poly([[556, 548], [586, 540], [592, 552], [566, 560]], REX_RED);
  poly([[586, 540], [596, 530], [600, 542], [592, 552]], [250, 248, 240]);
  poly([[576, 552], [588, 546], [590, 558], [580, 560]], [250, 248, 240]);

  // ---- head, roaring straight at the viewer (3/4, snout to the left) ----
  // Upper jaw.
  poly([[470, 330], [540, 252], [650, 232], [742, 258], [762, 300], [700, 332], [580, 350], [498, 360]], REX_RED);
  poly([[470, 330], [540, 252], [650, 232], [742, 258], [762, 300], [700, 332], [580, 350], [498, 360]], REX_DARK, 0.10);
  // Snout highlight + nostril.
  ell(520, 300, 34, 18, shade(REX_RED, 1.25), 0.5);
  ell(516, 306, 8, 5, REX_DARK);
  // Brow ridge.
  poly([[600, 262], [700, 246], [716, 268], [612, 282]], REX_DARK, 0.8);
  // Eye: white, huge, furious.
  ell(648, 292, 26, 19, [255, 255, 255]);
  circ(652, 294, 11, [18, 14, 10]);
  circ(648, 289, 4, [255, 255, 255]);
  // Mouth interior (wide open, dark) + tongue.
  poly([[492, 356], [580, 346], [700, 328], [752, 310], [752, 360], [696, 402], [580, 416], [500, 392]], [52, 10, 12]);
  ell(620, 384, 58, 14, [190, 60, 60]);
  // Upper teeth (pointing down, longer).
  for (const tx of [520, 556, 592, 628, 664, 700, 730]) {
    poly([[tx - 9, 352], [tx + 9, 348], [tx, 382]], [250, 248, 240]);
  }
  // Lower jaw (yellow), dropped wide open.
  poly([[488, 388], [560, 410], [690, 400], [752, 360], [768, 382], [706, 432], [580, 448], [500, 420]], REX_JAW);
  poly([[488, 388], [560, 410], [690, 400], [752, 360], [768, 382], [706, 432], [580, 448], [500, 420]], [200, 150, 30], 0.18);
  // Lower teeth (pointing up).
  for (const tx of [540, 580, 620, 660, 700]) {
    poly([[tx - 8, 402], [tx + 8, 398], [tx, 376]], [250, 248, 240]);
  }
  // Jaw studs + seams.
  studField(620, 300, 110, 55, REX_RED, 30, 0.35);
  studField(620, 414, 100, 20, REX_JAW, 28, 0.4);
  thickLine(560, 260, 720, 250, 3, REX_DARK, 0.5);

  // ---- green back plates, strictly along the spine (back edge of neck/body/tail) ----
  const spine: [number, number, number][] = [
    [452, 516, 24], [520, 460, 26], [600, 452, 26], [680, 472, 26],
    [760, 522, 24], [850, 556, 22], [905, 580, 18],
  ];
  for (const [sx, sy, ss] of spine) {
    poly([[sx - ss * 0.55, sy + ss * 0.4], [sx, sy - ss], [sx + ss * 0.55, sy + ss * 0.4]], REX_GREEN);
    poly([[sx - ss * 0.55, sy + ss * 0.4], [sx, sy - ss], [sx + ss * 0.2, sy + ss * 0.4]], shade(REX_GREEN, 1.25));
    stud(sx, sy + ss * 0.1, ss * 0.22, REX_GREEN);
  }
  // Studs on the tail.
  studField(780, 590, 130, 45, REX_RED, 32, 0.3);
  // Studs on the legs.
  studField(506, 676, 36, 28, REX_RED, 26, 0.3);
}

// ---------------- frozen motion: flying bricks, car, sock ----------------
function drawFlying(): void {
  const bricks: [number, number, number, number, number, RGB][] = [
    // x, y, angle, w, h, colour — arcs around the rex.
    [380, 470, 0.5, 46, 22, [60, 120, 200]], [330, 540, -0.4, 40, 20, [240, 180, 40]],
    [300, 420, 0.9, 44, 22, [60, 160, 90]], [420, 380, -0.7, 42, 20, [230, 60, 50]],
    [520, 300, 0.3, 46, 22, [240, 180, 40]], [700, 250, -0.5, 44, 22, [60, 120, 200]],
    [800, 300, 0.8, 40, 20, [230, 60, 50]], [880, 420, -0.3, 46, 22, [60, 160, 90]],
    [920, 500, 0.6, 42, 20, [240, 180, 40]], [760, 470, -0.8, 40, 20, [150, 80, 180]],
    [660, 180, 0.4, 44, 22, [230, 60, 50]], [560, 170, -0.6, 40, 20, [60, 160, 90]],
    [440, 220, 0.7, 42, 20, [60, 120, 200]], [350, 300, -0.2, 38, 18, [240, 180, 40]],
    [830, 660, 0.5, 44, 22, [230, 60, 50]], [760, 720, -0.4, 40, 20, [60, 120, 200]],
    [300, 640, 0.3, 42, 20, [150, 80, 180]], [940, 640, -0.7, 40, 20, [240, 180, 40]],
    [480, 480, 1.1, 38, 18, [60, 160, 90]], [720, 380, 0.2, 38, 18, [240, 180, 40]],
    [600, 480, -1.0, 36, 18, [230, 60, 50]], [900, 240, 0.5, 40, 20, [60, 120, 200]],
  ];
  for (const [bx, by, ang, bw, bh, c] of bricks) {
    rotRect(bx, by, bw, bh, ang, c);
    rotRect(bx, by, bw, bh * 0.45, ang, shade(c, 1.3));
    stud(bx, by, 5, c);
  }
  // Red toy car flying top-right.
  const cx = 836, cy = 428, ang = -0.42;
  const co = Math.cos(ang), si = Math.sin(ang);
  const tp = (dx: number, dy: number): [number, number] => [cx + dx * co - dy * si, cy + dx * si + dy * co];
  poly([tp(-52, 6), tp(-38, -12), tp(30, -12), tp(52, 6), tp(52, 14), tp(-52, 14)], [226, 44, 36]);
  poly([tp(-26, -12), tp(-10, -30), tp(22, -30), tp(34, -12)], [226, 44, 36]);
  poly([tp(-20, -12), tp(-8, -26), tp(16, -26), tp(26, -12)], [170, 214, 232]);
  circ(...tp(-28, 14), 12, [24, 24, 28]);
  circ(...tp(30, 14), 12, [24, 24, 28]);
  circ(...tp(-28, 14), 5, [200, 200, 205]);
  circ(...tp(30, 14), 5, [200, 200, 205]);
  // Motion streaks behind the car.
  thickLine(760, 470, 700, 500, 4, [255, 255, 255], 0.5);
  thickLine(768, 448, 712, 472, 4, [255, 255, 255], 0.35);
  // A sock flying (left of the rex).
  poly([[292, 470], [322, 452], [336, 470], [318, 486], [300, 500], [286, 486]], [245, 245, 240]);
  poly([[292, 470], [322, 452], [336, 470], [318, 486], [300, 500], [286, 486]], [200, 200, 195], 0.3);
  thickLine(292, 470, 322, 452, 6, [200, 60, 50]);
  thickLine(300, 500, 318, 486, 4, [200, 60, 50]);
}

// ---------------- light, grain, vignette ----------------
function drawLight(): void {
  // Warm radial light spilling from the lamp (left), soft falloff, wide radius.
  for (let y = 340; y < 780; y += 2) {
    for (let x = 0; x < 620; x += 2) {
      const d = Math.hypot(x - 118, y - 480) / 560;
      if (d >= 1) continue;
      const a = (1 - d) * (1 - d) * 0.17;
      pxAdd(x, y, [255, 186, 96], a);
      pxAdd(x + 1, y, [255, 186, 96], a);
      pxAdd(x, y + 1, [255, 186, 96], a);
      pxAdd(x + 1, y + 1, [255, 186, 96], a);
    }
  }
  // Cool moonlight wash from the window (top-right).
  for (let y = 40; y < 420; y += 2) {
    for (let x = 640; x < W; x += 2) {
      const d = Math.hypot(x - 908, y - 128) / 420;
      if (d >= 1) continue;
      const a = (1 - d) * (1 - d) * 0.10;
      pxAdd(x, y, [140, 170, 220], a);
      pxAdd(x + 1, y, [140, 170, 220], a);
      pxAdd(x, y + 1, [140, 170, 220], a);
      pxAdd(x + 1, y + 1, [140, 170, 220], a);
    }
  }
}

function drawGrain(): void {
  // Per-pixel luminance grain, shared across channels in 2x2 blocks so the
  // PNG stays compact while the texture still reads as photographic grain.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.round((hash01(x >> 1, y >> 1) - 0.5) * 13);
      if (d === 0) continue;
      const i = (y * W + x) * 3;
      img[i] = cl(img[i] + d);
      img[i + 1] = cl(img[i + 1] + d);
      img[i + 2] = cl(img[i + 2] + d);
    }
  }
}

function drawVignette(): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W / 2), dy = (y - H / 2) / (H / 2);
      const d = dx * dx + dy * dy;
      if (d > 0.72) {
        const f = 1 - (d - 0.72) * 0.38;
        const i = (y * W + x) * 3;
        img[i] = cl(img[i] * f);
        img[i + 1] = cl(img[i + 1] * f);
        img[i + 2] = cl(img[i + 2] * f);
      }
    }
  }
}

// ---------------- PNG encoder (own CRC, zlib deflate level 9) ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePNG(): Buffer {
  // Per-row filter: pick, per row, the filter (0 None / 1 Sub / 2 Up) whose
  // filtered bytes have the smallest absolute sum. Fully deterministic.
  const stride = W * 3;
  const raw = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y++) {
    const row = img.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : null;
    let bestF = 0;
    let bestScore = Infinity;
    let best: Buffer | null = null;
    for (let f = 0; f <= 2; f++) {
      const out = Buffer.alloc(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        let v = row[i];
        if (f === 1) v = (v - (i >= 3 ? row[i - 3] : 0)) & 0xff;
        else if (f === 2) v = (v - (prev ? prev[i] : 0)) & 0xff;
        out[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestF = f; best = out; }
    }
    raw[y * (stride + 1)] = bestF;
    best!.copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------- main ----------------
drawRoom();
drawWindow();
drawPosters();
drawShelf();
drawTableLamp();
drawToyBox();
drawBooklet();
drawBoy();
drawRex();
drawFlying();
drawLight();
drawGrain();
drawVignette();

const outDir = process.env.MAKEFUN_OUTPUT_DIR || "out";
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outDir + "/entry.png", encodePNG());
