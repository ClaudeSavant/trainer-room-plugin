const TIERS = { tool_call: 'token', file_write: 'doc', task_done: 'parcel', commit: 'deliverable' };

// Defense-in-depth: agents whose `agent_shutdown` (SessionEnd) never arrives are
// reaped after this much wall-clock silence. Deliberately far longer than any
// legitimate idle/sleep stretch (see IDLE_AFTER_MS/SLEEPY_AFTER_MS in trainer.mjs)
// so it only ever removes genuinely abandoned agents.
export const REAP_AFTER_MS = 45 * 60 * 1000;

// The main session gets a far longer leash than a teammate: it is the one the
// user is talking to and must not vanish mid-conversation just because they
// stepped away. It is still bounded, though — `main` is sticky and is never
// cleared, so an interactive session that dies without a SessionEnd (crash,
// kill -9, closed terminal) would otherwise leave a trainer that is immortal
// until someone dismisses it by hand.
//
// 72h is not a round number picked for neatness: it is the smallest bound that
// survives a full weekend. A laptop closed Friday evening and reopened Monday
// morning is ~63h of silence, so 24h or 48h would empty the room over a normal
// weekend — the exact failure this bound exists to avoid. Do not "tidy" this
// down without re-checking that case; a crashed session still disappears within
// three days, which is the point of having a bound at all.
export const MAIN_REAP_AFTER_MS = 72 * 60 * 60 * 1000;

export function tierFor(type) {
  return TIERS[type] ?? null;
}

export function createWorld() {
  return { agents: {} };
}

function newAgent(session, name, team, deskIndex, main) {
  return { session, name, team, main: main === true, deskIndex, present: false, idle: false, caption: '', lastType: null, lastEventTs: null, items: [] };
}

export function applyEvent(world, ev) {
  const agents = { ...world.agents };
  // Identity is the session, not the name: every main session is called 'lead',
  // so name-keying silently merged two concurrent sessions into one trainer.
  // Legacy events with no session fall back to the name so they still land
  // deterministically rather than under 'undefined'.
  const key = ev.session || ev.agent;

  // SessionEnd: the agent's session is gone — remove it outright (immutable delete)
  // so its desk frees up and agentCount() stops counting a departed agent.
  if (ev.type === 'agent_shutdown') {
    delete agents[key];
    return { agents };
  }

  const prev = agents[key] ?? newAgent(key, ev.agent, ev.team, Object.keys(agents).length, ev.main);
  const ts = Date.parse(ev.ts);
  const a = {
    ...prev, name: ev.agent, team: ev.team,
    // Three states, not two. An event that OMITS `main` carries no evidence, so
    // the session keeps what it had: a flagless event must not demote the one
    // the user is talking to. An event that STATES `main` is an assertion and
    // wins outright — a teammate whose first hook fired before its transcript
    // carried an agentName is stamped main by fall-through, and the later event
    // that resolves its real name is what demotes it back onto the ordinary
    // 45-minute reap tier. Plain stickiness (`prev.main || ...`) left those
    // sessions main forever: addressable by the console and reaped at 72h.
    main: ev.main === undefined ? prev.main : ev.main === true,
    lastType: ev.type, caption: ev.summary,
    lastEventTs: Number.isFinite(ts) ? ts : prev.lastEventTs,
    items: prev.items.slice(),
  };

  if (ev.type === 'agent_start') {
    a.present = true; a.idle = false;
  } else if (ev.type === 'agent_stop') {
    a.present = true; a.idle = true;
  } else {
    a.present = true; a.idle = false;
    const tier = tierFor(ev.type);
    if (tier) a.items.push({ tier });
  }

  agents[key] = a;
  return { agents };
}

// Pure safety net: return a new world with any agent whose last event is older
// than `thresholdMs` before `nowMs` removed. Agents within the threshold (and
// those with no recorded timestamp) are kept unchanged.
export function reapStale(world, nowMs, thresholdMs = REAP_AFTER_MS) {
  const agents = {};
  for (const [key, a] of Object.entries(world.agents)) {
    // Two tiers, both bounded (see MAIN_REAP_AFTER_MS): the main session sleeps
    // in the barracks through a long quiet stretch rather than disappearing,
    // but a crashed one is not immortal. An agent whose timestamp never parsed
    // is kept on either tier — an unknown age is not evidence of staleness.
    const limit = a.main ? MAIN_REAP_AFTER_MS : thresholdMs;
    if (Number.isFinite(a.lastEventTs) && nowMs - a.lastEventTs > limit) continue;
    agents[key] = a;
  }
  return { agents };
}
