// Pure description of the static lab, derived from ROOM + layout.mjs so the 3D
// scene can never drift from the 2D tile map. No three.js here: this is the
// testable half of the lab; lab.mjs turns it into meshes.
import { ROOM } from '../engine/room.mjs';
import { floorTileFor } from '../engine/floor.mjs';
import { MAX_DESKS, barracksBunkRect } from '../engine/layout.mjs';
import { pxToWorld, TILE_PX } from './coords.mjs';

export const WALL_H = 2.8;
export const SHELF_H = 1.9;
// The front shelf is cut to knee height so the camera can see the barracks.
export const FRONT_SHELF_H = 0.45;
export const DESK_TOP_Y = 0.78;

// Tiles that are architecture, not walkable floor.
const STRUCTURAL = new Set(['wall', 'machine', 'window', 'bookshelf']);

function extent(cells) {
  if (!cells.length) return null;
  const cols = cells.map((c) => c.col), rows = cells.map((c) => c.row);
  return { colMin: Math.min(...cols), colMax: Math.max(...cols), rowMin: Math.min(...rows), rowMax: Math.max(...rows) };
}

export function labLayout(room = ROOM) {
  const cells = room.layers.flatMap((l) => l.cells);
  const pick = (tile) => cells.filter((c) => c.tile === tile).map(({ col, row }) => ({ col, row }));
  const blocked = new Set(cells.filter((c) => STRUCTURAL.has(c.tile)).map((c) => `${c.col},${c.row}`));
  const variants = room.floorVariants ?? [room.floor];
  const floor = [];
  for (let row = 0; row < room.rows; row++)
    for (let col = 0; col < room.cols; col++)
      if (!blocked.has(`${col},${row}`)) floor.push({ col, row, variant: floorTileFor(col, row, variants) });
  const shelves = pick('bookshelf');
  const lastCol = room.cols - 1, lastRow = room.rows - 1;
  return {
    cols: room.cols, rows: room.rows,
    floor,
    machines: pick('machine'),
    windows: pick('window'),
    consoles: pick('console'),
    shelves: {
      left: extent(shelves.filter((c) => c.col === 0)),
      right: extent(shelves.filter((c) => c.col === lastCol)),
      front: extent(shelves.filter((c) => c.row === lastRow && c.col !== 0 && c.col !== lastCol)),
    },
    bunks: Array.from({ length: MAX_DESKS }, (_, slot) => {
      const b = barracksBunkRect(slot);
      const p = pxToWorld(b.x, b.y);
      return { slot, X: p.X, Z: p.Z, w: b.w / TILE_PX, d: b.h / TILE_PX };
    }),
  };
}
