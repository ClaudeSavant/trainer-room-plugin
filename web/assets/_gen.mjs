// Original CC0 pixel-art generator for the Trainer Room "GBA Lab" v2 visuals.
// Emits valid PNGs using Node's stdlib zlib (NOT an npm dependency).
// Run: `node web/assets/_gen.mjs` — writes tileset.png, items.png, characters/*.png.
// All output is original art authored by this project => CC0 (see CREDITS.md).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- tiny PNG encoder ------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
// img: { w, h, data: Uint8ClampedArray RGBA }
function encodePNG(img) {
  const { w, h, data } = img;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // filtered scanlines (filter byte 0 per row)
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = data[y * w * 4 + x];
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- tiny drawing surface --------------------------------------------------
export function surface(w, h) {
  const data = new Uint8ClampedArray(w * h * 4); // transparent by default
  const px = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2];
    data[i + 3] = rgba.length > 3 ? rgba[3] : 255;
  };
  const rect = (x, y, rw, rh, rgba) => {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) px(xx, yy, rgba);
  };
  return { w, h, data, px, rect };
}
const C = {
  floor: [216, 192, 137], floorAlt: [205, 180, 124], floorEdge: [180, 156, 104],
  wall: [107, 114, 128], wallHi: [140, 148, 162], wallLo: [78, 84, 96],
  machineBody: [43, 50, 66], machineScreen: [60, 200, 140], machineDark: [26, 31, 43],
  sky: [143, 200, 240], skyLo: [110, 170, 220], frame: [120, 96, 60],
  shelf: [138, 90, 43], shelfDark: [99, 63, 28],
  book1: [210, 70, 70], book2: [70, 130, 210], book3: [90, 190, 110], book4: [230, 200, 90],
  desk: [176, 122, 60], deskHi: [200, 150, 90], deskLo: [130, 88, 40],
  consoleBody: [240, 240, 245], consolePink: [255, 143, 191], consoleScreen: [120, 220, 240],
  red: [226, 59, 59], white: [245, 245, 245], black: [26, 31, 43],
  paper: [207, 216, 227], docBlue: [142, 203, 255], docLine: [70, 120, 170],
  parcel: [216, 162, 90], parcelTape: [150, 110, 55],
  skin: [240, 200, 160], shadow: [0, 0, 0, 90],
};

// ---- TILESET (10 tiles x 1 row, 16x16 each) --------------------------------
function drawFloor(s, ox, oy) {
  s.rect(ox, oy, 16, 16, C.floor);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++)
    if (((x >> 2) + (y >> 2)) % 2 === 0) s.px(ox + x, oy + y, C.floorAlt);
  for (let x = 0; x < 16; x++) { s.px(ox + x, oy, C.floorEdge); s.px(ox, oy + x, C.floorEdge); }
}
function drawFloor2(s, ox, oy) {
  drawFloor(s, ox, oy);
  // subtle speckle scuff
  for (const [dx, dy] of [[5, 4], [10, 7], [3, 11], [12, 12], [8, 2]]) s.px(ox + dx, oy + dy, C.floorEdge);
}
function drawFloor3(s, ox, oy) {
  drawFloor(s, ox, oy);
  // faint diagonal scuff line
  for (let i = 0; i < 5; i++) s.px(ox + 4 + i, oy + 9 + i, C.floorEdge);
}
function drawWall(s, ox, oy) {
  s.rect(ox, oy, 16, 16, C.wall);
  s.rect(ox, oy, 16, 3, C.wallHi);
  s.rect(ox, oy + 13, 16, 3, C.wallLo);
  for (let x = 2; x < 16; x += 4) s.rect(ox + x, oy, 1, 16, C.wallLo);
}
function drawMachine(s, ox, oy) {
  s.rect(ox, oy, 16, 16, C.machineBody);
  s.rect(ox + 2, oy + 2, 12, 8, C.machineScreen);
  s.rect(ox + 2, oy + 2, 12, 2, C.machineDark);
  // dial/button row (the blink overlay in main.mjs lights these further)
  s.rect(ox + 3, oy + 12, 2, 2, C.red);
  s.rect(ox + 7, oy + 12, 2, 2, [230, 200, 90]);
  s.rect(ox + 11, oy + 12, 2, 2, C.machineScreen);
}
function drawWindow(s, ox, oy) {
  s.rect(ox, oy, 16, 16, C.frame);
  s.rect(ox + 1, oy + 1, 14, 14, C.sky);
  s.rect(ox + 1, oy + 8, 14, 7, C.skyLo);
  s.rect(ox + 7, oy + 1, 2, 14, C.frame); // mullion
  s.rect(ox + 1, oy + 7, 14, 2, C.frame);
}
function drawBookshelf(s, ox, oy) {
  s.rect(ox, oy, 16, 16, C.shelfDark);
  s.rect(ox + 1, oy + 1, 14, 6, C.shelf);
  s.rect(ox + 1, oy + 9, 14, 6, C.shelf);
  const books = [C.book1, C.book2, C.book3, C.book4];
  for (let i = 0; i < 4; i++) {
    s.rect(ox + 2 + i * 3, oy + 1, 2, 5, books[i % 4]);
    s.rect(ox + 2 + i * 3, oy + 9, 2, 5, books[(i + 1) % 4]);
  }
  s.rect(ox, oy + 7, 16, 2, C.shelfDark);
}
function drawDesk(s, ox, oy) {
  s.rect(ox, oy, 16, 16, C.desk);
  s.rect(ox, oy, 16, 3, C.deskHi);
  s.rect(ox, oy + 13, 16, 3, C.deskLo);
  s.rect(ox + 2, oy + 6, 5, 4, C.deskLo); // drawer hint
}
function drawDoor(s, ox, oy) {
  // doorway in the right wall: floor-toned opening with a frame at the wall edge
  drawFloor(s, ox, oy);
  s.rect(ox + 12, oy, 4, 16, C.frame);             // door frame (wall side)
  s.rect(ox + 13, oy, 2, 16, C.shelfDark);         // threshold shadow
}
function drawConsole(s, ox, oy) {
  s.rect(ox, oy, 16, 16, C.consoleBody);
  s.rect(ox + 1, oy + 1, 14, 6, C.consolePink);
  s.rect(ox + 3, oy + 2, 10, 4, C.consoleScreen);
  // red cross (healing)
  s.rect(ox + 7, oy + 9, 2, 6, C.red);
  s.rect(ox + 5, oy + 11, 6, 2, C.red);
}
export function buildTileset() {
  const tiles = [drawFloor, drawWall, drawMachine, drawWindow, drawBookshelf, drawDesk, drawConsole, drawFloor2, drawFloor3, drawDoor];
  const s = surface(tiles.length * 16, 16);
  tiles.forEach((fn, i) => fn(s, i * 16, 0));
  return s;
}

// ---- ITEMS (4 tiles x 1 row, 16x16) ---------------------------------------
function drawToken(s, ox, oy) {
  s.rect(ox + 4, oy + 5, 8, 7, C.paper);
  s.rect(ox + 4, oy + 5, 8, 1, [255, 255, 255]);
  for (let i = 0; i < 3; i++) s.rect(ox + 5, oy + 7 + i * 1.6 | 0, 6, 1, C.docLine);
}
function drawDoc(s, ox, oy) {
  s.rect(ox + 3, oy + 3, 10, 11, C.docBlue);
  s.rect(ox + 3, oy + 3, 10, 1, [255, 255, 255]);
  for (let i = 0; i < 4; i++) s.rect(ox + 5, oy + 5 + i * 2, 6, 1, C.docLine);
  s.rect(ox + 10, oy + 3, 3, 3, [255, 255, 255]); // dog-ear
}
function drawParcel(s, ox, oy) {
  s.rect(ox + 2, oy + 4, 12, 10, C.parcel);
  s.rect(ox + 2, oy + 4, 12, 2, [235, 185, 110]);
  s.rect(ox + 7, oy + 4, 2, 10, C.parcelTape); // tape vertical
  s.rect(ox + 2, oy + 8, 12, 2, C.parcelTape); // tape horizontal
}
function drawPokeball(s, ox, oy) {
  const cx = ox + 8, cy = oy + 8, r = 6;
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    if (x * x + y * y > r * r) continue;
    s.px(cx + x, cy + y, y < 0 ? C.red : C.white);
  }
  s.rect(ox + 2, oy + 7, 12, 2, C.black);        // center band
  s.rect(ox + 6, oy + 6, 4, 4, C.white);          // button outer
  s.rect(ox + 7, oy + 7, 2, 2, [120, 120, 120]);  // button inner
  s.rect(ox + 6, oy + 6, 4, 1, C.black);
}
function buildItems() {
  const items = [drawToken, drawDoc, drawParcel, drawPokeball];
  const s = surface(items.length * 16, 16);
  items.forEach((fn, i) => fn(s, i * 16, 0));
  return s;
}

// ---- CHARACTERS (4 frames x 4 dirs, 16x24 each) ---------------------------
// rows = dirs [down,left,right,up]; cols = walk frames 0..3
export function drawChar(s, ox, oy, dirIndex, frame, role) {
  const skin = C.skin;
  const shirt = role.shirt, hair = role.hair, pants = role.pants;
  const darker = (c, f = 0.72) => [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)];
  const shirtLo = darker(shirt), pantsLo = darker(pants);
  const outline = C.black;
  // head
  s.rect(ox + 5, oy + 2, 6, 6, skin);
  // hair / hat (up = back of head fully covered)
  s.rect(ox + 5, oy + 1, 6, 2, hair);
  s.rect(ox + 5, oy + 2, 1, 3, hair);
  s.rect(ox + 10, oy + 2, 1, 3, hair);
  if (dirIndex === 3) s.rect(ox + 5, oy + 2, 6, 6, hair); // facing up: hair covers face
  // face features per direction
  if (dirIndex === 0) { s.px(ox + 6, oy + 5, C.black); s.px(ox + 9, oy + 5, C.black); }
  if (dirIndex === 1) { s.px(ox + 6, oy + 5, C.black); }            // left
  if (dirIndex === 2) { s.px(ox + 9, oy + 5, C.black); }            // right
  // body / shirt
  s.rect(ox + 4, oy + 8, 8, 7, shirt);
  s.rect(ox + 4, oy + 8, 8, 1, [255, 255, 255, 60]);
  // arms
  s.rect(ox + 3, oy + 9, 1, 4, shirt);
  s.rect(ox + 12, oy + 9, 1, 4, shirt);
  s.px(ox + 3, oy + 13, skin); s.px(ox + 12, oy + 13, skin);
  // legs with walk-cycle offset
  const swing = [0, 1, 0, -1][frame];
  s.rect(ox + 5, oy + 15, 2, 6 + (swing > 0 ? 1 : 0), pants);   // left leg
  s.rect(ox + 9, oy + 15, 2, 6 + (swing < 0 ? 1 : 0), pants);   // right leg
  s.rect(ox + 5, oy + 20, 2, 2, C.black);  // shoes
  s.rect(ox + 9, oy + 20, 2, 2, C.black);
  // 2-tone shading: darken the right side of torso and legs
  s.rect(ox + 10, oy + 8, 2, 7, shirtLo);          // shirt right edge
  s.rect(ox + 9, oy + 15, 2, 6, pantsLo);          // right leg
  s.rect(ox + 4, oy + 8, 8, 1, [255, 255, 255, 60]); // re-assert top highlight over shade
  // 1px silhouette outline down the body edges (arms → legs)
  for (let y = 8; y <= 14; y++) { s.px(ox + 3, oy + y, outline); s.px(ox + 12, oy + y, outline); }
  for (let y = 15; y <= 21; y++) { s.px(ox + 4, oy + y, outline); s.px(ox + 11, oy + y, outline); }
}
function drawCharSleep(s, ox, oy, role) {
  const skin = C.skin, hair = role.hair, blanket = role.shirt;
  // lying horizontally, centered vertically in the 16x24 cell
  s.rect(ox + 2, oy + 13, 12, 6, blanket);     // blanket over body
  s.rect(ox + 2, oy + 12, 12, 1, [255,255,255,60]); // blanket highlight
  s.rect(ox + 3, oy + 10, 4, 4, skin);          // head (left)
  s.rect(ox + 3, oy + 9, 4, 2, hair);           // hair on top of head
  s.px(ox + 5, oy + 12, C.black);               // closed-eye dot
}
export function buildCharacter(role) {
  const s = surface(4 * 16, 5 * 24);
  for (let d = 0; d < 4; d++) for (let f = 0; f < 4; f++) drawChar(s, f * 16, d * 24, d, f, role);
  drawCharSleep(s, 0, 4 * 24, role);            // sleep pose in row 4, col 0
  return s;
}
export const ROLES = {
  professor: { shirt: [233, 238, 245], hair: [200, 205, 215], pants: [120, 124, 134] }, // lab coat, gray hair
  'dev-a':   { shirt: [74, 163, 255],  hair: [110, 74, 40],   pants: [40, 52, 78] },     // blue dev
  'dev-b':   { shirt: [255, 122, 217], hair: [40, 36, 50],    pants: [70, 50, 90] },     // pink dev
  reviewer:  { shirt: [255, 210, 74],  hair: [60, 50, 40],    pants: [90, 70, 40] },     // gold reviewer
  npc:       { shirt: [108, 230, 122], hair: [70, 60, 50],    pants: [60, 80, 60] },     // green npc
};

// ---- write everything ------------------------------------------------------
function write(rel, surf) {
  const p = join(HERE, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, encodePNG(surf));
  console.log(`wrote ${rel} (${surf.w}x${surf.h})`);
}

export function isMainModule(argv1, moduleUrl) {
  return !!argv1 && fileURLToPath(moduleUrl) === argv1;
}
const isMain = isMainModule(process.argv[1], import.meta.url);
if (isMain) {
  write('tileset.png', buildTileset());
  write('items.png', buildItems());
  for (const [role] of Object.entries(ROLES)) write(`characters/${role}.png`, buildCharacter(ROLES[role]));
  console.log('done');
}
