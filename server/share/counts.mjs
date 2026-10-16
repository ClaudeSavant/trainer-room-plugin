// Per-project presence for sharing. Built on the same world model the browser
// renders, so a shared count is exactly the number of trainers the owner sees
// in that room: spawned and not shut down, sleepers included (spec §3).
import { createWorld, applyEvent, reapStale } from '../../web/sim/world.mjs';
import { roomKey } from '../../web/engine/routing.mjs';
import { LIMITS } from '../../relay/validate.mjs';

export function createCounts() {
  const worlds = new Map();   // projectKey -> world

  function put(key, world) {
    if (Object.keys(world.agents).length) worlds.set(key, world);
    else worlds.delete(key);
  }

  return {
    // Same malformed-event guard as main.mjs's handle().
    apply(ev) {
      if (!ev || typeof ev.agent !== 'string' || ev.agent.length === 0 || typeof ev.type !== 'string') return;
      const key = roomKey(ev);
      put(key, applyEvent(worlds.get(key) ?? createWorld(), ev));
    },

    reap(nowMs) {
      for (const [key, world] of [...worlds]) put(key, reapStale(world, nowMs));
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
