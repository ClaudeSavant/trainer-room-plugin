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
    // A Task subagent's hooks carry its PARENT's session_id, so without this
    // its worktree or scratch-dir cwd would drag the parent between rooms.
    // Stamped only when true, like projectLabel. agent_id, not agent_type:
    // agent_type is also set on a MAIN session started with `claude --agent`.
    ...(payload.agent_id ? { sub: true } : {}),
    tokens: id.tokens,
    turnId: id.turnId,
    // Only on SessionStart: the client caches it against the room key, which is
    // the project root path. basename(project) names the root, not whatever
    // subfolder the session happened to start in. NO_PROJECT is excluded
    // because it is a SHARED room (sessions at / or $HOME), and a label would
    // flip to whichever of them started last.
    ...(payload.hook_event_name === 'SessionStart' && project !== NO_PROJECT
      ? { projectLabel: basename(project) } : {}),
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
