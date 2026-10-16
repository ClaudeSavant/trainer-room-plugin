// Hosted viewer for a shared lab (sharing spec §5). Counts only: it listens to
// this relay's /watch stream and nothing else, and every text it shows goes in
// through textContent.
import { loadImages, browserLoad, withTimeout } from '/engine/assets.mjs';
import { roomPx, canvasSizing } from '/engine/tilemap.mjs';
import { ROOM } from '/engine/room.mjs';
import { createRoom } from '/engine/room-instance.mjs';
import { loadRenderer, probeWebGL, afterContextLoss, fallbackLogArgs, nextFallback } from '/render3d/backend.mjs';
import { startKeepalive } from '/viewer/keepalive.mjs';
import { createCountsAdapter, statusView, inviteFromPath, VIEWER_CONFIG, KEEPALIVE_MS, RETRY_MS } from '/viewer/adapter.mjs';

const ASSET_TIMEOUT_MS = 5000;
const roomsEl = document.getElementById('rooms');
const nameEl = document.getElementById('labName');
const badgeEl = document.getElementById('badge');
const bannerEl = document.getElementById('banner');

const adapter = createCountsAdapter();
const cards = new Map();   // relay room id -> { room, card, canvas, ctx }
let manifest = null;
let bundle = null;
let rendererState = { kind: '2d', reason: 'booting' };
let r3d = null;
let shown = [];            // room ids whose cards are on screen
// Live getters: assets load asynchronously after rooms may already exist.
const deps = {
  config: VIEWER_CONFIG,
  get manifest() { return manifest; },
  get bundle() { return bundle; },
  presenceOnly: true,
};

function fallbackTo2d(next) {
  const state = nextFallback(rendererState, next);
  if (!state) return;
  rendererState = state;
  if (r3d) { r3d.hideOverlays(); try { r3d.dispose(); } catch (e) { console.warn('[trainer-room viewer] 3D dispose failed', e); } }
  r3d = null;
  roomsEl.classList.remove('r3d');
  console.warn(...fallbackLogArgs(state));
}

function ensureCard(id) {
  if (cards.has(id)) return cards.get(id);
  const card = document.createElement('div'); card.className = 'card';
  const h = document.createElement('h2'); h.textContent = adapter.labelOf(id);
  const stage = document.createElement('div'); stage.className = 'stage';
  const canvas = document.createElement('canvas');
  const overlayEl = document.createElement('div'); overlayEl.className = 'ov';
  stage.append(canvas, overlayEl);
  card.append(h, stage);
  roomsEl.appendChild(card);
  const entry = { room: createRoom(id, deps), card, canvas, ctx: canvas.getContext('2d') };
  cards.set(id, entry);
  if (r3d) {
    try { r3d.ensureRoom(id, overlayEl); }
    catch (error) { fallbackTo2d({ kind: '2d', reason: 'attach-failed', error }); }
  }
  return entry;
}

function feed(events) {
  for (const ev of events) ensureCard(ev.project).room.applyEvent(ev);
}

function applyState(next) {
  feed(adapter.update(next.online ? next.rooms : []));
  // Offline keeps the last rooms on screen, empty (spec §5); a dead link shows none.
  if (next.online) shown = adapter.rooms();
  if (next.missing) shown = [];
  const s = statusView(next);
  document.title = `${s.title} · Trainer Room`;
  nameEl.textContent = s.title;
  badgeEl.textContent = s.badge;
  badgeEl.className = `badge badge-${s.badge.replace(/\s+/g, '-')}`;
  bannerEl.hidden = !s.banner;
  bannerEl.textContent = s.banner ?? '';
}

function connect(invite) {
  const es = new EventSource(`/watch?invite=${encodeURIComponent(invite)}`);
  es.onmessage = (m) => {
    try { applyState(JSON.parse(m.data)); }
    catch (err) { console.warn('[trainer-room viewer] bad lab state', err); }
  };
  es.onerror = () => {
    // CONNECTING: EventSource is already retrying. CLOSED: the relay answered
    // 404 (sharing off, link reset, or a restarted relay the owner has not
    // re-registered with yet), so check again later.
    if (es.readyState !== EventSource.CLOSED) return;
    applyState({ missing: true });
    setTimeout(() => connect(invite), RETRY_MS);
  };
}

let last = performance.now();
let loopWarned = false;
function loop(now) {
  try { frame(now); }
  catch (error) {
    if (!loopWarned) { loopWarned = true; console.warn('[trainer-room viewer] frame failed', error); }
  }
  requestAnimationFrame(loop);
}

function frame(now) {
  const dt = now - last; last = now;
  const d = new Date();
  const hour = d.getHours() + d.getMinutes() / 60;
  const vis = new Set(shown);
  const S = manifest ? manifest.tileSize : 16;
  const { w: rw, h: rh } = roomPx(ROOM, S);
  for (const [id, entry] of cards) {
    const visible = vis.has(id);
    entry.card.style.display = visible ? '' : 'none';
    if (!visible) continue;
    const { room, canvas, ctx } = entry;
    canvas.style.width = '';
    const sizing = canvasSizing(false, 0, 0, rw, rh, canvas.clientWidth || 360);
    const pr = r3d ? r3d.pixelRatio('grid') : 1;
    const bw = Math.round(sizing.width * pr), bh = Math.round(sizing.height * pr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    room.tickSim(dt);
    if (r3d) {
      if (r3d.frameDue(id, now, 'grid')) {
        try { r3d.renderRoom(id, { snapshot: room.snapshot(now, hour), ctx, canvas, mode: 'grid', now }); }
        catch (error) { fallbackTo2d({ kind: '2d', reason: 'draw-failed', error }); }
      }
    } else {
      room.render(ctx, canvas, now, hour);
    }
  }
}

async function boot() {
  const invite = inviteFromPath(location.pathname);
  if (!invite) { applyState({ missing: true }); return; }
  try {
    const loaded = await withTimeout((async () => {
      const res = await fetch('/assets/manifest.json');
      const m = await res.json();
      const b = await loadImages(m, browserLoad('/assets'));
      return { m, b };
    })(), ASSET_TIMEOUT_MS, 'asset load');
    manifest = loaded.m; bundle = loaded.b;
  } catch (err) {
    console.warn('[trainer-room viewer] asset load failed; procedural rendering', err);
  }
  rendererState = await loadRenderer({ param: new URLSearchParams(location.search).get('renderer'), webgl: probeWebGL() });
  if (rendererState.kind === '3d') {
    try {
      r3d = rendererState.mod.createRenderer3d({
        reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
        onContextLost: () => fallbackTo2d(afterContextLoss(rendererState)),
      });
      roomsEl.classList.add('r3d');
    } catch (error) {
      r3d = null;
      fallbackTo2d({ kind: '2d', reason: 'init-failed', error });
    }
  }
  connect(invite);
  // A timer, not rAF: a background tab stops rAF, and visitors left without
  // events for 45 min would be reaped while the relay still counts them.
  startKeepalive({ adapter, feed, ms: KEEPALIVE_MS });
  requestAnimationFrame(loop);
}

boot();
