// The static lab as three.js meshes, built from labLayout() (never from its own
// numbers). Built once per room; only blink materials swap per frame.
// Geometry is module-level and shared by every room (sizes that come from the
// layout are cached by their dimensions); disposeLab frees only what one room owns.
import * as THREE from '../vendor/three.module.min.js';
import { blinkOn } from '../engine/fx.mjs';
import { WALL_H, SHELF_H, FRONT_SHELF_H } from './lab-layout.mjs';

const FLOOR_COLORS = { floor: '#d8c39a', floor2: '#cfb98f', floor3: '#d3be95' };
const BOOK_COLORS = [[217, 69, 59], [59, 125, 216], [255, 210, 74], [91, 191, 106], [176, 106, 217], [232, 226, 208]];

const GEO = new Map();
const boxGeo = (w, h, d) => {
  const key = `box|${w}|${h}|${d}`;
  if (!GEO.has(key)) GEO.set(key, new THREE.BoxGeometry(w, h, d));
  return GEO.get(key);
};
const planeGeo = (w, h) => {
  const key = `plane|${w}|${h}`;
  if (!GEO.has(key)) GEO.set(key, new THREE.PlaneGeometry(w, h));
  return GEO.get(key);
};
const TILE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

// Book-spine texture as raw RGBA, so it builds in node tests (no canvas).
function bookTexture() {
  const w = 32, h = 16, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const row = y < 8 ? 0 : 1, yy = y % 8, book = Math.floor(x / 2);
    const isBook = yy >= 1 && yy <= 6 - ((book + row) % 3);
    const c = isBook ? BOOK_COLORS[(book * 7 + row * 3) % 6] : [92, 58, 34];
    data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
  }
  const t = new THREE.DataTexture(data, w, h);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
let BOOKS = null;
const books = () => (BOOKS ??= bookTexture());

function box(w, h, d, mat, x, y, z, name = '') {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = name;
  return m;
}

export function buildLab(layout, mats) {
  const group = new THREE.Group();
  group.name = 'lab';
  const fx = { blinkers: [], consoleGlows: [], window: null };
  // Per-room resources freed by disposeLab: materials/textures, and the
  // InstancedMeshes, whose instanceMatrix buffers belong to this room.
  const owned = [];
  const m4 = new THREE.Matrix4();

  // Floor: one InstancedMesh per tile variant.
  const byVariant = new Map();
  for (const f of layout.floor) {
    if (!byVariant.has(f.variant)) byVariant.set(f.variant, []);
    byVariant.get(f.variant).push(f);
  }
  for (const [variant, tiles] of byVariant) {
    const inst = new THREE.InstancedMesh(TILE, mats.std(FLOOR_COLORS[variant] ?? FLOOR_COLORS.floor, { roughness: 1 }), tiles.length);
    tiles.forEach((f, i) => inst.setMatrixAt(i, m4.makeTranslation(f.col + 0.5, 0, f.row + 0.5)));
    inst.receiveShadow = true;
    inst.name = `floor-${variant}`;
    owned.push(inst);
    group.add(inst);
  }

  // Back wall along row 0; its face sits on the wall row's front edge (Z = 1).
  group.add(box(layout.cols, WALL_H, 0.4, mats.std('#93b6cc'), layout.cols / 2, WALL_H / 2, 0.8, 'back-wall'));
  group.add(box(layout.cols, 0.15, 0.45, mats.std('#4b6173'), layout.cols / 2, 0.075, 0.82, 'wall-trim'));

  // Window: one pane across the window tiles. Its material is per room (not
  // cached) because the hour tints it.
  if (layout.windows.length) {
    const cols = layout.windows.map((w) => w.col);
    const c0 = Math.min(...cols), c1 = Math.max(...cols) + 1;
    const material = new THREE.MeshBasicMaterial({ color: '#cdeeff' });
    owned.push(material);
    const pane = new THREE.Mesh(planeGeo(c1 - c0, 1.2), material);
    pane.position.set((c0 + c1) / 2, 1.6, 1.01);
    pane.name = 'window';
    group.add(pane);
    fx.window = { material, X: (c0 + c1) / 2 };
  }

  // Machines with two blinking lights each.
  const off = mats.basic('#3a455c');
  for (const { col } of layout.machines) {
    group.add(box(0.9, 1.9, 0.8, mats.std('#c95a5a'), col + 0.5, 0.95, 1.4, 'machine'));
    const screen = new THREE.Mesh(planeGeo(0.6, 0.35), mats.basic('#2b2f3a'));
    screen.position.set(col + 0.5, 1.45, 1.81);
    group.add(screen);
    for (const [dx, on] of [[-0.2, mats.basic('#7dff9b')], [0.2, mats.basic('#ffd24a')]]) {
      const l = new THREE.Mesh(planeGeo(0.1, 0.1), on);
      l.position.set(col + 0.5 + dx, 1.1, 1.81);
      group.add(l);
      fx.blinkers.push({ mesh: l, on, off });
    }
  }

  // Shelves: book spines face into the room. Box material order is
  // [+X, -X, +Y, -Y, +Z, -Z]. The spine texture's repeat depends on the shelf
  // length, so each shelf owns a clone (sharing the image) and its material.
  const wood = mats.std('#7a4a2a');
  const spines = (len) => {
    const t = books().clone();
    t.repeat.set(len / 2, 1);
    t.needsUpdate = true;
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
    owned.push(t, m);
    return m;
  };
  const { left, right, front } = layout.shelves;
  if (left) {
    const len = left.rowMax - left.rowMin + 1;
    group.add(box(1, SHELF_H, len, [spines(len), wood, wood, wood, wood, wood], left.colMin + 0.5, SHELF_H / 2, left.rowMin + len / 2, 'shelf-left'));
  }
  if (right) {
    const len = right.rowMax - right.rowMin + 1;
    group.add(box(1, SHELF_H, len, [wood, spines(len), wood, wood, wood, wood], right.colMin + 0.5, SHELF_H / 2, right.rowMin + len / 2, 'shelf-right'));
  }
  if (front) {
    const len = front.colMax - front.colMin + 1;
    group.add(box(len, FRONT_SHELF_H, 0.8, [wood, wood, mats.std('#9a6238'), wood, wood, wood], front.colMin + len / 2, FRONT_SHELF_H / 2, front.rowMin + 0.6, 'shelf-front'));
  }

  // Healing console(s).
  for (const { col, row } of layout.consoles) {
    group.add(box(1, 0.9, 0.8, mats.std('#e9edf2'), col + 0.5, 0.45, row + 0.5, 'console'));
    const on = mats.basic('#a0f0ff');
    const glow = new THREE.Mesh(planeGeo(0.7, 0.45), on);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(col + 0.5, 0.91, row + 0.45);
    group.add(glow);
    fx.consoleGlows.push({ mesh: glow, on, off: mats.basic('#4a6a78') });
    const cross = mats.std('#d9453b');
    group.add(box(0.3, 0.08, 0.02, cross, col + 0.5, 0.55, row + 0.91), box(0.08, 0.3, 0.02, cross, col + 0.5, 0.55, row + 0.91));
  }

  // Door: a frame and a closed panel in the right wall's gap. The frame's room-facing
  // face sits on the wall plane (X = door.X), like the shelf spines beside
  // it; the panel stands 0.04 proud of it so the two never share a plane.
  if (layout.door) {
    const { X, Z, d } = layout.door;
    const door = new THREE.Group();
    door.name = 'door';
    const z = Z + d / 2;
    door.add(box(0.3, SHELF_H, d, mats.std('#3d2816'), X + 0.15, SHELF_H / 2, z, 'door-frame'));
    door.add(box(0.1, SHELF_H - 0.12, d - 0.2, mats.std('#5a3b22'), X + 0.01, (SHELF_H - 0.12) / 2, z, 'door-panel'));
    door.add(box(0.08, 0.08, 0.08, mats.std('#d9b44a'), X - 0.08, 0.95, Z + d - 0.35, 'door-knob'));
    group.add(door);
  }
  return { group, fx, owned };
}

// Frees what buildLab made for this room only (window material, shelf spine
// textures and materials, the floor instance buffers). Shared geometry and cached materials stay alive for
// the other rooms.
export function disposeLab(lab) {
  for (const r of lab.owned) r.dispose();
  lab.owned.length = 0;
}

// Renderer teardown: the shared box/plane cache, floor tile geometry and book texture.
export function disposeSharedLab() {
  for (const g of GEO.values()) g.dispose();
  GEO.clear();
  TILE.dispose();
  BOOKS?.dispose();   // the clones are per-room (owned); this is the source they copy
  BOOKS = null;
}

// Same rhythm as 2D drawAmbient: 1200 ms period, fixtures staggered 300 ms in
// FIXTURES order (machines, then the console).
export function updateLabFx(fx, timeMs) {
  const machines = fx.blinkers.length / 2;
  fx.blinkers.forEach((b, i) => { b.mesh.material = blinkOn(1200, timeMs, Math.floor(i / 2) * 300) ? b.on : b.off; });
  fx.consoleGlows.forEach((g, i) => { g.mesh.material = blinkOn(1200, timeMs, (machines + i) * 300) ? g.on : g.off; });
}
