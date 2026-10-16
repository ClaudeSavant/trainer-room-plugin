// Desk hit-testing for the 3D view, as pure maths so it is testable without
// WebGL. The renderer turns a click into a world-space ray; this returns the
// nearest occupied desk the ray hits, mirroring 2D's deskSlotAt.
import { deskRect } from '../engine/layout.mjs';
import { TILE_PX } from './coords.mjs';

// Up to the monitor top, so clicking a screen counts as clicking its desk.
export const DESK_PICK_H = 1.5;

export function deskBox(slot) {
  const r = deskRect(slot);
  return { min: [r.x / TILE_PX, 0, r.y / TILE_PX], max: [(r.x + r.w) / TILE_PX, DESK_PICK_H, (r.y + r.h) / TILE_PX] };
}

// Slab method: distance along the ray to the box, or null on a miss or when the
// box is entirely behind the origin.
export function rayBox(origin, dir, box) {
  let tmin = -Infinity, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-12) {
      if (origin[i] < box.min[i] || origin[i] > box.max[i]) return null;
      continue;
    }
    let t1 = (box.min[i] - origin[i]) / dir[i];
    let t2 = (box.max[i] - origin[i]) / dir[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return Math.max(tmin, 0);
}

export function pickDesk(origin, dir, slots) {
  let best = null, bestT = Infinity;
  for (const slot of slots) {
    const t = rayBox(origin, dir, deskBox(slot));
    if (t !== null && t < bestT) { best = slot; bestT = t; }
  }
  return best;
}
