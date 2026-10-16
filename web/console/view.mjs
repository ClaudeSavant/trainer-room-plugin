// Pure view model for the console column, plus a thin DOM writer. Only
// consoleRows/fmtTime are exercised by tests; renderConsole touches the DOM and is
// covered by the screenshot pass instead.

const CLS = {
  chat: 'row-chat',
  user: 'row-user',
  error: 'row-error',
  system: 'row-system',
  activity: 'row-activity',
};

// The console's OWN output — the `> …` echo, parse errors, /help, the chip
// self-clear notice. These live in globalLines alongside agent activity, but
// unlike activity they are about the console itself and must stay on screen
// whatever the console is currently pointed at.
const LOCAL_KINDS = new Set(['user', 'error', 'system']);
const isLocal = (l) => LOCAL_KINDS.has(l.kind);

export function fmtTime(ts) {
  const i = String(ts ?? '').indexOf('T');
  return i >= 0 ? String(ts).slice(i + 1, i + 9) : '';
}

// Every real ts is an ISO-8601 UTC string, so lexicographic order IS chronological
// order; no Date parsing needed (and none wanted — this stays allocation-cheap).
// Anything without the 'T' separator carries no time at all (fixtures/replay.jsonl
// ships ts:"t") and is keyed to '' so it sorts BEFORE dated lines: compared raw, "t"
// would sort after every "2026-…", pushing live console output above the whole feed
// and out of the autoscrolled viewport.
const tsKey = (l) => {
  const s = String(l.ts ?? '');
  return s.includes('T') ? s : '';
};
function byTs(a, b) {
  const x = tsKey(a.line);
  const y = tsKey(b.line);
  return x < y ? -1 : x > y ? 1 : 0;
}

// With no chip the console tails the global stream and prefixes each line with the
// agent that produced it. With a chip the base is that agent's own feed, where the
// interesting prefix is who spoke (`from`), matching the desk-terminal overlay —
// but the console's own output is merged back in by timestamp, because selecting
// the feed wholesale used to swallow it entirely (typing anything while chipped
// looked like the console had died).
//
// Prefix can't be derived from the line alone once the two sources are mixed: a
// feed line and a console-local line can both have kind 'user'. So it's resolved
// per source at selection time and carried through the merge. Console-local lines
// get no prefix — the same way they already render unchipped, where they simply
// have no `agent`.
export function consoleRows({ globalLines = [], feedLines = [], chip = null, cap = 200 } = {}) {
  const src = chip
    ? [
        ...feedLines.map((line) => ({ line, prefix: line.from ?? '' })),
        ...globalLines.filter(isLocal).map((line) => ({ line, prefix: '' })),
      ].sort(byTs)   // stable (ES2019+), so equal timestamps keep feed-before-local order
    : globalLines.map((line) => ({ line, prefix: line.agent ?? '' }));
  // slice(-0) is slice(0) — the whole array — so cap 0 has to be spelled out.
  const win = cap > 0 ? src.slice(-cap) : [];
  return win.map(({ line: l, prefix }) => ({
    id: l.id,
    time: fmtTime(l.ts),
    prefix,
    text: l.detail ?? l.text ?? l.summary ?? '',
    cls: CLS[l.kind] ?? CLS.activity,
    state: l.state ?? null,
  }));
}

// Builds nodes rather than HTML: agent names, project labels and message bodies are
// all untrusted, same rule as room-instance.mjs:127.
function buildRow(row) {
  const el = document.createElement('div');
  // c-row, NOT log-row: log-row is flex-direction:column for the desk terminal's
  // two-line layout, which would stack these spans instead of keeping them inline.
  el.className = `c-row ${row.cls}`;
  if (row.time) {
    const t = document.createElement('span');
    t.className = 'row-time';
    t.textContent = row.time;
    el.appendChild(t);
  }
  if (row.prefix) {
    const p = document.createElement('span');
    p.className = 'row-prefix';
    p.textContent = `${row.prefix} `;
    el.appendChild(p);
  }
  const b = document.createElement('span');
  b.textContent = row.text;
  el.appendChild(b);
  if (row.state) {
    const s = document.createElement('span');
    s.className = `row-state state-${row.state}`;
    s.textContent = { queued: '⧗', delivered: '✓', failed: '✕', sent: '·' }[row.state] ?? '';
    el.appendChild(s);
  }
  return el;
}

export function renderConsole(bodyEl, rows) {
  const atBottom = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 4;
  bodyEl.replaceChildren(...rows.map(buildRow));
  if (atBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
}
