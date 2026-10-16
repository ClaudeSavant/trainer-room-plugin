// Every limit the relay enforces (spec §4), in one place. Pure: no I/O.
export const LIMITS = Object.freeze({
  maxRooms: 64,
  maxN: 99,
  minUpdateGapMs: 1000,
  maxBodyBytes: 4096,
  nameMax: 32,
  offlineMs: 90 * 1000,
  dropMs: 24 * 60 * 60 * 1000,
  // The spec asks for these caps without numbers; these are the plan's picks.
  maxConnPerIp: 16,
  maxWatchersPerLab: 100,
  maxLabs: 5000,
  // A lab that registered but never got an update or heartbeat through is junk
  // after this long offline (spec: real bridges send one within seconds).
  unconfirmedDropMs: 10 * 60 * 1000,
});

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;   // 128 bits, base64url, no padding

export function isToken(v) {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

// C0/C1 controls, DEL, soft hyphen, zero-width and bidi controls (incl. U+061C),
// line/paragraph separators, BOM and the tag characters. Markup is NOT touched:
// a name is plain text and every renderer writes it with textContent.
const STRIP_RE = /[\p{Cc}\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

export function cleanName(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(STRIP_RE, '').trim();
  const len = [...s].length;
  return len >= 1 && len <= LIMITS.nameMax ? s : null;
}

export function hasOnlyKeys(obj, allowed) {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

// Validated copy of a rooms list, with empty rooms dropped, or null when any
// entry breaks a rule. Strict on shape so nothing but { room, n } is stored.
export function cleanRooms(v, limits = LIMITS) {
  if (!Array.isArray(v) || v.length > limits.maxRooms) return null;
  const seen = new Set();
  const out = [];
  for (const r of v) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    if (!hasOnlyKeys(r, ['room', 'n'])) return null;
    if (!isToken(r.room) || seen.has(r.room)) return null;
    if (!Number.isInteger(r.n) || r.n < 0 || r.n > limits.maxN) return null;
    seen.add(r.room);
    if (r.n > 0) out.push({ room: r.room, n: r.n });
  }
  return out;
}
