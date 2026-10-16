// Bridge → relay publishing over plain HTTPS POST. Ruling 1: no WebSocket,
// because zero runtime dependencies stays true. It sends only what it is
// handed: the registration body (server/share/identity.mjs) and { room, n } pairs.
export const PUBLISH_DEFAULTS = Object.freeze({
  debounceMs: 2000, heartbeatMs: 30_000, backoffMinMs: 1000, backoffMaxMs: 60_000,
});

// Outgoing bodies are rebuilt from exactly the spec §2 fields, so nothing extra
// a caller hands in can reach the wire.
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const regBody = (r) => pick(r, ['labId', 'ownerKey', 'name', 'public', 'inviteToken', 'publicId']);
const credsBody = (r) => pick(r, ['labId', 'ownerKey']);
const roomsBody = (list) => list.map((r) => ({ room: r.room, n: r.n }));

const REQUEST_TIMEOUT_MS = 10_000;

// Statuses retrying cannot fix: bad body, wrong owner key, a taken invite or
// public id, an oversized message.
const PERMANENT = new Set([400, 403, 409, 413]);

export function createPublisher({ relayUrl, fetchImpl = globalThis.fetch, ...opts } = {}) {
  const { debounceMs, heartbeatMs, backoffMinMs, backoffMaxMs } = { ...PUBLISH_DEFAULTS, ...opts };
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let reg = null;              // registration body
  let rooms = [];              // latest counts to publish
  let roomsKey = '[]';
  let sentKey = null;          // JSON of the rooms the relay last accepted
  let lastSentAt = -Infinity;  // last accepted update or heartbeat
  let registered = false;
  let running = false;
  let gen = 0;                 // bumped by start/stop/halt so a stale in-flight step stands down
  let timer = null;
  let inFlight = false;
  let again = false;           // a step was requested while one was in flight
  let backoff = backoffMinMs;
  let rereg404 = false;        // already re-registered once after a 404 and not yet healthy
  let state = 'off';
  let error = null;

  const creds = () => credsBody(reg);
  const setState = (s, e = null) => { state = s; error = e; };

  async function post(path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    t.unref?.();
    try {
      const res = await fetchImpl(new URL(path, relayUrl), {
        method: 'POST',
        redirect: 'error',   // never replay the owner key somewhere else
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let data = null;
      try { data = await res.json(); } catch { /* empty or non-JSON body */ }
      return { status: res.status, data };
    } catch (err) {
      throw ctl.signal.aborted ? new Error('relay timeout') : err;
    } finally {
      clearTimeout(t);
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = null;
    if (!running) return;
    timer = setTimeout(step, Math.max(0, ms));
    timer.unref?.();
  }

  // Returns ms until the next step, or null to stop.
  function onFailure(r) {
    // A 429 on an update just waits; on register it backs off like any other
    // retryable failure and says why.
    if (r.status === 429 && registered) return debounceMs;
    registered = false;   // re-register on every reconnect (spec §3)
    if (PERMANENT.has(r.status)) {
      running = false;
      setState('rejected', r.data?.error ?? `HTTP ${r.status}`);
      return null;
    }
    setState('retrying', r.error?.message ?? r.data?.error ?? `HTTP ${r.status}`);
    const wait = backoff;
    backoff = Math.min(backoff * 2, backoffMaxMs);
    return wait;
  }

  // First 404 re-registers at once; a second before any success backs off.
  function onNotFound(r) {
    registered = false;
    if (rereg404) return onFailure(r);
    rereg404 = true;
    return 0;
  }
  function healthy() { rereg404 = false; backoff = backoffMinMs; }

  async function work(myGen) {
    if (!registered) {
      const r = await post('/publish/register', regBody(reg));
      if (myGen !== gen) return 0;
      if (r.status !== 200) return onFailure(r);
      registered = true;
      sentKey = null;   // the relay's copy of our rooms is unknown after a register
      setState('live');
    }
    const since = Date.now() - lastSentAt;
    if (roomsKey !== sentKey) {
      if (since < debounceMs) return debounceMs - since;
      const key = roomsKey;
      const r = await post('/publish/update', { ...creds(), rooms: roomsBody(rooms) });
      if (myGen !== gen) return 0;
      if (r.status === 404) return onNotFound(r);   // relay restarted
      if (r.status !== 200) return onFailure(r);
      healthy();
      sentKey = key;
      lastSentAt = Date.now();
      return roomsKey === sentKey ? heartbeatMs : debounceMs;
    }
    if (since < heartbeatMs) return heartbeatMs - since;
    const r = await post('/publish/heartbeat', creds());
    if (myGen !== gen) return 0;
    if (r.status === 404) return onNotFound(r);
    if (r.status !== 200) return onFailure(r);
    healthy();
    lastSentAt = Date.now();
    if (r.data?.resend) { sentKey = null; return debounceMs; }   // we were marked offline
    return heartbeatMs;
  }

  async function step() {
    timer = null;
    if (!running) return;
    if (inFlight) { again = true; return; }
    inFlight = true;
    again = false;
    const myGen = gen;
    let next;
    try { next = await work(myGen); }
    catch (err) { next = myGen === gen ? onFailure({ status: 0, error: err }) : 0; }
    finally { inFlight = false; }
    if (again || myGen !== gen) next = 0;
    if (next != null) schedule(next);
  }

  return {
    start(registrationBody) {
      reg = registrationBody;
      gen++;
      running = true;
      registered = false;
      rereg404 = false;
      backoff = backoffMinMs;
      setState('connecting');
      schedule(0);
    },

    setRooms(next) {
      const key = JSON.stringify(next);
      if (key === roomsKey) return;
      rooms = next;
      roomsKey = key;
      // While retrying, the backoff timer owns the next attempt.
      if (running && state === 'live') schedule(0);
    },

    async stop() {
      const hadReg = reg;
      running = false;
      gen++;
      registered = false;
      clearTimeout(timer);
      timer = null;
      setState('off');
      if (!hadReg) return;
      try { await post('/publish/close', credsBody(hadReg)); }
      catch { /* unreachable relay: it marks the lab offline after 90 s anyway */ }
    },

    halt() {
      running = false;
      gen++;
      clearTimeout(timer);
      timer = null;
      setState('off');
    },

    status() { return { state, error }; },
  };
}
