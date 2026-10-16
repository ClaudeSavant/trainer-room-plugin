import { tierFor } from './world.mjs';

const TIER_KEY = { token: 'tool', doc: 'doc', parcel: 'parcel', deliverable: 'deliverable' };
const emptyBucket = () => ({ tool: 0, doc: 0, parcel: 0, deliverable: 0, activeMs: 0,
  usage: { in: 0, out: 0, cacheRead: 0, cc5m: 0, cc1h: 0 } });

export function createStats() { return { bySession: {}, seenTurns: new Set() }; }

export function accumulate(stats, ev) {
  if (!ev || typeof ev.agent !== 'string' || ev.agent.length === 0 || typeof ev.type !== 'string') return stats;
  const model = ev.model || 'unknown';
  // Key by session: every main session is named 'lead', so name-keying silently
  // summed two concurrent leads into one bucket. `|| ev.agent` is the legacy
  // fallback for events emitted without a session (same shape as world.mjs).
  const key = ev.session || ev.agent;
  const prev = stats.bySession[key] ?? { name: ev.agent, status: 'idle', lastTs: null, lastModel: null, byModel: {} };
  const byModel = { ...prev.byModel };
  const ts = Date.parse(ev.ts);
  const tsValid = Number.isFinite(ts);

  // accrue active time to the model that was running during the gap (only while working)
  if (prev.status === 'working' && prev.lastTs != null && tsValid) {
    const delta = ts - prev.lastTs;
    const pm = prev.lastModel ?? model;
    const pb = { ...(byModel[pm] ?? emptyBucket()) };
    pb.activeMs += delta > 0 ? delta : 0;
    byModel[pm] = pb;
  }

  // status transition
  let status = prev.status;
  if (ev.type === 'agent_start') status = 'working';
  else if (ev.type === 'agent_stop') status = 'idle';
  else if (ev.type === 'agent_shutdown') status = 'idle';
  else status = 'working';

  // counts on the current model bucket (clone nested usage so it isn't shared)
  const base = byModel[model] ?? emptyBucket();
  const cur = { ...base, usage: { ...base.usage } };
  const tierKey = TIER_KEY[tierFor(ev.type)];
  if (tierKey) cur[tierKey] += 1;

  // token usage, deduped by turnId (the same assistant turn is re-read by every
  // tool-call hook fire — count it once)
  const seenTurns = new Set(stats.seenTurns ?? []);
  if (ev.turnId && ev.tokens && !seenTurns.has(ev.turnId)) {
    seenTurns.add(ev.turnId);
    const u = cur.usage, t = ev.tokens;
    u.in += t.in || 0; u.out += t.out || 0; u.cacheRead += t.cacheRead || 0;
    u.cc5m += t.cc5m || 0; u.cc1h += t.cc1h || 0;
  }
  byModel[model] = cur;

  return {
    bySession: {
      ...stats.bySession,
      // `name` is refreshed on every event, not frozen at creation: a session's
      // first event can carry 'unknown' (identity.mjs on a transcript read
      // error) and a later one the real name.
      [key]: { name: ev.agent, status, lastTs: tsValid ? (prev.lastTs == null ? ts : Math.max(prev.lastTs, ts)) : prev.lastTs, lastModel: model, byModel },
    },
    seenTurns,
  };
}

export function overallByModel(stats) {
  const out = {};
  for (const a of Object.values(stats.bySession)) {
    for (const [m, b] of Object.entries(a.byModel)) {
      const o = out[m] ?? { tool: 0, doc: 0, parcel: 0, deliverable: 0, activeMs: 0,
        usage: { in: 0, out: 0, cacheRead: 0, cc5m: 0, cc1h: 0 } };
      o.tool += b.tool; o.doc += b.doc; o.parcel += b.parcel; o.deliverable += b.deliverable; o.activeMs += b.activeMs;
      const bu = b.usage || {};
      o.usage.in += bu.in || 0; o.usage.out += bu.out || 0; o.usage.cacheRead += bu.cacheRead || 0;
      o.usage.cc5m += bu.cc5m || 0; o.usage.cc1h += bu.cc1h || 0;
      out[m] = o;
    }
  }
  return out;
}
