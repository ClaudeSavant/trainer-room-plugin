// Pure command parsing for the console column. No DOM, no I/O — every branch is
// reachable from node --test.

export function tokenize(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;               // distinguishes "" (a real empty token) from no token
  for (const ch of String(line ?? '')) {
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(ch)) {
      if (has || cur) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Exact (case-insensitive) match wins; otherwise the closest within edit distance 2.
// Returns null when nothing is close enough to be worth suggesting.
function resolve(needle, haystack, keyOf = (x) => x) {
  const lower = String(needle ?? '').toLowerCase();
  if (!lower) return null;
  const exact = haystack.find((h) => keyOf(h).toLowerCase() === lower);
  if (exact) return exact;
  let best = null;
  let bestD = Infinity;
  for (const h of haystack) {
    const d = distance(lower, keyOf(h).toLowerCase());
    if (d < bestD) { bestD = d; best = h; }
  }
  return bestD <= 2 ? best : null;
}

function err(message) { return { kind: 'error', message }; }

// Resolves a typed agent name to its canonical form, or returns an {kind:'error'}
// describing the miss. Split out because /kill and @name need identical behaviour.
function resolveAgent(typed, agents) {
  const hit = resolve(typed, agents);
  if (!hit) return { error: err(`No agent named "${typed}".`) };
  if (hit.toLowerCase() !== String(typed).toLowerCase()) {
    return { error: err(`No agent named "${typed}". Did you mean "${hit}"?`) };
  }
  return { name: hit };
}

// Resolves a typed project label to its project object, or returns an {kind:'error'}
// describing the miss. Split out because /focus and /launch need identical behaviour.
// Labels may be 'owner/repo' or 'owner/repo · folder' (see displayLabel). Exact,
// case-insensitive matches, in priority order: the full label, an alias (the
// folder name), then the bare repo name, preferring a room with no folder
// suffix so '/focus FFA' picks the main checkout over a worktree.
const SEP = ' \u00b7 ';
const baseOf = (label) => { const i = label.indexOf(SEP); return i === -1 ? label : label.slice(0, i); };
const shortOf = (p) => baseOf(p.label).split('/').pop();
const aliasesOf = (p) => (Array.isArray(p.aliases) ? p.aliases.filter((a) => typeof a === 'string' && a) : []);
function resolveProject(typed, projects) {
  const lower = String(typed ?? '').toLowerCase();
  const eq = (s) => s.toLowerCase() === lower;
  const exact = projects.find((p) => eq(p.label))
    ?? projects.find((p) => aliasesOf(p).some(eq))
    ?? projects.find((p) => baseOf(p.label) === p.label && eq(shortOf(p)))
    ?? projects.find((p) => eq(shortOf(p)));
  if (exact) return { project: exact };
  const aliasKey = (p) => aliasesOf(p)[0] ?? p.label;
  const hit = resolve(typed, projects, (p) => p.label) ?? resolve(typed, projects, shortOf) ?? resolve(typed, projects, aliasKey);
  if (!hit) return { error: err(`No project "${typed}". Known: ${projects.map((p) => p.label).join(', ') || '(none yet)'}`) };
  return { error: err(`No project "${typed}". Did you mean "${hit.label}"?`) };
}

function parseLaunch(args, projects) {
  const [target, prompt] = args;
  if (!target) return err('Usage: /launch <project> "<prompt>"');
  const r = resolveProject(target, projects);
  if (r.error) return r.error;
  if (!prompt || !prompt.trim()) return err('Usage: /launch <project> "<prompt>"');
  return { kind: 'launch', project: r.project.key, prompt: prompt.trim() };
}

function parseFocus(args, projects) {
  // /focus takes one project, so unquoted words rejoin: labels like
  // 'owner/repo · folder' contain spaces.
  const target = args.join(' ');
  if (!target) return err('Usage: /focus <project> | /focus all');
  if (target.toLowerCase() === 'all') return { kind: 'view', name: 'focus', arg: 'all' };
  const r = resolveProject(target, projects);
  if (r.error) return r.error;
  return { kind: 'view', name: 'focus', arg: r.project.key };
}

function parseHour(args) {
  if (args.length === 0) return err('Usage: /hour <0-23>');
  const n = Number(args[0]);
  if (!Number.isInteger(n) || n < 0 || n > 23) return err(`"${args[0]}" is not an hour between 0 and 23.`);
  return { kind: 'view', name: 'hour', arg: n };
}

const SHARE_USAGE = 'Usage: /share on <name> | off | public on|off | reset-link';

// /share talks to the bridge, never to an agent, so it parses in every view.
// The name may contain spaces (quoted or not); the bridge applies the 1-32 rule.
function parseShare(args) {
  const [sub, ...rest] = args;
  const s = String(sub ?? '').toLowerCase();
  if (!s) return { kind: 'share', action: 'status' };
  if (s === 'on') {
    const name = rest.join(' ').trim();
    return { kind: 'share', action: 'on', name: name || null };
  }
  if (s === 'off') return rest.length ? err(SHARE_USAGE) : { kind: 'share', action: 'off' };
  if (s === 'public') {
    const v = String(rest[0] ?? '').toLowerCase();
    if (rest.length === 1 && (v === 'on' || v === 'off')) return { kind: 'share', action: 'public', value: v === 'on' };
    return err('Usage: /share public on|off');
  }
  if (s === 'reset-link' && rest.length === 0) return { kind: 'share', action: 'reset-link' };
  return err(SHARE_USAGE);
}

// /lab picks which lab is on screen; like /share it talks to the bridge, so it
// parses in every view. `labs` is [{ id, label }] in menu order.
function resolveLab(typed, labs) {
  const saved = labs.length ? labs.map((l, i) => `${i + 1}. ${l.label}`).join(', ') : '(none yet; /lab add <invite link>)';
  if (/^\d+$/.test(typed)) {
    const lab = labs[Number(typed) - 1];
    return lab ? { id: lab.id } : { error: err(`No saved lab ${typed}. Saved: ${saved}`) };
  }
  const hit = resolve(typed, labs, (l) => l.label);
  if (hit && hit.label.toLowerCase() === typed.toLowerCase()) return { id: hit.id };
  if (hit) return { error: err(`No saved lab "${typed}". Did you mean "${hit.label}"?`) };
  return { error: err(`No saved lab "${typed}". Saved: ${saved}`) };
}

function parseLab(args, labs) {
  const [sub, ...rest] = args;
  const s = String(sub ?? '').toLowerCase();
  if (!s) return { kind: 'lab', action: 'list' };
  if (s === 'add') {
    const link = rest.join(' ').trim();
    return link ? { kind: 'lab', action: 'add', link } : err('Usage: /lab add <invite link>');
  }
  if (s === 'browse' && rest.length === 0) return { kind: 'lab', action: 'browse' };
  if ((s === 'mine' || s === 'home') && rest.length === 0) return { kind: 'lab', action: 'go', target: 'mine' };
  if (s === 'remove') {
    const typed = rest.join(' ').trim();
    if (!typed) return err('Usage: /lab remove <n>');
    const r = resolveLab(typed, labs);
    return r.error ?? { kind: 'lab', action: 'remove', id: r.id };
  }
  const r = resolveLab(args.join(' ').trim(), labs);
  return r.error ?? { kind: 'lab', action: 'go', target: r.id };
}

export function parseCommand(line, ctx = {}) {
  const { chip = null, agents = [], projects = [], labs = [] } = ctx;
  const raw = String(line ?? '').trim();
  if (!raw) return { kind: 'noop' };

  if (raw.startsWith('/')) {
    const [head, ...args] = tokenize(raw.slice(1));
    const name = String(head ?? '').toLowerCase();
    if (name === 'focus') return parseFocus(args, projects);
    if (name === 'hour') return parseHour(args);
    if (name === 'share') return parseShare(args);
    if (name === 'lab' || name === 'labs') return parseLab(name === 'labs' ? [] : args, labs);
    if (name === 'help' || name === 'clear') return { kind: 'view', name };
    if (name === 'launch') return parseLaunch(args, projects);
    if (name === 'agents') return { kind: 'manage', name: 'agents' };
    if (name === 'kill') {
      if (!args[0]) return err('Usage: /kill <agent>');
      const r = resolveAgent(args[0], agents);
      return r.error ?? { kind: 'manage', name: 'kill', arg: r.name };
    }
    return err(`Unknown command "/${name}". Try /help.`);
  }

  if (raw.startsWith('@')) {
    const sp = raw.search(/\s/);
    const typed = sp === -1 ? raw.slice(1) : raw.slice(1, sp);
    const body = sp === -1 ? '' : raw.slice(sp + 1).trim();
    const r = resolveAgent(typed, agents);
    if (r.error) return r.error;
    if (!body) return err(`Nothing to send to ${r.name}.`);
    return { kind: 'message', target: r.name, body };
  }

  // Clicking a trainer opens the desk overlay and sets no target on its own —
  // the Target button in that overlay is what chips the console. Keep this
  // wording in step with the real flow; it is most of the discovery path.
  if (!chip) return err('No target. Click a trainer, then Target in the overlay — or address a message with @name.');
  return { kind: 'message', target: chip, body: raw };
}
