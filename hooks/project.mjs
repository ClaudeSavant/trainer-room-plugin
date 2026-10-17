// Room key = the session's CURRENT project root, derived from cwd. It follows
// the session on purpose: a session that cds into another project (or enters a
// worktree) moves to that project's room, instead of staying pinned to the
// folder it was launched from (spec item 9). The key is an absolute path; it is
// never displayed — the page shows the SessionStart-stamped projectLabel and
// the bridge's /api/project info instead.
//
// Root = nearest ancestor of cwd holding a .git (a file in a worktree, so a
// worktree is its own root), never at or above $HOME. No .git: cwd itself.
// / and $HOME are not projects and share one explicit room.
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const NO_PROJECT = '(no project)';

function strip(p) { return typeof p === 'string' ? p.replace(/[\\/]+$/, '') : ''; }

export function projectKey(payload, env = process.env, exists = existsSync) {
  try {
    const home = strip(env?.HOME);
    const cwd = strip(payload?.cwd);
    if (!cwd || cwd === home) return NO_PROJECT;
    for (let d = cwd; d && d !== '/' && d !== home; d = dirname(d)) {
      if (exists(d + '/.git')) return d;
      if (dirname(d) === d) break;
    }
    return cwd;
  } catch {
    return NO_PROJECT;   // hooks never throw
  }
}
