import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname } from 'node:path';
import { classify } from './classify.mjs';
import { resolveIdentity, readTranscriptTail } from './identity.mjs';
import { projectKey, NO_PROJECT } from './project.mjs';
import { eventsPathFor } from './paths.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVENTS_PATH = eventsPathFor({ argv: process.argv.slice(2), env: process.env, repoRoot: REPO_ROOT });

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

// Stamped at process start, before any I/O: hooks run async, so this is the
// closest available proxy for when the event happened. Anything later would
// fold emit's own stdin/transcript-read time into the ordering.
const FIRED_AT = new Date().toISOString();

async function main() {
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  const base = classify(payload);
  if (!base) return; // ignored event

  const id = resolveIdentity(payload, readTranscriptTail);
  const project = projectKey(payload);
  const event = {
    ts: FIRED_AT,
    agent: id.agent, team: id.team, session: id.session,
    type: base.type, tool: base.tool, path: base.path, summary: base.summary,
    model: id.model,
    project,
    // Stamped only when resolveIdentity actually knows. An omitted `main` means
    // "no evidence", which the client reads as "leave the session as it was";
    // forcing undefined to false would assert teammate-ness on a failed read.
    ...(id.main !== undefined ? { main: id.main === true } : {}),
    tokens: id.tokens,
    turnId: id.turnId,
    // Only on SessionStart, where cwd still equals the launch dir. The slug is
    // opaque and cannot be unslugified, so this is the one chance to capture a
    // human-readable name; the client caches it against the slug. Guarded on
    // typeof rather than coerced — String() throws on a JSON object with a
    // non-callable toString, and emit swallows everything, so that would drop
    // the whole event rather than just the label.
    //
    // NO_PROJECT is excluded because it is a SHARED room: every session launched
    // from / or $HOME lands in it. hooks/project.mjs collapses those precisely to
    // stop junk rooms named after the home folder or 'scratchpad', and the client
    // caches one label per slug — so labelling it here re-imports the junk names
    // a layer up, and the room's tab flips to whichever degenerate session
    // started last.
    ...(payload.hook_event_name === 'SessionStart' && typeof payload.cwd === 'string' && payload.cwd
      && project !== NO_PROJECT
      ? { projectLabel: basename(payload.cwd) } : {}),
    ...(base.detail !== undefined ? { detail: base.detail } : {}),
    ...(base.to !== undefined ? { to: base.to } : {}),
  };
  // The plugin's home may not exist yet; events hold file names and summaries,
  // so the directory and file are private. Modes only apply on creation.
  mkdirSync(dirname(EVENTS_PATH), { recursive: true, mode: 0o700 });
  appendFileSync(EVENTS_PATH, JSON.stringify(event) + '\n', { mode: 0o600 });
}

// Never block Claude Code: swallow everything, always exit 0.
main().catch(() => {}).finally(() => process.exit(0));
