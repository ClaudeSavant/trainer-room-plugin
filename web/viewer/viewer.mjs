// Hosted viewer for a shared lab (sharing spec §5). Counts only: it listens to
// this relay's /watch stream and nothing else, and every text it shows goes in
// through textContent.
import { loadImages, browserLoad, withTimeout } from '/engine/assets.mjs';
import { roomPx, canvasSizing } from '/engine/tilemap.mjs';
import { ROOM } from '/engine/room.mjs';
import { createRoom } from '/engine/room-instance.mjs';
import { arrivalFor } from '/engine/routing.mjs';
import { loadRenderer, probeWebGL, afterContextLoss, fallbackLogArgs, nextFallback } from '/render3d/backend.mjs';
import { startKeepalive } from '/viewer/keepalive.mjs';
import { createCountsAdapter, statusView, inviteFromPath, VIEWER_CONFIG, KEEPALIVE_MS, RETRY_MS } from '/viewer/adapter.mjs';
import { ALL, resolveView, visibleIds, tabItems } from '/viewer/view-mode.mjs';

const ASSET_TIMEOUT_MS = 5000;
const reducedMotionMq = matchMedia('(prefers-reduced-motion: reduce)');
const roomsEl = document.getElementById('rooms');
const nameEl = document.getElementById('labName');
const badgeEl = document.getElementById('badge');
const bannerEl = document.getElementById('banner');
const tabsEl = document.getElementById('tabs');

const adapter = createCountsAdapter();
const cards = new Map();   // relay room id -> { room, card, canvas, ctx }
let manifest = null;
let bundle = null;
let rendererState = { kind: '2d', reason: 'booting' };
let r3d = null;
let shown = [];            // room ids whose cards are on screen
let viewMode = ALL;        // ALL (the grid) or one room id filling the window
let online = false;        // only a live lab can be opened room by room
let lastTabs = '';
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
  for (const entry of cards.values()) { entry.detach3d?.(); entry.detach3d = null; }
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
  const entry = { room: createRoom(id, deps), card, header: h, canvas, ctx: canvas.getContext('2d'), detach3d: null };
  cards.set(id, entry);
  // In the grid a click opens the room; inside a room, clicks belong to the camera.
  // Only from the grid: inside a room the camera owns clicks and drags.
  card.addEventListener('click', () => { if (viewMode === ALL) setView(id); });
  if (r3d) {
    try {
      r3d.ensureRoom(id, overlayEl);
      entry.detach3d = r3d.attachControls(id, canvas, { isSingle: () => viewMode === id, onClick: () => null });
    } catch (error) { fallbackTo2d({ kind: '2d', reason: 'attach-failed', error }); }
  }
  return entry;
}

function setView(next) {
  const prev = viewMode;
  // Offline or not shared, the rooms are empty: stay on the grid with its banner.
  viewMode = online ? resolveView(next, shown) : ALL;
  roomsEl.classList.toggle('single', viewMode !== ALL);
  if (viewMode !== prev) scrollTo(0, 0);   // a scrolled grid must not leave the room half off-screen
  renderTabs();
}

function renderTabs() {
  const items = tabItems(shown, viewMode, (id) => adapter.labelOf(id), (id) => cards.get(id)?.room.agentCount() ?? 0);
  tabsEl.hidden = !online || shown.length === 0;
  const sig = JSON.stringify(items);
  if (sig === lastTabs) return;
  lastTabs = sig;
  tabsEl.replaceChildren(...items.map((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    if (it.active) { b.classList.add('active'); b.setAttribute('aria-current', 'true'); }
    b.addEventListener('click', () => setView(it.id));
    return b;
  }));
}

addEventListener('keydown', (e) => { if (e.key === 'Escape' && viewMode !== ALL) setView(ALL); });

// No SessionStart history reaches the viewer, so a room's first batch is its
// snapshot and is placed seated; after that a new visitor walks in.
function feed(events) {
  const known = new Set(cards.keys());
  for (const ev of events) {
    const fromSnapshot = !known.has(ev.project);
    ensureCard(ev.project).room.applyEvent(ev, { arrive: arrivalFor({ fromSnapshot, type: ev.type, switched: false }) });
  }
}

// A room that left the lab closes once its last trainer is through the door.
// Rooms still listed (an offline lab keeps its last rooms on screen) stay.
function dropCard(id) {
  const entry = cards.get(id);
  entry.detach3d?.();
  r3d?.dropRoom(id);
  entry.card.remove();
  cards.delete(id);
}

function applyState(next) {
  feed(adapter.update(next.online ? next.rooms : []));
  // Offline keeps the last rooms on screen, empty (spec §5); a dead link shows none.
  if (next.online) shown = adapter.rooms();
  if (next.missing) shown = [];
  online = next.online === true;
  setView(viewMode);
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
  const vis = new Set(visibleIds(viewMode, shown));
  const mode = viewMode === ALL ? 'grid' : 'single';
  const S = manifest ? manifest.tileSize : 16;
  const { w: rw, h: rh } = roomPx(ROOM, S);
  const reducedMotion = reducedMotionMq.matches;   // read once per frame
  for (const [id, entry] of [...cards]) {
    if (!shown.includes(id) && entry.room.isEmpty()) { dropCard(id); continue; }
    // A room that just left the lab stays in the grid while its trainers walk out.
    const visible = vis.has(id) || (online && viewMode === ALL && !shown.includes(id));
    entry.card.style.display = visible ? '' : 'none';
    // Hidden rooms still tick, so trainers are where they should be on return
    // and a room that left finishes walking out and closes.
    if (!visible) { entry.room.tickSim(dt); continue; }
    const { room, canvas, ctx } = entry;
    let sizing;
    if (mode === 'single') {
      // Fit the whole card in what is left of the window below the header,
      // banner and tabs, letterboxed like the app's single-room view.
      const top = roomsEl.getBoundingClientRect().top;
      const availW = roomsEl.clientWidth - 22;
      const availH = window.innerHeight - top - 22 - entry.header.offsetHeight;
      sizing = canvasSizing(true, availW, availH, rw, rh);
    } else {
      canvas.style.width = '';
      sizing = canvasSizing(false, 0, 0, rw, rh, canvas.clientWidth || 360);
    }
    canvas.style.width = sizing.styleWidth;
    const pr = r3d ? r3d.pixelRatio(mode) : 1;
    const bw = Math.round(sizing.width * pr), bh = Math.round(sizing.height * pr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    room.tickSim(dt);
    if (r3d) {
      if (r3d.frameDue(id, now, mode)) {
        try { r3d.renderRoom(id, { snapshot: room.snapshot(now, hour), ctx, canvas, mode, now }); }
        catch (error) { fallbackTo2d({ kind: '2d', reason: 'draw-failed', error }); }
      }
    } else {
      room.render(ctx, canvas, now, hour, { reducedMotion });
    }
  }
  renderTabs();   // counts change as trainers come and go; rebuilds only on change
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
        reducedMotion: () => reducedMotionMq.matches,
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
