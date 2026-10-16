import { readFileSync } from 'node:fs';

function usageFrom(e) {
  const u = e.message?.usage;
  const turnId = e.uuid ?? null;
  if (!u) return { tokens: null, turnId };
  const cc = u.cache_creation || {};
  const hasSplit = cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null;
  return {
    turnId,
    tokens: {
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cc5m: hasSplit ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0),
      cc1h: cc.ephemeral_1h_input_tokens || 0,
    },
  };
}

export function resolveIdentity(payload, readTail = readTranscriptTail) {
  const session = payload?.session_id ?? 'unknown';
  let entries;
  try {
    entries = readTail(payload?.transcript_path) ?? [];
  } catch {
    // Genuine read error: surface as 'unknown' so live attribution failures
    // are observable (spec §11) rather than masked as the lead.
    //
    // `main` is OMITTED, not false. A failed read is no evidence either way, and
    // the flag is sticky downstream (web/sim/world.mjs): stamping false here
    // would demote a real main session on one transient read failure, while
    // stamping true would promote a teammate. Absent means "unchanged".
    return { agent: 'unknown', team: 'team', session, model: 'unknown', tokens: null, turnId: null };
  }
  // 1) Prefer the newest entry that belongs to THIS hook's session.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.agentName && e.sessionId === session) {
      return { agent: e.agentName, team: e.teamName ?? 'team', session, model: e.message?.model ?? 'unknown', ...usageFrom(e), main: false };
    }
  }
  // 2) Secondary: newest entry carrying any agentName, from a session that is
  // NOT this one. Best-effort for the name — but no evidence at all about
  // main-ness, so `main` is OMITTED here exactly as it is on the read-error
  // path above.
  //
  // The entry we matched belongs to a different session by construction (path 1
  // already claimed every entry that names this one). It says who wrote that
  // line; it says nothing about who WE are. A Task subagent's hook fires with
  // the PARENT's session_id but the SUBAGENT's transcript_path, so a genuine
  // main session running a subagent lands here and would be stamped main:false
  // for the whole subagent run — the console would report "no main session
  // running" and refuse messages, and a quiet demoted session would drop to the
  // 45-minute teammate reap tier and vanish (spec defect #3, the bug this slice
  // exists to fix). Omitting leaves the sticky flag downstream unchanged, so the
  // name still updates while main-ness survives the excursion.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.agentName) {
      return { agent: e.agentName, team: e.teamName ?? 'team', session, model: e.message?.model ?? 'unknown', ...usageFrom(e) };
    }
  }
  // 3) Successful read but no agentName (e.g. real lead session). This branch —
  // and only this branch — is a main session: the interactive session the user
  // talks to. Structural, never inferred from the name 'lead', because a
  // teammate can legitimately be named lead.
  //
  // main: true here is a FALL-THROUGH, so it is provisional. A teammate's first
  // hook can fire before its transcript carries an agentName, and that session
  // lands here and is stamped main. Path 1 is the correction: a teammate naming
  // ITSELF in its own transcript is a positive assertion (main: false) that
  // demotes it once the name appears. That only works because `false` is
  // asserted rather than omitted — see the sticky merge in web/sim/world.mjs.
  //
  // Path 2 deliberately does NOT correct: another session's name is not evidence
  // about this one, and asserting on it demoted real main sessions mid-subagent.
  // The provisional stamp therefore persists until the session's own transcript
  // names it, which for a real teammate is every entry from its first named turn
  // onward.
  if (payload?.agent_type) return { agent: payload.agent_type, team: 'team', session, model: 'unknown', tokens: null, turnId: null, main: false };
  return { agent: 'lead', team: 'team', session, model: 'unknown', tokens: null, turnId: null, main: true };
}

export function readTranscriptTail(path, n = 50) {
  if (!path) return [];
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').filter(Boolean).slice(-n);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip partial/non-JSON */ }
  }
  return out;
}
