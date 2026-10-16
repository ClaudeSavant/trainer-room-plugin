// Counts → the existing simulation (sharing spec §5). A relay update is a list
// of { room, n }; this turns each change into the synthetic events the room
// sim already understands, so trainers walk in and out with today's animation.
// Pure: no DOM, no network.
export const VISITOR_NAME = 'trainer';          // not in config.agents → generic 'npc' outfit
export const KEEPALIVE_MS = 3000;               // under IDLE_AFTER_MS: visitors stay at their desks
export const RETRY_MS = 15 * 1000;              // re-check a link that is not live
export const VIEWER_CONFIG = Object.freeze({
  agents: {},
  palette: ['#4aa3ff', '#ff7ad9', '#ffd24a', '#6ce67a', '#c98aff', '#ff9f4a'],
});
const MAX_ROOMS = 64; // mirrors relay/validate.mjs LIMITS.maxRooms
const MAX_N = 99; // mirrors relay/validate.mjs LIMITS.maxN (this file runs in the browser)

export function createCountsAdapter({ now = () => new Date().toISOString() } = {}) {
  // Room numbers: a room keeps its number while it is live. A departed room's
  // number is remembered (so it comes back as the same "Room N") until a new room
  // needs the space; then the oldest departed is forgotten and the lowest free
  // number is reused. So at most MAX_ROOMS rooms are held and N <= MAX_ROOMS.
  const nums = new Map();      // room id -> number, oldest first (live and departed)
  const present = new Map();   // room id -> sessions on screen, in arrival order
  let nextId = 0;
  const ev = (room, session, type) => ({ ts: now(), agent: VISITOR_NAME, session, type, project: room, summary: '' });

  function numberFor(room) {
    if (nums.has(room)) return nums.get(room);
    if (nums.size >= MAX_ROOMS) {
      for (const r of nums.keys()) if (!present.has(r)) { nums.delete(r); break; }
    }
    const used = new Set(nums.values());
    let n = 1;
    while (used.has(n)) n++;
    nums.set(room, n);
    return n;
  }

  return {
    update(rooms) {
      const want = new Map();
      for (const r of (Array.isArray(rooms) ? rooms : []).slice(0, MAX_ROOMS)) {
        if (!r || typeof r.room !== 'string' || !Number.isInteger(r.n)) continue;
        want.set(r.room, Math.max(0, Math.min(MAX_N, r.n)));
      }
      const out = [];
      // Departures first (they free numbers), then arrivals in the order given.
      for (const room of [...present.keys()]) {
        if ((want.get(room) ?? 0) > 0) continue;
        for (const s of present.get(room).reverse()) out.push(ev(room, s, 'agent_shutdown'));
        present.delete(room);
      }
      for (const [room, target] of want) {
        if (target <= 0) continue;
        numberFor(room);
        const list = present.get(room) ?? [];
        while (list.length < target) {
          const session = `v${++nextId}`;
          list.push(session);
          out.push(ev(room, session, 'agent_start'), ev(room, session, 'presence'));
        }
        while (list.length > target) out.push(ev(room, list.pop(), 'agent_shutdown'));
        present.set(room, list);
      }
      return out;
    },

    keepalive() {
      const out = [];
      for (const [room, list] of present) for (const s of list) out.push(ev(room, s, 'presence'));
      return out;
    },

    labelOf(room) {
      return nums.has(room) ? `Room ${nums.get(room)}` : '';
    },

    rooms() { return [...present.keys()].sort((x, y) => nums.get(x) - nums.get(y)); },
  };
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtSince(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'a while ago';
  const d = new Date(t);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return nowMs - t > 86_400_000 ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}

// Header text for the viewer. `state` is the last /watch frame, { missing: true }
// when the link is not live, or null before the first answer.
export function statusView(state) {
  if (!state) return { title: 'Trainer Room', badge: 'connecting', banner: null };
  if (state.unreachable) return { title: 'Trainer Room', badge: 'reconnecting', banner: "Can't reach the relay right now. Retrying…" };
  if (state.missing) {
    return { title: 'Trainer Room', badge: 'not sharing', banner: "This lab isn't being shared right now. Sharing is off, or the link was reset." };
  }
  const title = typeof state.name === 'string' && state.name ? state.name : 'Trainer Room lab';
  if (!state.online) return { title, badge: 'offline', banner: `offline since ${fmtSince(state.lastSeen)}` };
  const rooms = Array.isArray(state.rooms) ? state.rooms : [];
  return { title, badge: 'online', banner: rooms.length ? null : 'No agents running right now.' };
}

export function inviteFromPath(pathname) {
  const m = /^\/l\/([A-Za-z0-9_-]{22})\/?$/.exec(String(pathname ?? ''));
  return m ? m[1] : null;
}
