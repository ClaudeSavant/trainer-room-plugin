// Deterministic floor-tile selection: a pure hash of (col,row) so the floor
// has subtle variation without per-frame randomness. variants[0] is the base.
export function floorTileFor(col, row, variants) {
  if (!variants || variants.length <= 1) return variants?.[0] ?? 'floor';
  const h = (Math.imul(col + 1, 73856093) ^ Math.imul(row + 1, 19349663)) >>> 0;
  if (h % 5 < 3) return variants[0];            // ~60% base
  return variants[1 + (h % (variants.length - 1))];
}
