// Per-project presence for sharing. Built on the same world model the browser
// renders, so a shared count is exactly the number of trainers the owner sees
// in that room: spawned and not shut down. Sessions are placed by the same
// router the browser uses, so a trainer counts in exactly one room (spec §3).
import { createWorld, applyEvent, reapStale } from '../../web/sim/world.mjs';
import { createSessionRooms } from '../../web/engine/session-rooms.mjs';
import { LIMITS } from '../../relay/validate.mjs';

export function createCounts() {
  const worlds = new Map();   // projectKey -> world
  const router = createSessionRooms();

  function put(key, world) {
    if (Object.keys(world.agents).length) worlds.set(key, world);
    else worlds.delete(key);
  }

  return {
    // Same malformed-event guard as main.mjs's handle().
    apply(ev) {
      if (!ev || typeof ev.agent !== 'string' || ev.agent.length === 0 || typeof ev.type !== 'string') return;
      const out = router.route(ev);
      if (out.from !== null) {
        put(out.from, applyEvent(worlds.get(out.from) ?? createWorld(), { ...out.ev, type: 'agent_shutdown' }));
      }
      if (out.room === null) return;
      put(out.room, applyEvent(worlds.get(out.room) ?? createWorld(), out.ev));
    },

    reap(nowMs) {
      for (const [key, world] of [...worlds]) {
        const next = reapStale(world, nowMs);
        for (const session of Object.keys(world.agents)) if (!(session in next.agents)) router.forget(session);
        put(key, next);
      }
    },

    totals() {
      const out = [];
      for (const [projectKey, world] of worlds) {
        const n = Object.keys(world.agents).length;
        if (n > 0) out.push({ projectKey, n: Math.min(n, LIMITS.maxN) });
      }
      if (out.length > LIMITS.maxRooms) {
        out.sort((a, b) => b.n - a.n);
        out.length = LIMITS.maxRooms;
      }
      return out;
    },
  };
}
