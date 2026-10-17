// Which room an event belongs to. Single source of truth so the coordinator and
// any tests agree. Kept trivial + pure on purpose.
export function roomKey(ev) {
  return (ev && ev.project) || 'unknown';
}

// Display name for a room key (an absolute project-root path): its basename.
export function projectLabel(key) {
  if (!key || key === 'unknown') return 'unknown';
  const p = String(key).replace(/[\\/]+$/, '').split(/[\\/]/);
  return p[p.length - 1] || 'unknown';
}

// Which room keys to render for the current view mode. 'all' => every room;
// a project key => just that one; a selected-but-gone key => fall back to all.
export function visibleRooms(viewMode, keys) {
  if (viewMode !== 'all' && keys.includes(viewMode)) return [viewMode];
  return keys.slice();
}

// Rooms whose agent count has dropped to 0 (every session for that project
// has ended) should be removed entirely, not just hidden.
export function emptyRoomKeys(counts) {
  return Object.keys(counts).filter((k) => counts[k] === 0);
}

// Pure seq-dedupe step against the server's monotonic seq. Returns whether the
// event should be applied and the next lastSeq. Events without a numeric seq
// always apply and leave lastSeq untouched.
export function applySeq(lastSeq, ev) {
  if (typeof ev.seq !== 'number') return { apply: true, lastSeq };
  if (ev.seq <= lastSeq) return { apply: false, lastSeq };
  return { apply: true, lastSeq: ev.seq };
}

// An absolute path token: '~/…', or '/seg/…' with at least two segments. The
// lookbehind-ish prefix group rejects anything glued to a word, ':' or '/', so
// 'https://host/a' and relative 'web/main.mjs' never match. '=' is allowed as a
// prefix for '--flag=/abs/path'.
const ABS_PATH_RE = /(^|[^\w:/.~-])(~\/[^\s"'`()<>|;&,]*|\/[^\s"'`()<>|;&,/]+\/[^\s"'`()<>|;&,]*)/g;

// Display-only: the owner does not want file-system paths on the page, so a path
// collapses to its last non-empty segment ('/Users/me/dir/' -> 'dir').
export function shortenPaths(text) {
  if (typeof text !== 'string') return text;
  return text.replace(ABS_PATH_RE, (_m, pre, p) => pre + (p.split('/').filter(Boolean).pop() ?? p));
}

// The single scrub applied to every event before display. Only the two
// human-facing text fields; `path` is data (never rendered) and stays intact.
export function scrubEvent(ev) {
  const out = { ...ev };
  if (typeof ev.summary === 'string') out.summary = shortenPaths(ev.summary);
  if (typeof ev.detail === 'string') out.detail = shortenPaths(ev.detail);
  return out;
}

// Last-resort display label when neither /api/project nor a SessionStart label
// is known. Keys are absolute project-root paths, so this shows only the
// basename, never the path. Old transcript-slug keys start with '-' and must
// never be shown raw. '(no project)' mirrors NO_PROJECT in hooks/project.mjs
// (web cannot import hooks/).
export function fallbackLabel(key) {
  if (key === '(no project)') return key;
  if (typeof key === 'string' && key.startsWith('-')) return '(unknown project)';
  return projectLabel(key);
}

// Whether a trainer seen in a room walks in through the door (true) or is placed
// at its desk (false). Only a genuinely new session walks in: a live SessionStart,
// a live switch from another room, or a live first entry into a room by a session
// already seen with none (`entered`, from createSessionRooms). Anything replayed —
// the reload snapshot, or a visited room's first batch — is placed seated, so a
// reload is no parade.
export function arrivalFor({ fromSnapshot, type, switched, entered = false }) {
  return !fromSnapshot && (type === 'agent_start' || switched === true || entered === true);
}

// Owner ruling "folder after repo": same-repo rooms (worktrees) are told apart
// by appending the folder when it is not just the repo's own name.
export const LABEL_SEP = ' \u00b7 ';
export function displayLabel(info) {
  const repo = info?.repo || '';
  const label = info?.label || '';
  if (!repo) return label;
  const short = repo.split('/').pop();
  if (!label || label.toLowerCase() === short.toLowerCase()) return repo;
  return `${repo}${LABEL_SEP}${label}`;
}
