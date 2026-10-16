// ~/.trainer-room/share.json (spec §3): every secret the bridge generated, plus
// the per-project random room ids. Mode 0600; the relay never sees this file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isToken } from '../../relay/validate.mjs';
import { writePrivateJson } from '../private-json.mjs';

export const DEFAULT_STATE_PATH = join(homedir(), '.trainer-room', 'share.json');

// Own data property even for keys like '__proto__' (plain assignment would hit the setter).
function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

export function newToken() {
  return randomBytes(16).toString('base64url');
}

// Keeps every valid field and regenerates anything missing, garbled or
// duplicated, so a hand-edited file can never stop the bridge or send the
// relay a body it must reject. Secrets are mutually distinct, and a room id
// (which the relay publishes) never repeats another room id or any secret.
export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const used = new Set();
  const pick = (v) => {
    let t = isToken(v) && !used.has(v) ? v : newToken();
    while (used.has(t)) t = newToken();
    used.add(t);
    return t;
  };
  const labId = pick(s.labId);
  const ownerKey = pick(s.ownerKey);
  const inviteToken = pick(s.inviteToken);
  const publicId = pick(s.publicId);
  const roomIds = {};
  if (s.roomIds && typeof s.roomIds === 'object' && !Array.isArray(s.roomIds)) {
    for (const [key, id] of Object.entries(s.roomIds)) if (isToken(id)) setOwn(roomIds, key, pick(id));
  }
  return {
    labId,
    ownerKey,
    inviteToken,
    publicId,
    name: typeof s.name === 'string' ? s.name : '',
    public: s.public === true,
    enabled: s.enabled === true,
    roomIds,
  };
}

export function loadState(path) {
  try { return normalizeState(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return normalizeState(null); }
}

// Write-then-rename so a crash never leaves half a file, and the renamed file
// carries the temp file's 0600 even when an older 0644 file was there.
export function saveState(path, state) {
  writePrivateJson(path, state);
}

// Random, generated once per project key, never derived from it (spec §2).
export function roomIdFor(state, projectKey) {
  if (Object.hasOwn(state.roomIds, projectKey)) return { state, id: state.roomIds[projectKey] };
  const id = newToken();
  const roomIds = { ...state.roomIds };
  setOwn(roomIds, projectKey, id);
  return { state: { ...state, roomIds }, id };
}

export function resetInvite(state) {
  return { ...state, inviteToken: newToken() };
}
