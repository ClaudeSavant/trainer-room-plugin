// Which room a session is in. Pure routing memory, shared by the browser and the
// share counter so both agree (spec items 8-9). A session has no room until its
// first event carrying a real project; after that it only moves on a WORK event
// in another project — the builder's "when a switch happens" call — so a stray
// agent_stop or a cd into a scratch dir never drags a trainer between rooms,
// and a Task subagent's events (`sub`) never place or move the session at all.

export const WORK_TYPES = new Set(['tool_call', 'file_write', 'task_done', 'commit']);

// Duplicated from hooks/ (web/ cannot import it) and routing.mjs's fallback.
const NO_PROJECT = '(no project)';
const isReal = (p) => typeof p === 'string' && p !== '' && p !== NO_PROJECT && p !== 'unknown';

export function createSessionRooms({ cap = 512 } = {}) {
  const seen = new Map();   // session -> { room, main }, oldest first; room null = seen, no project yet

  function remember(session, entry) {
    seen.delete(session);
    seen.set(session, entry);
    while (seen.size > cap) seen.delete(seen.keys().next().value);
  }

  return {
    route(ev) {
      const session = ev.session || ev.agent;
      const known = seen.has(session);
      const cur = seen.get(session) ?? { room: null, main: undefined };
      const main = typeof ev.main === 'boolean' ? ev.main : cur.main;
      const out = main === undefined || ev.main === main ? ev : { ...ev, main };

      if (ev.type === 'agent_shutdown') {
        seen.delete(session);
        return { room: cur.room, from: null, entered: false, ev: out };
      }

      let room = cur.room;
      let from = null;
      // A subagent's event (`sub`, stamped by the hook) shares its parent's
      // session but not its cwd: it rides along in the current room and never
      // places or moves the session. Nor is it a sighting — a roomless entry
      // is remembered only if the session was already seen in its own right.
      if (ev.sub === true) {
        if (known) remember(session, { room, main });
        return { room, from, entered: false, ev: out };
      }
      if (isReal(ev.project)) {
        if (room === null) room = ev.project;
        else if (ev.project !== room && WORK_TYPES.has(ev.type)) { from = room; room = ev.project; }
      }
      remember(session, { room, main });
      // `entered`: this router already saw the session with no room, so its first
      // room is a genuine entry (started at / or $HOME, then began work in a
      // project). A session first seen already in a project is not: it may just
      // be a reload mid-session.
      const entered = known && cur.room === null && room !== null;
      return { room, from, entered, ev: out };
    },

    forget(session) { seen.delete(session); },

    // The room dropped the session (stale reap, room restart) but it may still
    // be alive: keep it as seen-but-roomless, so if it works again its next
    // placement is an entry and it walks in through the door.
    vacate(session) {
      remember(session, { room: null, main: seen.get(session)?.main });
    },

    roomOf(session) { return seen.get(session)?.room ?? null; },
  };
}
