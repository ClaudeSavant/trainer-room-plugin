import { overallByModel } from '../sim/stats.mjs';
import { costFor } from '../sim/pricing.mjs';

const LABELS = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-fable-5': 'Fable 5',
  'unknown': '?',
};

export function modelLabel(id) {
  if (!id) return '?';
  if (LABELS[id]) return LABELS[id];
  if (id.startsWith('claude-haiku-4-5')) return 'Haiku 4.5';
  if (id.startsWith('claude-opus-4')) return 'Opus 4.8';
  if (id.startsWith('claude-sonnet-4')) return 'Sonnet 4.6';
  return id; // verbatim for genuinely unknown ids
}

export function formatUSD(n) {
  const v = n || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

export function activeLabel(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m${String(rem).padStart(2, '0')}s` : `${rem}s`;
}

function rowsFor(agentState, now) {
  const byModel = agentState.byModel;
  const working = agentState.status === 'working' && agentState.lastTs != null;
  const liveModel = agentState.lastModel;
  return Object.keys(byModel).sort().map((model) => {
    const b = byModel[model];
    let activeMs = b.activeMs;
    if (working && model === liveModel && now > agentState.lastTs) activeMs += (now - agentState.lastTs);
    const cost = costFor(model, b.usage);
    return { model, modelLabel: modelLabel(model), tool: b.tool, doc: b.doc, parcel: b.parcel, deliverable: b.deliverable, activeMs, activeLabel: activeLabel(activeMs), costUSD: cost, costLabel: formatUSD(cost) };
  });
}

// Merge already-live-adjusted row arrays (one per overflow agent) by model so
// working agents' live `now - lastTs` deltas are preserved in the aggregate.
function mergeRows(rowArrays) {
  const byModel = {};
  for (const rows of rowArrays) {
    for (const r of rows) {
      const cur = byModel[r.model] ?? { model: r.model, modelLabel: r.modelLabel, tool: 0, doc: 0, parcel: 0, deliverable: 0, activeMs: 0, costUSD: 0 };
      cur.tool += r.tool; cur.doc += r.doc; cur.parcel += r.parcel; cur.deliverable += r.deliverable; cur.activeMs += r.activeMs; cur.costUSD += r.costUSD || 0;
      byModel[r.model] = cur;
    }
  }
  return Object.keys(byModel).sort().map((m) => {
    const c = byModel[m];
    return { ...c, activeLabel: activeLabel(c.activeMs), costLabel: formatUSD(c.costUSD) };
  });
}

export function buildStatsView(stats, { order = [], overflow = [], now = 0 } = {}) {
  // `order` / `overflow` are session ids; the display name is read off the
  // entry, since two sessions can share a name.
  const agents = order
    .filter((session) => stats.bySession[session])
    .map((session) => ({ session, name: stats.bySession[session].name, status: stats.bySession[session].status, rows: rowsFor(stats.bySession[session], now) }));

  const overflowStates = overflow.map((s) => stats.bySession[s]).filter(Boolean);
  const overflowRows = overflowStates.length ? mergeRows(overflowStates.map((st) => rowsFor(st, now))) : [];

  const o = overallByModel(stats);
  const totalCost = Object.entries(o).reduce((sum, [m, b]) => sum + costFor(m, b.usage), 0);
  const totals = Object.entries(o)
    .map(([model, b]) => ({ model, modelLabel: modelLabel(model), n: b.tool + b.doc + b.parcel + b.deliverable }))
    .filter((t) => t.n > 0);
  const grand = totals.reduce((n, t) => n + t.n, 0);
  const overall = grand === 0 ? [] : totals
    .map((t) => ({ model: t.model, modelLabel: t.modelLabel, pct: Math.round((t.n / grand) * 100), costLabel: formatUSD(costFor(t.model, o[t.model].usage)) }))
    .sort((a, b) => b.pct - a.pct);

  return { agents, overflowCount: overflow.length, overflowRows, overall, totalCostLabel: formatUSD(totalCost) };
}
