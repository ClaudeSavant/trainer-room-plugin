// Resolves a room key (an absolute project-root path from hooks/project.mjs, or
// a legacy opaque transcript slug) to what
// the page shows about a project: GitHub owner/repo, a folder label, a one-line
// goal and the README text. Local disk only, no network. The slug is never
// unslugified; the launch folder comes from the session transcript itself.
// Path keys are only honoured under the home dir (isProjectPath).
// Nothing returned contains a file-system path.
import { readdirSync, statSync, lstatSync, readFileSync, existsSync, openSync, readSync, closeSync, constants as fsc } from 'node:fs';
import { join, dirname, basename, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README'];
const README_CAP = 200 * 1024;
const HEAD_BYTES = 64 * 1024;
const MAX_TRANSCRIPTS = 5;
const GOAL_CAP = 160;
const PARA_CAP = 2000;

export function isSlug(key) {
  return typeof key === 'string' && SLUG_RE.test(key) && key !== '.' && key !== '..';
}

// A room key from the hook: an absolute project-root path under the user's home
// that exists as a directory. Normalised (no '..', no trailing slash) so a key
// can never reach outside home, and home itself is not a project.
export function isProjectPath(key, homeDir = homedir()) {
  if (typeof key !== 'string' || !key || !isAbsolute(key) || resolve(key) !== key) return false;
  const home = trimSlash(homeDir);
  if (!key.startsWith(home + '/')) return false;
  try { return statSync(key).isDirectory(); } catch { return false; }
}

function readHead(path, bytes, flags = 'r') {
  const fd = openSync(path, flags);
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally { closeSync(fd); }
}

// Claude Code names the transcript dir by replacing every non [A-Za-z0-9-]
// char of the launch dir with '-'. That is lossy, so it is only ever used as a
// comparison (cwd -> slug), never reversed.
const slugOf = (cwd) => cwd.replace(/[^A-Za-z0-9-]/g, '-');
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);

// The launch dir is the cwd whose slug equals the key. The first cwd is usually
// it, but a session started elsewhere (e.g. at /) and then moved drifts, so
// prefer a slug match across the newest few transcript heads, and fall back to
// the first cwd seen only if none matches.
function launchCwd(slugDir, key) {
  const files = readdirSync(slugDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: statSync(join(slugDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, MAX_TRANSCRIPTS);
  let first = null;
  for (const { f } of files) {
    for (const line of readHead(join(slugDir, f), HEAD_BYTES).split('\n')) {
      try {
        const obj = JSON.parse(line);
        if (!obj || typeof obj.cwd !== 'string' || !obj.cwd) continue;
        if (slugOf(obj.cwd) === key) return obj.cwd;
        first ??= obj.cwd;
      } catch { /* partial or non-JSON line */ }
    }
  }
  return first;
}

// Walks up to the nearest .git, but never past or onto the home dir or /.
function gitRoot(dir, home) {
  for (let d = dir; ; d = dirname(d)) {
    if (d === home || dirname(d) === d) return null;
    if (existsSync(join(d, '.git'))) return d;
  }
}

// .git dir -> its config. .git FILE (worktree) -> gitdir, then commondir -> config.
function gitConfigPath(root) {
  const g = join(root, '.git');
  if (statSync(g).isDirectory()) return join(g, 'config');
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'));
  if (!m) return null;
  const gitdir = resolve(root, m[1].trim());
  const commondirFile = join(gitdir, 'commondir');
  const common = existsSync(commondirFile) ? resolve(gitdir, readFileSync(commondirFile, 'utf8').trim()) : gitdir;
  return join(common, 'config');
}

export function repoFromUrl(url) {
  const m = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/]+\/|[^@\s/]+@[^:\s/]+:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url).trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function parseOriginRepo(text) {
  let inOrigin = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]$/.test(line); continue; }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.+)$/.exec(line);
    if (m) return repoFromUrl(m[1]);
  }
  return null;
}

// Bounded classes (as in web/console/markdown.mjs): unbounded [^\]]* / [^)]*
// backtrack quadratically on runs of '[' or '[x](' and stall the bridge.
function stripInline(s) {
  return s
    .replace(/!\[[^\]]{0,200}\]\([^)]{0,500}\)/g, '')
    .replace(/\[([^\]]{0,200})\]\([^)]{0,500}\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// First prose paragraph: skips front matter, headings (ATX and setext), badge /
// image / HTML lines, rules, list items, tables and fenced code.
export function goalFrom(md) {
  if (typeof md !== 'string' || !md) return null;
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === '---');
    i = end > 0 ? end + 1 : 0;
  }
  let para = [];
  let paraLen = 0;
  let inFence = false;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(```|~~~)/.test(t)) { if (para.length) break; inFence = !inFence; continue; }
    if (inFence) continue;
    if (!t) { if (para.length) break; continue; }
    if (/^(=+|-+)$/.test(t) && para.length) { para = []; paraLen = 0; continue; }   // setext heading underline
    const skip = /^#{1,6}(\s|$)/.test(t) || /^(!\[|\[!\[|<)/.test(t) || /^([-*_]\s*){3,}$/.test(t)
      || /^([-*+]|\d+[.)])\s/.test(t) || t.startsWith('|');
    if (skip) { if (para.length) break; continue; }
    para.push(t.replace(/^>\s?/, ''));
    paraLen += t.length;
    if (paraLen > PARA_CAP) break;
  }
  // The goal is capped at GOAL_CAP anyway; bounding the input bounds the work.
  const text = stripInline(para.join(' ').slice(0, PARA_CAP));
  if (!text) return null;
  return text.length > GOAL_CAP ? text.slice(0, GOAL_CAP - 1).trimEnd() + '…' : text;
}

function findReadme(dir) {
  for (const n of README_NAMES) {
    const p = join(dir, n);
    // lstat: a README symlink (e.g. -> ~/.ssh/id_ed25519) is rejected outright.
    try { if (lstatSync(p).isFile()) return p; } catch { /* absent */ }
  }
  return null;
}

export function resolveProjectInfo(key, { projectsDir = DEFAULT_PROJECTS_DIR, home = homedir(), homeDir: homeOpt = home } = {}) {
  const homeDir = trimSlash(homeOpt);
  let raw;
  if (isProjectPath(key, homeDir)) {
    raw = key;                       // path key: the key is the project root
  } else {
    if (!isSlug(key)) return null;
    const slugDir = join(projectsDir, key);
    try { if (!statSync(slugDir).isDirectory()) return null; } catch { return null; }
    raw = launchCwd(slugDir, key);
  }
  if (!raw) return null;
  const cwd = trimSlash(raw);
  // / or the home dir is not a project: no label worth showing.
  if (cwd === '/' || cwd === homeDir) return null;
  // A deleted/moved launch folder must not walk up into some parent repo.
  if (!existsSync(cwd)) return basename(cwd) ? { repo: null, label: basename(cwd), goal: null, readme: null } : null;
  const root = gitRoot(cwd, homeDir);
  const base = root ?? cwd;
  let repo = null;
  if (root) {
    try {
      const cfg = gitConfigPath(root);
      if (cfg) repo = parseOriginRepo(readFileSync(cfg, 'utf8'));
    } catch { /* unreadable git metadata: label only */ }
  }
  const readmePath = findReadme(base);
  // O_NOFOLLOW: a README swapped for a symlink after the lstat fails to open.
  let readme = null;
  if (readmePath) {
    try { readme = readHead(readmePath, README_CAP, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0)); } catch { /* raced away */ }
  }
  const label = basename(base);
  if (!label) return null;
  return { repo, label, goal: readme ? goalFrom(readme) : null, readme };
}
