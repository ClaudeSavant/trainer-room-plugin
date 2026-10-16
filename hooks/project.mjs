// Stable per-session room key. Derived from transcript_path, which Claude Code
// places at ~/.claude/projects/<slug-of-launch-cwd>/<session>.jsonl — so it is
// fixed for the session's whole life, unlike cwd, which drifts as the session
// cds or enters a worktree.
//
// The slug is OPAQUE and must never be parsed back into a path: the transform
// maps both '/' and '.' to '-', and directory names contain literal hyphens, so
// '-Users-me-tr--claude-worktrees-console-slice-a' is not recoverable. Use the
// SessionStart-stamped projectLabel for display instead.
export const NO_PROJECT = '(no project)';

const PROJECTS_DIR = '/.claude/projects/';

export function slugFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  const i = transcriptPath.indexOf(PROJECTS_DIR);
  if (i < 0) return null;
  const slug = transcriptPath.slice(i + PROJECTS_DIR.length).split(/[\\/]/)[0];
  return slug || null;
}

// Launching from / or $HOME produces a slug that names nothing useful ('-',
// '-Users-me'), and historically spawned junk rooms like 'unknown' and
// a room named after the user's home folder. Those sessions share one explicit room instead.
function degenerateSlugs(home) {
  const out = new Set(['-']);
  if (typeof home === 'string' && home) out.add(home.replace(/[/.]/g, '-'));
  return out;
}

function strip(p) { return typeof p === 'string' ? p.replace(/[\\/]+$/, '') : ''; }

export function projectKey(payload, env = process.env) {
  try {
    const home = env?.HOME;
    const degenerate = degenerateSlugs(home);
    const slug = slugFromTranscript(payload?.transcript_path);
    if (slug) return degenerate.has(slug) ? NO_PROJECT : slug;
    const cwd = strip(payload?.cwd);
    if (cwd && cwd !== strip(home)) return cwd;
    return NO_PROJECT;
  } catch {
    return NO_PROJECT;   // hooks never throw
  }
}
