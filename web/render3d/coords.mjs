// Sim space is 2D pixels (16 px tiles, y grows down the screen). 3D world space
// is 1 unit per tile with Y up; sim y maps to world Z, so "down the screen" is
// "toward the camera". Every 3D placement goes through here so layout numbers
// live only in room.mjs / layout.mjs.
export const TILE_PX = 16;

export function pxToWorld(x, y) { return { X: x / TILE_PX, Z: y / TILE_PX }; }
export function worldToPx(X, Z) { return { x: X * TILE_PX, y: Z * TILE_PX }; }

// Models are authored facing +Z (toward the camera); rotation.y = θ turns +Z
// toward +X, so 'right' is +π/2.
const DIR_YAW = { down: 0, right: Math.PI / 2, up: Math.PI, left: -Math.PI / 2 };
export function yawFor(dir) { return DIR_YAW[dir] ?? 0; }
