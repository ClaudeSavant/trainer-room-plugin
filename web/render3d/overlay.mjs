// Text over the 3D scene as HTML (crisp at any zoom, no font atlas). The pure
// half (overlayItems) decides what shows; createOverlay pools DOM elements and
// positions them. Text goes in via textContent only: names and captions are
// untrusted input.
import { ROOM } from '../engine/room.mjs';
import { pxToWorld } from './coords.mjs';
import { LYING_SHIFT } from './room-scene.mjs';
import { HEAD_Y, TRAINER_SCALE } from './chibi.mjs';

export const BUBBLE_Y = 2.15;
export const LABEL_Y = -0.05;
// A sleeper lies flat with its head toward world -X of its lie point:
// room-scene shifts the root LYING_SHIFT toward +X and the head sits HEAD_Y
// up the body, which lying points along -X. The pillow lifts the head straight
// up, so it does not move it in X.
export const SLEEPER_HEAD_DX = (LYING_SHIFT - HEAD_Y) * TRAINER_SCALE;
export const SLEEPER_TAG_Y = 1.65; // a little above the head of the tallest (hooded) sleeper
const GRID_CAPTION_MAX = 16;

// Grid cards are small: a long caption would cover the neighbours' bubbles.
function gridCaption(text) {
  return text.length > GRID_CAPTION_MAX ? `${text.slice(0, GRID_CAPTION_MAX - 1)}\u2026` : text;
}

export function overlayItems(snapshot, { mode } = {}) {
  const grid = mode !== 'single';
  const out = [];
  for (const t of snapshot.trainers) {
    const { X, Z } = pxToWorld(t.x, t.y);
    // A sleeper's name rides in its one tag over the pillow, so it has no separate label.
    // The tag is dark (index.html .tag): some label colours are near-white.
    if (t.status === 'sleeping') {
      out.push({ key: `bubble:${t.session}`, kind: 'bubble', text: t.label === '' ? 'Zzz' : `${t.label} \u00b7 Zzz`, color: t.labelColor, tag: true, X: X + SLEEPER_HEAD_DX, Y: SLEEPER_TAG_Y, Z });
      continue;
    }
    if (t.label !== '') out.push({ key: `label:${t.session}`, kind: 'label', text: t.label, color: t.labelColor, X, Y: LABEL_Y, Z });
    if (t.caption) out.push({ key: `bubble:${t.session}`, kind: 'bubble', text: grid ? gridCaption(t.caption) : t.caption, X, Y: BUBBLE_Y, Z });
  }
  if (snapshot.overflow > 0) {
    out.push({ key: 'overflow', kind: 'overflow', text: `+${snapshot.overflow} more`, X: ROOM.cols / 2, Y: 0.6, Z: ROOM.rows - 0.4 });
  }
  return out;
}

// Lifts (px) that keep bubbles from overlapping on screen. Each box is
// { key, x, y, w, h } with (x, y) its bottom-centre anchor. The highest anchor
// keeps its place; each lower one that hits a placed box rises to sit `gap` px
// above it, until it hits nothing. Sorted by y then key, so it is stable
// whatever order the boxes come in.
export function declutter(boxes, gap = 3) {
  const lifts = new Map();
  const placed = [];
  const sorted = [...boxes].sort((a, b) => a.y - b.y || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const bx of sorted) {
    const l = bx.x - bx.w / 2, r = bx.x + bx.w / 2;
    let bottom = bx.y;
    for (;;) {
      const top = bottom - bx.h;
      const hit = placed.find((p) => l < p.r && p.l < r && top < p.b && p.t < bottom);
      if (!hit) break;
      bottom = hit.t - gap; // strictly rises past this box, so the loop ends
    }
    placed.push({ l, r, t: bottom - bx.h, b: bottom });
    lifts.set(bx.key, bx.y - bottom);
  }
  return lifts;
}

// Where each kind hangs off its projected anchor point.
const ANCHOR = { bubble: 'translate(-50%, -100%)', label: 'translate(-50%, 2px)', overflow: 'translate(-50%, -50%)' };

export function createOverlay(container, doc = globalThis.document) {
  const pool = new Map(); // key -> element
  const sizes = new Map(); // key -> { text, w, h }: offsetWidth forces layout, so measure only new text
  function sizeOf(key, el) {
    const c = sizes.get(key);
    if (c && c.text === el.textContent) return c;
    const s = { text: el.textContent, w: el.offsetWidth, h: el.offsetHeight };
    if (s.w > 0) sizes.set(key, s); // 0 means not laid out (hidden card): measure again next time
    return s;
  }
  return {
    update(items, project) {
      const seen = new Set();
      const bubbles = []; // { key, el, x, y, w, h } for declutter
      for (const it of items) {
        seen.add(it.key);
        let el = pool.get(it.key);
        if (!el) {
          el = doc.createElement('div');
          el.className = `ov-${it.kind}`;
          container.appendChild(el);
          pool.set(it.key, el);
        }
        const p = project(it.X, it.Y, it.Z);
        if (!p.visible) { el.style.display = 'none'; continue; }
        if (el.textContent !== it.text) el.textContent = it.text;
        // A bubble switches between a sleeper's coloured tag and a caption, so reset too.
        el.style.color = it.color ?? '';
        el.style.display = '';
        const x = Math.round(p.x), y = Math.round(p.y);
        if (it.kind === 'bubble') bubbles.push({ key: it.key, el, x, y, tag: !!it.tag, ...sizeOf(it.key, el) });
        else el.style.transform = `translate(${x}px, ${y}px) ${ANCHOR[it.kind]}`;
      }
      const lifts = declutter(bubbles);
      for (const b of bubbles) {
        const lift = Math.round(lifts.get(b.key));
        const cls = `ov-bubble${b.tag ? ' tag' : ''}${lift > 0 ? ' lifted' : ''}`;
        if (b.el.className !== cls) b.el.className = cls;
        // The leader line (index.html) hangs --lift px from the tail back down to the anchor.
        if (lift > 0) b.el.style.setProperty('--lift', `${lift}px`);
        b.el.style.transform = `translate(${b.x}px, ${b.y - lift}px) ${ANCHOR.bubble}`;
      }
      for (const [key, el] of pool) {
        if (seen.has(key)) continue;
        // A trainer still here (label or bubble this frame) keeps its quiet
        // element hidden for reuse; a departed trainer's are removed so the pool stays bounded.
        const i = key.indexOf(':');
        const session = i < 0 ? null : key.slice(i + 1);
        if (session !== null && (seen.has(`label:${session}`) || seen.has(`bubble:${session}`))) el.style.display = 'none';
        else { el.remove(); pool.delete(key); sizes.delete(key); }
      }
    },
    hide() { for (const el of pool.values()) el.style.display = 'none'; },
  };
}
