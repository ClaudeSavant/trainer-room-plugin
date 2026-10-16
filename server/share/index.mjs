// The share controller: owns share.json, the per-project counts and the relay
// publisher, and gives the console's /share commands their meaning (spec §3).
import { existsSync } from 'node:fs';
import { loadState, saveState, roomIdFor, resetInvite, DEFAULT_STATE_PATH } from './state.mjs';
import { registration } from './identity.mjs';
import { createCounts } from './counts.mjs';
import { createPublisher } from './publisher.mjs';
import { cleanName } from '../../relay/validate.mjs';

export const DEFAULT_RELAY = 'https://trainer-room-relay.fly.dev';
export const NAME_USAGE = 'Usage: /share on <display name> (1 to 32 characters).';
export const STOPPED = 'Sharing is stopped: the saved display name is not valid. Use /share on <display name>.';
const USAGE = 'Usage: /share on <name> | off | public on|off | reset-link';

export function createShare({
  statePath = DEFAULT_STATE_PATH, relayUrl = DEFAULT_RELAY, publisherOpts = {}, reapEveryMs = 30_000,
} = {}) {
  let state = loadState(statePath);
  const counts = createCounts();
  const pub = createPublisher({ relayUrl, ...publisherOpts });
  // Saving is best-effort: an unwritable share.json must never take the bridge
  // (and the local live view) down. One warning, never the contents.
  let warned = false;
  const trySave = (next) => {
    try { saveState(statePath, next); return null; }
    catch (err) {
      if (!warned) { warned = true; console.warn(`[share] could not save ${statePath}: ${err.code ?? err.name}`); }
      return err.code ?? err.name ?? 'error';
    }
  };
  const persist = () => trySave(state);
  const inviteUrl = () => new URL(`/l/${state.inviteToken}`, relayUrl).href;

  // An existing file is rewritten at once: repairs garbled fields and a loose
  // mode. A missing file stays missing until sharing is turned on (or a
  // setting changes), so a bridge that never shares never writes secrets.
  if (existsSync(statePath)) persist();   // best-effort

  // Room ids are created (and saved) only while sharing.
  function rooms() {
    const out = [];
    for (const { projectKey, n } of counts.totals()) {
      const r = roomIdFor(state, projectKey);
      if (r.state !== state) { state = r.state; persist(); }
      out.push({ room: r.id, n });
    }
    return out;
  }
  function publish() { if (state.enabled) pub.setRooms(rooms()); }
  // Registers with the cleaned name; an invalid saved name publishes nothing.
  function go() {
    const name = cleanName(state.name);
    if (!name) return false;
    pub.start(registration({ ...state, name }));
    publish();
    return true;
  }

  function status() {
    const relay = pub.status();
    return {
      enabled: state.enabled,
      public: state.public,
      name: state.name,
      inviteUrl: state.enabled ? inviteUrl() : null,
      relay: relay.state,   // 'off' while enabled means "not actually publishing"
      error: relay.error,
    };
  }
  const reply = (ok, lines) => ({ ok, lines, status: status() });

  if (state.enabled) go();
  const reaper = setInterval(() => { try { counts.reap(Date.now()); publish(); } catch { /* best-effort */ } }, reapEveryMs);
  reaper.unref?.();

  return {
    onEvent(ev) {
      try { counts.apply(ev); publish(); }
      catch (err) { if (!warned) { warned = true; console.warn(`[share] event handling failed: ${err.name}`); } }
    },

    status,

    async command(cmd = {}) {
      const { action } = cmd;
      if (action === 'status') {
        if (!state.enabled) return reply(true, ['Sharing is off. Start with /share on <display name>.']);
        const s = status();
        return reply(true, [
          `Sharing on as "${s.name}" (${s.public ? 'public' : 'invite only'}) · relay: ${s.relay}${s.error ? ` (${s.error})` : ''}`,
          `Invite link: ${s.inviteUrl}`,
        ]);
      }
      if (action === 'on') {
        const given = typeof cmd.name === 'string' && cmd.name.trim() !== '';
        const name = given ? cleanName(cmd.name) : cleanName(state.name);
        if (!name) return reply(false, [NAME_USAGE]);
        const next = { ...state, name, enabled: true };
        const bad = trySave(next);
        if (bad) return reply(false, [`Could not save sharing settings (${bad}). Sharing stays off.`]);
        state = next;
        go();
        return reply(true, [
          `Sharing on as "${name}". Only room counts leave this machine.`,
          `Invite link: ${inviteUrl()}`,
        ]);
      }
      if (action === 'off') {
        state = { ...state, enabled: false };
        const bad = persist();
        await pub.stop();
        return reply(true, [
          'Sharing off. Your invite link no longer shows your lab.',
          ...(bad ? [`Warning: could not save the setting (${bad}); sharing may resume on restart.`] : []),
        ]);
      }
      if (action === 'public') {
        if (typeof cmd.value !== 'boolean') return reply(false, ['Usage: /share public on|off']);
        const next = { ...state, public: cmd.value };
        const bad = trySave(next);
        if (bad) return reply(false, [`Could not save sharing settings (${bad}).`]);
        state = next;
        if (state.enabled && !go()) return reply(false, ['Saved, but ' + STOPPED]);
        return reply(true, [cmd.value
          ? 'Your lab is listed in the public directory.'
          : 'Your lab is unlisted. The invite link still works.']);
      }
      if (action === 'reset-link') {
        const next = resetInvite(state);
        const bad = trySave(next);
        if (bad) return reply(false, [`Could not save sharing settings (${bad}). The old link still works.`]);
        state = next;
        if (state.enabled && !go()) return reply(false, ['Saved, but ' + STOPPED]);
        return reply(true, state.enabled
          ? [`New invite link: ${inviteUrl()}`, 'The old link no longer works.']
          : ['New invite link created. It goes live with /share on.']);
      }
      return reply(false, [USAGE]);
    },

    close() {
      clearInterval(reaper);
      pub.halt();
    },
  };
}
