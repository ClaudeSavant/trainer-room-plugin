// One desk per occupied slot (as in 2D, desks only appear for present agents).
// Desk-local frame: origin at the desk rect's top-left floor corner, X right,
// Z toward the camera.
import * as THREE from '../vendor/three.module.min.js';
import { deskRect } from '../engine/layout.mjs';
import { pxToWorld, TILE_PX } from './coords.mjs';
import { DESK_TOP_Y } from './lab-layout.mjs';

export const MAX_ITEMS = 8;
const R0 = deskRect(0);
const W = R0.w / TILE_PX, D = R0.h / TILE_PX;  // every desk has the same footprint
const G = {
  top: new THREE.BoxGeometry(W, 0.12, D * 0.8),
  body: new THREE.BoxGeometry(W - 0.2, 0.66, D * 0.65),
  monitor: new THREE.BoxGeometry(1.0, 0.62, 0.08),
  stand: new THREE.BoxGeometry(0.12, 0.2, 0.12),
  screen: new THREE.PlaneGeometry(0.86, 0.48),
  keyboard: new THREE.BoxGeometry(0.7, 0.04, 0.22),
  token: new THREE.BoxGeometry(0.12, 0.12, 0.12),
  doc: new THREE.BoxGeometry(0.16, 0.02, 0.2),
  parcel: new THREE.BoxGeometry(0.18, 0.14, 0.16),
  ball: new THREE.SphereGeometry(0.09, 10, 8),
};
// Same tier colours as the 2D fallback items (sprites.mjs TIER_COLOR).
const ITEM_COLOR = { token: '#cfd8e3', doc: '#8ecbff', parcel: '#d8a25a', deliverable: '#d93a3a' };
const SCREEN_ON = '#7fe0ff', SCREEN_OFF = '#33415a';

// Renderer teardown: the 3D path is one-way, so nothing builds from G again.
export function disposeSharedDesks() { for (const g of Object.values(G)) g.dispose(); }

export function createDesk(slot, mats) {
  const r = deskRect(slot);
  const o = pxToWorld(r.x, r.y);
  const group = new THREE.Group();
  group.name = `desk-${slot}`;
  group.position.set(o.X, 0, o.Z);
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  add(G.top, mats.std('#c99260'), W / 2, 0.72, D * 0.5);
  add(G.body, mats.std('#8a5a2e'), W / 2, 0.33, D * 0.45);
  add(G.monitor, mats.std('#2b2f3a'), W / 2, 1.15, D * 0.3);
  add(G.stand, mats.std('#3a3f4c'), W / 2, 0.86, D * 0.3);
  const screen = add(G.screen, mats.basic(SCREEN_OFF), W / 2, 1.16, D * 0.3 + 0.045);
  screen.castShadow = false;
  add(G.keyboard, mats.std('#3a3f4c'), W / 2, 0.8, D * 0.65);
  const items = new THREE.Group();
  items.name = 'items';
  group.add(items);
  let itemsKey = null;
  return {
    group,
    screen,
    setActive(active) { screen.material = mats.basic(active ? SCREEN_ON : SCREEN_OFF); },
    setItems(tiers) {
      const shown = tiers.slice(-MAX_ITEMS);
      const key = shown.join(',');
      if (key === itemsKey) return;   // unchanged: keep the meshes we have
      itemsKey = key;
      items.clear();
      shown.forEach((tier, i) => {
        // A row between the monitor and the keyboard, so the monitor never hides it.
        const x = 0.35 + i * 0.3, z = D * 0.42;
        const geo = tier === 'deliverable' ? G.ball : (G[tier] ?? G.token);
        const h = tier === 'deliverable' ? 0.18 : geo.parameters.height;
        const m = new THREE.Mesh(geo, mats.std(ITEM_COLOR[tier] ?? ITEM_COLOR.token));
        m.position.set(x, DESK_TOP_Y + h / 2, z);
        m.castShadow = true;
        items.add(m);
      });
    },
  };
}
