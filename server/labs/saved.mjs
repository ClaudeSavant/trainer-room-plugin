// ~/.trainer-room/labs.json (sharing spec §5): labs the owner saved to visit.
// Each holds the relay credential that opens it (an invite token, or a public
// id from the directory) under a local random id; the page only ever sees the
// id. Mode 0600, like share.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isToken, cleanName } from '../../relay/validate.mjs';
import { newToken } from '../share/state.mjs';
import { writePrivateJson } from '../private-json.mjs';

export const DEFAULT_LABS_PATH = join(homedir(), '.trainer-room', 'labs.json');
export const MAX_SAVED = 50;
const KINDS = ['invite', 'public'];
const NOT_A_LINK = 'That is not an invite link. Paste the link that /share prints.';

function freshId(ids) {
  let id = newToken();
  while (ids.has(id)) id = newToken();
  return id;
}

// Keeps every valid entry (first wins on a repeated kind+token), repairs bad or
// repeated ids, and drops the rest, so a hand-edited file can't stop the bridge.
export function normalizeLabs(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.labs) ? raw.labs : [];
  const labs = [];
  const ids = new Set();
  const seen = new Set();
  for (const e of list) {
    if (labs.length >= MAX_SAVED) break;
    if (!e || typeof e !== 'object' || !KINDS.includes(e.kind) || !isToken(e.token)) continue;
    const key = `${e.kind}:${e.token}`;
    if (seen.has(key)) continue;
    const id = isToken(e.id) && !ids.has(e.id) ? e.id : freshId(ids);
    ids.add(id);
    seen.add(key);
    labs.push({ id, kind: e.kind, token: e.token, name: cleanName(e.name) ?? '' });
  }
  return { labs };
}

export function loadLabs(path) {
  try { return normalizeLabs(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return normalizeLabs(null); }
}

export function saveLabs(path, state) {
  writePrivateJson(path, state);
}

// The relay's own /l/<token> link, or the bare token. Only the token is kept:
// the bridge rebuilds the relay URL itself and never requests the pasted one.
export function parseLink(input, relayUrl) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (isToken(s)) return { ok: true, kind: 'invite', token: s };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: NOT_A_LINK }; }
  const relay = new URL(relayUrl);
  if (u.origin !== relay.origin) {
    return { ok: false, error: `That link is not from this Trainer Room relay (${relay.host}).` };
  }
  const m = /^\/l\/([A-Za-z0-9_-]{22})\/?$/.exec(u.pathname);
  return m ? { ok: true, kind: 'invite', token: m[1] } : { ok: false, error: NOT_A_LINK };
}

export function addLab(state, { kind, token, name = '' }) {
  const hit = state.labs.find((e) => e.kind === kind && e.token === token);
  if (hit) return { state, entry: hit, added: false };
  if (state.labs.length >= MAX_SAVED) {
    return { state, error: `You can save up to ${MAX_SAVED} labs. Remove one first with /lab remove <n>.` };
  }
  const entry = { id: freshId(new Set(state.labs.map((e) => e.id))), kind, token, name: cleanName(name) ?? '' };
  return { state: { labs: [...state.labs, entry] }, entry, added: true };
}

export function removeLab(state, id) {
  const labs = state.labs.filter((e) => e.id !== id);
  return labs.length === state.labs.length ? null : { labs };
}

// The name a lab broadcasts, remembered so the menu can show it while offline.
export function renameLab(state, id, name) {
  const clean = cleanName(name);
  if (!clean) return state;
  let changed = false;
  const labs = state.labs.map((e) => {
    if (e.id !== id || e.name === clean) return e;
    changed = true;
    return { ...e, name: clean };
  });
  return changed ? { labs } : state;
}

export function publicView(state) {
  return state.labs.map((e) => (e.kind === 'public'
    ? { id: e.id, kind: e.kind, name: e.name, publicId: e.token }
    : { id: e.id, kind: e.kind, name: e.name }));
}

export function labLabel(lab, index) {
  return lab.name || `Lab ${index + 1}`;
}
