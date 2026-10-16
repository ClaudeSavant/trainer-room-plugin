// The page's only route to other labs: its own bridge (spec §5). Every answer
// is normalized so callers can print `lines` straight into the console.
const REOPEN_MIN_MS = 5000;
const REOPEN_MAX_MS = 30000;

export function createLabsClient({
  fetchImpl = (...a) => fetch(...a),
  EventSourceImpl = globalThis.EventSource,
  setT = (fn, ms) => setTimeout(fn, ms),
  clearT = (id) => clearTimeout(id),
} = {}) {
  async function post(body) {
    try {
      const r = await fetchImpl('/api/labs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const b = await r.json().catch(() => ({}));
      return {
        ok: r.ok && b.ok !== false,
        lines: Array.isArray(b.lines) ? b.lines.map(String) : [`Lab request failed (HTTP ${r.status}).`],
        labs: Array.isArray(b.labs) ? b.labs : null,
        entry: b.entry && typeof b.entry === 'object' ? b.entry : null,
      };
    } catch {
      return { ok: false, lines: ['Could not reach the bridge.'], labs: null, entry: null };
    }
  }
  async function getList(url) {
    try {
      const r = await fetchImpl(url);
      if (!r.ok) return null;
      const b = await r.json();
      return Array.isArray(b.labs) ? b.labs : null;
    } catch {
      return null;
    }
  }
  return {
    list: () => getList('/api/labs'),
    add: (link) => post({ action: 'add', link }),
    savePublic: (publicId, name) => post({ action: 'save-public', publicId, name }),
    remove: (id) => post({ action: 'remove', id }),
    directory: () => getList('/api/labs/directory'),
    // Any error means the page can't see the lab right now. CONNECTING: the
    // browser retries by itself (bridge restart). CLOSED: the bridge refused
    // (lab removed, too many open), so reopen after a capped backoff.
    watch(query, onState) {
      let es = null;
      let timer = null;
      let stopped = false;
      let delay = REOPEN_MIN_MS;
      const open = () => {
        timer = null;
        if (stopped) return;
        const cur = new EventSourceImpl(`/api/labs/watch?${query}`);
        es = cur;
        cur.onopen = () => { delay = REOPEN_MIN_MS; };
        cur.onmessage = (m) => {
          if (stopped) return;
          let state;
          try { state = JSON.parse(m.data); } catch { return; }
          onState(state);
        };
        cur.onerror = () => {
          if (stopped || cur !== es) return;
          onState({ unreachable: true });
          if (cur.readyState === 2) {
            cur.close();
            es = null;
            timer = setT(open, delay);
            delay = Math.min(delay * 2, REOPEN_MAX_MS);
          }
        };
      };
      open();
      return () => {
        if (stopped) return;
        stopped = true;
        if (timer != null) { clearT(timer); timer = null; }
        es?.close();
        es = null;
      };
    },
  };
}
