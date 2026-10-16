// The relay's public directory, fetched by the bridge for the page (spec §5
// "Browse public"). Re-validated and size-capped like watch frames.
import { isToken, cleanName, LIMITS } from '../../relay/validate.mjs';

export const MAX_DIRECTORY = 200;
export const MAX_DIRECTORY_BYTES = 256 * 1024;
export const DIRECTORY_TTL_MS = 10_000;
export const DIRECTORY_TIMEOUT_MS = 10_000;

const intIn = (v, max) => (Number.isInteger(v) ? Math.max(0, Math.min(max, v)) : 0);

export function sanitizeDirectory(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (out.length >= MAX_DIRECTORY) break;
    if (!e || typeof e !== 'object' || !isToken(e.publicId) || seen.has(e.publicId)) continue;
    const name = cleanName(e.name);
    if (!name) continue;
    seen.add(e.publicId);
    out.push({
      name,
      publicId: e.publicId,
      rooms: intIn(e.rooms, LIMITS.maxRooms),
      agents: intIn(e.agents, LIMITS.maxRooms * LIMITS.maxN),
      online: e.online === true,
    });
  }
  return out;
}

export async function readCapped(res, max) {
  const dec = new TextDecoder();
  let text = '';
  for await (const chunk of res.body ?? []) {
    text += dec.decode(chunk, { stream: true });
    if (text.length > max) {
      try { await res.body.cancel(); } catch { /* already closed */ }
      throw new Error('response too large');
    }
  }
  return text + dec.decode();
}

export function createDirectory({
  relayUrl, fetchImpl = globalThis.fetch, now = Date.now,
  ttlMs = DIRECTORY_TTL_MS, timeoutMs = DIRECTORY_TIMEOUT_MS,
}) {
  let cache = null;      // { at, list }
  let inflight = null;   // one request at a time, however many pages ask
  return function get() {
    if (cache && now() - cache.at < ttlMs) return Promise.resolve(cache.list);
    if (inflight) return inflight;
    inflight = (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(new URL('/directory', relayUrl).href, { signal: ac.signal, redirect: 'error' });
        if (!res.ok) return null;
        const list = sanitizeDirectory(JSON.parse(await readCapped(res, MAX_DIRECTORY_BYTES)));
        if (list) cache = { at: now(), list };
        return list;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  };
}
