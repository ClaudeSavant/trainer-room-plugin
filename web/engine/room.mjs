// 20x12 tiles = 320x192 px at 16px (4:3, GBA-ish). Coords are [col,row].
function cell(col, row, tile) { return { col, row, tile }; }
function range(a, b) { return Array.from({ length: b - a }, (_, i) => a + i); }

export const ROOM = {
  cols: 20, rows: 12, floor: 'floor', floorVariants: ['floor', 'floor2', 'floor3'],
  layers: [
    { name: 'back-wall', cells: [
      ...range(0, 20).map((col) => cell(col, 0, 'wall')),
      cell(2, 0, 'machine'), cell(3, 0, 'machine'),
      cell(12, 0, 'window'), cell(13, 0, 'window'),
    ] },
    { name: 'side-walls', cells: [
      ...range(1, 12).map((row) => cell(0, row, 'bookshelf')),
      ...range(1, 12).map((row) => cell(19, row, 'bookshelf')),
      ...range(1, 19).map((col) => cell(col, 11, 'bookshelf')),
    ] },
    { name: 'fixtures', cells: [ cell(16, 8, 'console') ] },
  ],
};

// Tiles whose lights/glow the render loop animates (ambient blink). Pure data so
// tilemap.mjs stays a dumb renderer; main.mjs reads this for the overlay pass.
export const FIXTURES = ROOM.layers
  .flatMap((l) => l.cells)
  .filter((c) => c.tile === 'machine' || c.tile === 'console');
