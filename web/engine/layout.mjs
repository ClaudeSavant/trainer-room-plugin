const TILE = 16;
const COLS = 4;
const ORIGIN_C = 2, ORIGIN_R = 2;     // first desk's top-left tile
const PITCH_C = 4, PITCH_R = 4;       // tiles between desks
const DESK_TC = 3, DESK_TR = 2;       // desk size in tiles
export const MAX_DESKS = 8;

const DESK_W = DESK_TC * TILE, DESK_H = DESK_TR * TILE;

function cell(i) {
  const col = i % COLS, row = Math.floor(i / COLS);
  return { c: ORIGIN_C + col * PITCH_C, r: ORIGIN_R + row * PITCH_R };
}

export function deskRect(i) {
  const { c, r } = cell(i);
  return { x: c * TILE, y: r * TILE, w: DESK_W, h: DESK_H };
}

// Tile cells a desk covers (DESK_TC x DESK_TR), tile-aligned to deskRect.
// Used to blit the `desk` tile across the desk footprint in the asset path.
export function deskTileCells(i) {
  const { c, r } = cell(i);
  const cells = [];
  for (let dr = 0; dr < DESK_TR; dr++)
    for (let dc = 0; dc < DESK_TC; dc++) cells.push({ col: c + dc, row: r + dr });
  return cells;
}

export function deskSlotAt(px, py) {
  for (let i = 0; i < MAX_DESKS; i++) {
    const r = deskRect(i);
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return i;
  }
  return null;
}

export function deskStand(i) {
  const r = deskRect(i);
  return { x: r.x + r.w / 2, y: r.y + r.h + 14 };
}

// The aisle is the walkway below the desk stands; the door is in the right wall.
export const AISLE_Y = 160;
export const DOOR_INSIDE = { x: 296, y: 160 };
export const DOOR_OUTSIDE = { x: 304, y: 160 };   // the door plane: col 19's left edge

// Vertical legs run up the gap just right of a desk column (x = 88/152/216/280),
// never straight up from the aisle: a top-row stand sits directly above a
// bottom-row desk. `gapRightOf(x)` is the first gap at or right of x; past the
// last column every x is already clear of the desks.
const GAP_OFFSET = DESK_W + 8;
function gapRightOf(x) {
  for (let col = 0; col < COLS; col++) {
    const gx = (ORIGIN_C + col * PITCH_C) * TILE + GAP_OFFSET;
    if (gx >= x) return gx;
  }
  return x;
}

// From anywhere on a walk to the aisle: sideways to the gap, then down it.
// Already in the aisle: nothing to do.
function toAisle(from) {
  if (from.y === AISLE_Y) return [];
  const gx = gapRightOf(from.x);
  return [{ x: gx, y: from.y }, { x: gx, y: AISLE_Y }];
}

// From the aisle to a stand: up the gap right of its desk, then sideways.
function fromAisle(stand) {
  const gx = gapRightOf(stand.x);
  return [{ x: gx, y: AISLE_Y }, { x: gx, y: stand.y }, { ...stand }];
}

export function arrivalPath(stand) {
  return [{ ...DOOR_INSIDE }, ...fromAisle(stand)];
}

export function exitPath(from) {
  return [...toAisle(from), { ...DOOR_INSIDE }, { ...DOOR_OUTSIDE }];
}

export function returnPath(from, stand) {
  return [...toAisle(from), ...fromAisle(stand)];
}

// Identity is the session; the NAME is only a role hint for ordering, so two
// sessions both called 'lead' each get their own desk in lead position.
// `agents` is Array<{session, name}>; `slots` maps session -> desk index and
// `overflow` lists the sessions past MAX_DESKS.
export function assignDesks(agents, roleOrder = []) {
  const lc = (s) => String(s).toLowerCase();
  const roleSet = new Set(roleOrder.map(lc));
  const ordered = [];
  const seen = new Set();
  const push = (a) => { if (!seen.has(a.session)) { seen.add(a.session); ordered.push(a); } };
  // role-priority names first, in roleOrder order, matched case-insensitively
  for (const role of roleOrder)
    for (const a of agents) if (lc(a.name) === lc(role)) push(a);
  // everyone else by first-seen
  for (const a of agents) if (!roleSet.has(lc(a.name))) push(a);
  const slots = {}; const overflow = [];
  ordered.forEach((a, idx) => {
    if (idx < MAX_DESKS) slots[a.session] = idx; else overflow.push(a.session);
  });
  return { slots, overflow };
}
