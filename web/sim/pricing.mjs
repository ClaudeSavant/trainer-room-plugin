// USD per 1M tokens. Source: claude-api reference, cached 2026-06-04.
// Single edit point — update here when prices change.
const RATES = {
  'claude-opus-4-8':   { in: 5,  out: 25 },
  'claude-opus-4-7':   { in: 5,  out: 25 },
  'claude-opus-4-6':   { in: 5,  out: 25 },
  'claude-sonnet-4-6': { in: 3,  out: 15 },
  'claude-fable-5':    { in: 10, out: 50 },
};

function rate(model) {
  if (RATES[model]) return RATES[model];
  if (typeof model !== 'string') return null;
  if (model.startsWith('claude-haiku-4-5')) return { in: 1, out: 5 };
  if (model.startsWith('claude-opus-4'))    return { in: 5, out: 25 };
  if (model.startsWith('claude-sonnet-4'))  return { in: 3, out: 15 };
  return null; // unknown / 'unknown' -> no cost estimate
}

const M = 1_000_000;

export function costFor(model, usage) {
  const r = rate(model);
  if (!r || !usage) return 0;
  return (
    (usage.in || 0)        * r.in  / M +
    (usage.out || 0)       * r.out / M +
    (usage.cacheRead || 0) * r.in * 0.1  / M +
    (usage.cc5m || 0)      * r.in * 1.25 / M +
    (usage.cc1h || 0)      * r.in * 2    / M
  );
}
