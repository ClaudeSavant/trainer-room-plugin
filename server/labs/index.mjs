// The labs controller (sharing spec §5, in-app): saved labs, the commands that
// change them, the public directory, and visit streams with a cap.
import { isToken } from '../../relay/validate.mjs';
import {
  loadLabs, saveLabs, parseLink, addLab, removeLab, renameLab, publicView, labLabel, DEFAULT_LABS_PATH,
} from './saved.mjs';
import { watchLab } from './watch.mjs';
import { createDirectory } from './directory.mjs';
import { DEFAULT_RELAY } from '../share/index.mjs';

export const MAX_STREAMS = 4;
export const LABS_USAGE = 'Usage: /lab add <invite link> | /lab <n> | /lab mine | /lab remove <n> | /lab browse';

export function createLabs({
  statePath = DEFAULT_LABS_PATH, relayUrl = DEFAULT_RELAY, fetchImpl = globalThis.fetch,
  watchOpts = {}, directoryOpts = {}, maxStreams = MAX_STREAMS,
} = {}) {
  let state = loadLabs(statePath);
  const directory = createDirectory({ relayUrl, fetchImpl, ...directoryOpts });
  const handles = new Set();
  let warned = false;
  const trySave = (next) => {
    try { saveLabs(statePath, next); return null; }
    catch (err) {
      if (!warned) { warned = true; console.warn(`[labs] could not save ${statePath}: ${err.code ?? err.name}`); }
      return err.code ?? err.name ?? 'error';
    }
  };
  const viewOf = (entry) => publicView({ labs: [entry] })[0];
  const labelOf = (entry) => labLabel(entry, state.labs.findIndex((e) => e.id === entry.id));
  const reply = (ok, lines, entry) => ({ ok, lines, labs: publicView(state), ...(entry ? { entry: viewOf(entry) } : {}) });

  function save(kind, token, name) {
    const r = addLab(state, { kind, token, name });
    if (r.error) return reply(false, [r.error]);
    if (!r.added) return reply(true, [`Already saved as "${labelOf(r.entry)}".`], r.entry);
    const bad = trySave(r.state);
    if (bad) return reply(false, [`Could not save the lab (${bad}).`]);
    state = r.state;
    const label = labelOf(r.entry);
    return reply(true, [r.entry.name ? `Saved "${label}".` : `Saved as "${label}". Its name shows once it is live.`], r.entry);
  }

  return {
    list: () => publicView(state),

    command(cmd = {}) {
      if (cmd.action === 'add') {
        const p = parseLink(cmd.link, relayUrl);
        return p.ok ? save(p.kind, p.token, '') : reply(false, [p.error]);
      }
      if (cmd.action === 'save-public') {
        if (!isToken(cmd.publicId)) return reply(false, ['That is not a public lab id.']);
        return save('public', cmd.publicId, typeof cmd.name === 'string' ? cmd.name : '');
      }
      if (cmd.action === 'remove') {
        const entry = state.labs.find((e) => e.id === cmd.id);
        if (!entry) return reply(false, ['That lab is not saved.']);
        const label = labelOf(entry);
        const next = removeLab(state, entry.id);
        const bad = trySave(next);
        if (bad) return reply(false, [`Could not save the change (${bad}).`]);
        state = next;
        return reply(true, [`Removed "${label}".`]);
      }
      return reply(false, [LABS_USAGE]);
    },

    directory: () => directory(),

    watch(target, send) {
      let via;
      let savedId = null;
      if (target && target.id != null) {
        const entry = state.labs.find((e) => e.id === target.id);
        if (!entry) return { error: 404 };
        via = entry.kind === 'invite' ? { invite: entry.token } : { publicId: entry.token };
        savedId = entry.id;
      } else if (target && isToken(target.publicId)) {
        via = { publicId: target.publicId };
      } else {
        return { error: 404 };
      }
      if (handles.size >= maxStreams) return { error: 429 };
      let persisted = false;   // one labs.json write per stream, however often the relay renames
      const stopWatch = watchLab({
        relayUrl, via, fetchImpl, ...watchOpts,
        onView: (v) => {
          if (savedId && v.name) {
            const next = renameLab(state, savedId, v.name);
            if (next !== state) {
              state = next;
              if (!persisted) { persisted = true; trySave(next); }   // best-effort: the name is cosmetic
            }
          }
          send(v);
        },
      });
      const handle = {
        stop() {
          if (!handles.delete(handle)) return;
          stopWatch();
        },
      };
      handles.add(handle);
      return handle;
    },

    openStreams: () => handles.size,

    close() { for (const h of [...handles]) h.stop(); },
  };
}
