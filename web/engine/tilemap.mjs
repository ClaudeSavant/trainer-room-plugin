import { floorTileFor } from './floor.mjs';

export function tileToPx(col, row, tileSize) {
  return { x: col * tileSize, y: row * tileSize };
}

export function roomPx(room, tileSize) {
  return { w: room.cols * tileSize, h: room.rows * tileSize };
}

// Largest box with the room's aspect (rw:rh) that fits within availW x availH.
// Used to size the single-room canvas so it letterboxes to the *limiting*
// dimension (width OR available height) instead of always following full
// container width — which would blow the room past the visible viewport.
export function fitCanvas(availW, availH, rw, rh) {
  const scale = Math.min(Math.max(availW, 1) / rw, Math.max(availH, 1) / rh);
  return { w: Math.max(1, Math.floor(rw * scale)), h: Math.max(1, Math.floor(rh * scale)) };
}

// Decide a room card's canvas pixel dimensions for the current view mode. Pure
// (no DOM) so the sizing rules are unit-testable. In single-room view the canvas
// is letterbox-fit inside availW x availH (see fitCanvas) with an explicit inline
// width; in the grid ('all') view the inline width is cleared ('') so CSS
// width:100% governs and the canvas follows the measured container width
// (fallbackW). rw:rh is the room's native aspect.
export function canvasSizing(single, availW, availH, rw, rh, fallbackW) {
  const cssW = single ? fitCanvas(availW, availH, rw, rh).w : fallbackW;
  return {
    styleWidth: single ? cssW + 'px' : '',
    width: cssW,
    height: Math.round(cssW * (rh / rw)),
  };
}

// What work a visible room card needs on a frame. Layout (resize) ALWAYS runs so
// that selecting an idle project's tab still re-letterboxes its canvas; only the
// simulation/render is skipped while the room is idle. Extracted from loop() so
// this "idle rooms still resize" invariant is testable without a DOM.
export function roomFrame(idle) {
  return { resize: true, simulate: !idle };
}

// Blit a single named tile from the tileset to a tile cell. Exported so callers
// (e.g. desk footprint rendering) reuse the same source-rect math as drawRoom.
export function drawTile(ctx, bundle, manifest, tileName, col, row) {
  const [tc, tr] = manifest.tileset.tiles[tileName];
  const s = manifest.tileSize;
  const { x, y } = tileToPx(col, row, s);
  ctx.drawImage(bundle.tileset, tc * s, tr * s, s, s, x, y, s, s);
}

export function drawRoom(ctx, room, bundle, manifest) {
  const variants = room.floorVariants ?? [room.floor];
  for (let r = 0; r < room.rows; r++)
    for (let c = 0; c < room.cols; c++) drawTile(ctx, bundle, manifest, floorTileFor(c, r, variants), c, r);
  for (const layer of room.layers)
    for (const cl of layer.cells) drawTile(ctx, bundle, manifest, cl.tile, cl.col, cl.row);
}
