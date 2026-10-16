// Watching another lab through the relay (sharing spec §5). The bridge holds
// the relay stream and hands the page only re-validated views, so a hostile or
// broken relay can never put raw bytes, odd fields or oversized data in front
// of the owner's page.
import { isToken, cleanName, LIMITS } from '../../relay/validate.mjs';

export const RETRY_MISSING_MS = 15_000;   // same cadence as the hosted viewer
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
export const IDLE_MS = 75_000;            // the relay sends ': ka' every 25 s
export const MAX_FRAME = 16 * 1024;       // a full 64-room view is about 3 KB

export function sanitizeView(v) {
  if (!v || typeof v !== 'object') return null;
  const online = v.online === true;
  const rooms = [];
  if (online && Array.isArray(v.rooms)) {
    for (const r of v.rooms) {
      if (rooms.length >= LIMITS.maxRooms) break;
      if (!r || typeof r !== 'object' || !isToken(r.room) || !Number.isInteger(r.n)) continue;
      const n = Math.max(0, Math.min(LIMITS.maxN, r.n));
      if (n > 0 && !rooms.some((x) => x.room === r.room)) rooms.push({ room: r.room, n });
    }
  }
  const t = typeof v.lastSeen === 'string' ? Date.parse(v.lastSeen) : NaN;
  return {
    name: cleanName(v.name) ?? '',
    online,
    lastSeen: Number.isFinite(t) ? new Date(t).toISOString() : null,
    rooms,
  };
}

// Incremental Server-Sent Events parser: feed text, get each event's data.
// Comments and other fields are ignored.
export function createSseParser(onData, maxFrame = MAX_FRAME) {
  let buf = '';
  return (chunk) => {
    buf += chunk.replace(/\r\n?/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (block.length > maxFrame) throw new Error('frame too large');
      const data = block.split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) onData(data);
    }
    if (buf.length > maxFrame) throw new Error('frame too large');
  };
}

export function watchLab({
  relayUrl, via, onView, fetchImpl = globalThis.fetch,
  timers = { setTimeout, clearTimeout }, retryMissingMs = RETRY_MISSING_MS, idleMs = IDLE_MS,
}) {
  const query = via.invite != null
    ? `invite=${encodeURIComponent(via.invite)}`
    : `public=${encodeURIComponent(via.publicId)}`;
  const url = new URL(`/watch?${query}`, relayUrl).href;
  let stopped = false;
  let ac = null;
  let retryTimer = null;
  let idle = null;   // the current attempt's watchdog (one attempt at a time)
  let backoff = BACKOFF_MIN_MS;

  const clearIdle = () => { if (idle != null) { timers.clearTimeout(idle); idle = null; } };
  const report = (v) => { if (!stopped) onView(v); };
  const later = (ms) => {
    if (stopped) return;
    retryTimer = timers.setTimeout(() => { retryTimer = null; run(); }, ms);
  };
  const retry = () => {
    const ms = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    later(ms);
  };
  const fail = () => { report({ unreachable: true }); retry(); };

  async function run() {
    if (stopped) return;
    const ctl = new AbortController();
    ac = ctl;
    const kick = () => { clearIdle(); idle = timers.setTimeout(() => { idle = null; ctl.abort(); }, idleMs); };
    try {
      kick();
      const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'error', headers: { accept: 'text/event-stream' } });
      if (res.status !== 200 || !res.body) {
        clearIdle();
        try { await res.body?.cancel(); } catch { /* already closed */ }
        if (stopped) return;
        if (res.status === 404) { backoff = BACKOFF_MIN_MS; report({ missing: true }); later(retryMissingMs); }
        else fail();
        return;
      }
      const parse = createSseParser((data) => {
        let v = null;
        try { v = sanitizeView(JSON.parse(data)); } catch { /* skip a bad frame */ }
        if (v) { backoff = BACKOFF_MIN_MS; report(v); }
      });
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        if (stopped) break;
        kick();
        parse(dec.decode(chunk, { stream: true }));
      }
      clearIdle();
      if (!stopped) retry();   // the relay ended the stream (restart, link reset): reconnect quietly
    } catch {
      clearIdle();
      ctl.abort();
      if (!stopped) fail();
    }
  }

  run();
  return () => {
    stopped = true;
    if (retryTimer != null) { timers.clearTimeout(retryTimer); retryTimer = null; }
    clearIdle();
    ac?.abort();
  };
}
