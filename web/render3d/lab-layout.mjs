// Pure description of the static lab, derived from ROOM + layout.mjs so the 3D
// scene can never drift from the 2D tile map. No three.js here: this is the
// testable half of the lab; lab.mjs turns it into meshes.
import { ROOM } from '../engine/room.mjs';
import { floorTileFor } from '../engine/floor.mjs';
import { pxToWorld, TILE_PX } from './coords.mjs';

export const WALL_H = 2.8;
export const SHELF_H = 1.9;
// The front shelf is cut to knee height so the camera can see over it into the room.
export const FRONT_SHELF_H = 0.45;
export const DESK_TOP_Y = 0.78;

// Tiles that are architecture, not walkable floor.
const STRUCTURAL = new Set(['wall', 'machine', 'window', 'bookshelf', 'door']);

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
  const doorCells = pick('door');
  return {
    cols: room.cols, rows: room.rows,
    floor,
    machines: pick('machine'),
    windows: pick('window'),
    consoles: pick('console'),
    shelves: {
      left: extent(shelves.filter((c) => c.col === 0)),
      // The front row owns the corner cell, so the right shelf stops above it.
      right: extent(shelves.filter((c) => c.col === lastCol && c.row !== lastRow)),
      front: extent(shelves.filter((c) => c.row === lastRow && c.col !== 0)),
    },
    // Top-left of the door gap in the right wall, and its depth in tiles.
    door: doorCells.length ? { ...pxToWorld(doorCells[0].col * TILE_PX, Math.min(...doorCells.map((c) => c.row)) * TILE_PX), d: doorCells.length } : null,
  };
}
