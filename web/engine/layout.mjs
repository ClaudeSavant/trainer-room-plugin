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

const BED_TC = 2, BED_TR = 1;                 // bunk: 2 tiles wide, 1 tall (horizontal) — reused from the old per-desk bed size
const BARRACKS_ROW = 10;                      // last open floor row before the bottom wall (room row 11)
const BARRACKS_ORIGIN_C = 2;                  // mirrors the desk grid's own ORIGIN_C

// One shared barracks: a single row of MAX_DESKS bunks, indexed by the same
// slot a desk uses (slot N's desk holder sleeps at bunk N) — no separate
// allocation system. Strip runs col2-17 (16 tiles for 8 bunks x 2 tiles wide),
// inside the col1-18 usable interior (bookshelf walls sit at col0/col19).
function barracksBunkCell(i) {
  return { c: BARRACKS_ORIGIN_C + i * BED_TC, r: BARRACKS_ROW };
}

export function barracksBunkRect(i) {
  const { c, r } = barracksBunkCell(i);
  return { x: c * TILE, y: r * TILE, w: BED_TC * TILE, h: BED_TR * TILE };
}

export function barracksBunkTileCells(i) {
  const { c, r } = barracksBunkCell(i);
  const cells = [];
  for (let dr = 0; dr < BED_TR; dr++)
    for (let dc = 0; dc < BED_TC; dc++) cells.push({ col: c + dc, row: r + dr });
  return cells;
}

export function barracksBunkLie(i) {
  const b = barracksBunkRect(i);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
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

export function spawnPoint(i) {
  const r = deskRect(i);
  return { x: r.x + r.w / 2, y: r.y + r.h + 48 };
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
