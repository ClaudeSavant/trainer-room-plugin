import { loadImages, browserLoad, withTimeout } from '/engine/assets.mjs';
import { roomPx, canvasSizing, roomFrame } from '/engine/tilemap.mjs';
import { ROOM } from '/engine/room.mjs';
import { createRoom } from '/engine/room-instance.mjs';
import { roomKey, applySeq, visibleRooms, emptyRoomKeys, scrubEvent, fallbackLabel, displayLabel } from '/engine/routing.mjs';
import { parseMarkdown } from '/console/markdown.mjs';
import { parseCommand } from '/console/parse.mjs';
import { sharePillText } from '/console/share-pill.mjs';
import { consoleTarget } from '/console/gate.mjs';
import { createLabsClient } from '/labs/client.mjs';
import { startVisit } from '/labs/visit.mjs';
import { MINE, menuItems, menuSignature, activeLabel, watchQuery, labChoices, reconcileActive, directoryRows, isVisitKey } from '/labs/switcher.mjs';
import { VIEWER_CONFIG } from '/viewer/adapter.mjs';
import { consoleRows, renderConsole, fmtTime } from '/console/view.mjs';
import { loadRenderer, probeWebGL, afterContextLoss, fallbackLogArgs, nextFallback, wants2dDraw } from '/render3d/backend.mjs';

const ASSET_TIMEOUT_MS = 5000;
const ROOM_IDLE_MS = 5 * 60 * 1000;   // pause rooms with no events for 5 min
const REAP_CHECK_MS = 30 * 1000;      // throttle for the ghost-agent reap safety net
const CONSOLE_RENDER_MS = 100;        // min gap between console redraws (see loop())

const _hp = new URLSearchParams(location.search).get('hour');
// let, not const: the URL still seeds it, and /hour overrides it at runtime.
let hourOverride = (_hp != null && _hp.trim() !== '' && Number.isFinite(Number(_hp))) ? Number(_hp) : null;
function currentHour() {
  if (hourOverride != null) return hourOverride;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

let config = { agents: {}, palette: ['#4aa3ff'] };
let manifest = null;
let bundle = null;            // { tileset, items, characters } or null (fallback)
let lastSeq = -1;
// Renderer backend (spec §7): set once in boot(); r3d is null whenever 2D draws.
let rendererState = { kind: '2d', reason: 'booting' };
let r3d = null;
const reducedMotionMq = matchMedia('(prefers-reduced-motion: reduce)');
const drawFailures = new Set();   // rooms whose 3D draw threw: logged once, then no longer drawn

const tabsEl = document.getElementById('tabs');
const roomsEl = document.getElementById('rooms');
// Two room maps (sharing spec §5): the owner's own rooms always receive events;
// visited rooms exist only while a lab is on screen. `rooms` is whichever is shown.
const myRooms = new Map();    // project -> { room, card, canvas, ctx, count, … }
const visitRooms = new Map(); // 'lab:<room id>' -> the same shape, presence-only
let rooms = myRooms;
let activeLab = { kind: MINE };
let visit = null;             // the running visit (startVisit), or null
let savedLabs = [];           // [{ id, kind, name, publicId? }] from the bridge
const labsClient = createLabsClient();
let viewMode = 'all';
let lastTabKeys = '';

// Display label priority (spec 2026-10-14): /api/project repo -> its folder label
// -> the SessionStart projectLabel -> fallbackLabel(), which never yields a raw
// slug. Every DISPLAY path goes through labelFor.
const projectLabels = new Map();   // slug -> human label, from SessionStart events
const projectInfo = new Map();     // key -> { repo, label, goal, readme } from /api/project
function labelFor(key) {
  if (isVisitKey(key)) return visit ? visit.labelOf(key) : '';
  const info = projectInfo.get(key);
  // || not ??: an empty repo/label string must never display as a blank title.
  return displayLabel(info) || projectLabels.get(key) || fallbackLabel(key);
}

// A room can be created by a mid-session event (the server tails from EOF, so the
// SessionStart for an already-running session is behind us) and only learn its
// label later. Tabs re-read labelFor every frame and self-heal, but the card's
// <h2> is written once at creation — so nudge it here.
function rememberLabel(key, label) {
  if (projectLabels.get(key) === label) return;
  projectLabels.set(key, label);
  const entry = myRooms.get(key);
  // labelFor, not label: once /api/project info has landed its repo outranks this.
  if (entry) entry.title.textContent = labelFor(key);   // textContent: the label is untrusted
}

// One fetch per room; a 404/failed fetch is retried exactly once ~5 s later
// (a brand-new session's transcript may not exist yet), and again when that
// room next sees a SessionStart (handle() resets the retry and calls this).
// In-flight keys are tracked so the burst of snapshot events does not fan out
// duplicate requests.
const INFO_RETRY_MS = 5000;
const infoInFlight = new Set();
const infoRetried = new Set();
function loadProjectInfo(key) {
  if (projectInfo.has(key) || infoInFlight.has(key)) return;
  infoInFlight.add(key);
  fetch(`/api/project?key=${encodeURIComponent(key)}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((info) => {
      if (info) { projectInfo.set(key, info); applyInfo(key); return; }
      if (infoRetried.has(key)) return;
      infoRetried.add(key);
      setTimeout(() => loadProjectInfo(key), INFO_RETRY_MS);
    })
    .finally(() => infoInFlight.delete(key));
}

// Card title + goal row are written at creation, so refresh them when info lands.
// Tabs re-read labelFor on every renderTabs() and need nothing here.
function applyInfo(key) {
  const entry = myRooms.get(key);
  if (!entry) return;
  entry.title.textContent = labelFor(key);
  const info = projectInfo.get(key);
  entry.goal.hidden = !info?.goal;
  entry.goalText.textContent = info?.goal ?? '';
}

const readmeOverlay = document.getElementById('readmeOverlay');
const readmeTitle = document.getElementById('readmeTitle');
const readmeBody = document.getElementById('readmeBody');

// createElement + textContent only: parseMarkdown's tag set is closed, and no
// README text is ever parsed as HTML.
function mdToDom(node) {
  if (node.tag === '#text') return document.createTextNode(node.text);
  const el = document.createElement(node.tag);
  if (node.text != null) el.textContent = node.text;
  else for (const c of node.children ?? []) el.appendChild(mdToDom(c));
  return el;
}

function openReadme(key) {
  const info = projectInfo.get(key);
  if (!info?.readme) return;
  readmeTitle.textContent = `README · ${labelFor(key)}`;
  readmeBody.replaceChildren(...parseMarkdown(info.readme).map(mdToDom));
  readmeBody.scrollTop = 0;
  readmeOverlay.hidden = false;
  document.getElementById('readmeClose').focus();
}
function closeReadme() { readmeOverlay.hidden = true; }
document.getElementById('readmeClose').addEventListener('click', closeReadme);
readmeOverlay.addEventListener('click', (e) => { if (e.target === readmeOverlay) closeReadme(); });

const termOverlay = document.getElementById('termOverlay');
const termTitle = document.getElementById('termTitle');
const termBody = document.getElementById('termBody');
let openTerm = null;   // { room, session, name, project } or null

function closeTerm() { openTerm = null; termOverlay.hidden = true; }

function buildLogRow(line, viewingName) {
  const row = document.createElement('div');
  row.className = line.type === 'chat' ? 'log-row log-chat' : 'log-row log-activity';
  const meta = document.createElement('div');
  meta.className = 'log-meta';
  const time = document.createElement('span');
  time.textContent = fmtTime(line.ts);
  meta.appendChild(time);
  if (line.type === 'chat') {
    const dir = document.createElement('span');
    dir.className = 'log-dir';
    dir.textContent = line.from === viewingName ? `→ ${line.to ?? '?'}` : `← ${line.from ?? '?'}`;
    meta.appendChild(dir);
  }
  row.appendChild(meta);
  const body = document.createElement('div');
  body.className = 'log-text';
  body.textContent = line.type === 'chat' && line.detail ? line.detail : line.summary;
  row.appendChild(body);
  return row;
}

function renderTerm() {
  if (!openTerm) return;
  // session keys every lookup; name is display only, and the project shows its
  // cached human label rather than the raw slug.
  const { room, session, name, project } = openTerm;
  const st = room.statusOf ? room.statusOf(session) : '';
  termTitle.textContent = `${name} · ${labelFor(project)}${st ? ' · ' + st : ''}`;
  const atBottom = termBody.scrollTop + termBody.clientHeight >= termBody.scrollHeight - 4;
  const rows = room.feedFor(session).map((l) => buildLogRow(l, name));
  termBody.replaceChildren(...rows);
  if (atBottom) termBody.scrollTop = termBody.scrollHeight;
}

document.getElementById('termClose').addEventListener('click', closeTerm);
termOverlay.addEventListener('click', (e) => { if (e.target === termOverlay) closeTerm(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeTerm(); closeReadme(); closeLabMenu(); closeDirectory(); } });

const consoleBody = document.getElementById('consoleBody');
const consoleForm = document.getElementById('consoleForm');
const consoleInput = document.getElementById('consoleInput');
const chipEl = document.getElementById('consoleChip');

const globalLines = [];        // ring buffer of every event, cap 200
let lineId = 0;
let chip = null;               // { session, project, name } of the targeted agent, or null
let consoleRev = 0;            // bumped whenever the console's contents change

// The console is redrawn wholesale (replaceChildren), so loop() only redraws when
// this revision has moved. ANY new code that changes what the console should show
// must call this — including Task 6's setChip/clearChip, which switch the view
// between the global stream and one agent's feed.
function markConsoleDirty() { consoleRev++; }

function pushLine(line) {
  globalLines.push({ id: ++lineId, ...line });
  if (globalLines.length > 200) globalLines.shift();
  markConsoleDirty();
}

function setChip(session, project) {
  const entry = myRooms.get(project);
  // nameOf is the world's authority on the display name, and the fallback below
  // is UNREACHABLE defense-in-depth — not a patch over a known state bug. The
  // only empty-name source would be agentAtPoint returning {session, name:''},
  // which cannot happen: every mutator calls recomputeDesks(), which rebuilds
  // assignment.slots from Object.values(world.agents), and assignDesks only ever
  // emits session keys drawn from its input — so slots ⊆ world.agents is
  // structural. Kept anyway because a chip reading "→  ✕" over an empty
  // placeholder is a bad failure mode for a purely cosmetic value, and a short
  // session id still matches the overlay title. Do not treat it as evidence of a
  // hazard to preserve.
  const name = (entry ? entry.room.nameOf(session) : '') || String(session).slice(0, 8);
  chip = { session, project, name };
  chipEl.hidden = false;
  chipEl.textContent = `→ ${name} ✕`;
  // Without this a screen reader announces the glyphs ("right arrow … multiplication
  // sign") instead of what the button does.
  chipEl.setAttribute('aria-label', `Targeting ${name} — click to clear`);
  consoleInput.placeholder = `message ${name}`;
  markConsoleDirty();           // REQUIRED: without this the console keeps
  consoleInput.focus();         // showing the global stream until an unrelated
}                               // event bumps the revision — a silent failure.

// A chip is invalidated by loop() in two cases: its session left, or the view
// moved to a DIFFERENT project. Not by the All view, though — the gate refuses
// every message there, so a chip cannot disagree with an authorized target that
// does not exist, and clearing on 'all' would delete the chip the instant Target
// set it (the app boots in the All view, and every room's canvas is clickable in
// it) — killing the one interaction this slice ships. In the All view the chip is
// a feed selector only.
function clearChip() {
  chip = null;
  chipEl.hidden = true;
  consoleInput.placeholder = '/help for commands';
  markConsoleDirty();           // REQUIRED, same reason.
}

// The chip hides itself on activation, so focus would fall back to <body> and a
// keyboard user would lose their place. Refocus here rather than inside
// clearChip: the self-clear in loop() also calls clearChip, and that path must
// NOT steal focus just because an agent happened to depart.
chipEl.addEventListener('click', () => { clearChip(); consoleInput.focus(); });

// Targeting is driven from the desk overlay, not the canvas click — the canvas
// click keeps opening the overlay exactly as it does today.
document.getElementById('termTarget').addEventListener('click', () => {
  if (openTerm) { setChip(openTerm.session, openTerm.project); closeTerm(); }
});

// A main session is reap-exempt for 72h, so one whose SessionEnd never arrived
// would sleep in the barracks until then. This is the manual way out.
document.getElementById('termDismiss').addEventListener('click', () => {
  if (!openTerm) return;
  const entry = myRooms.get(openTerm.project);
  if (entry && entry.room.dismiss(openTerm.session)) {
    pushLine({ ts: new Date().toISOString(), kind: 'system', text: `dismissed ${openTerm.name}` });
  }
  closeTerm();
});

// The chip carries its project, so go straight to that room. The old scan
// returned whichever room happened to have a non-empty feed for the name,
// which is wrong the moment two projects both run an agent called "backend".
function feedLinesFor({ session, project }) {
  const entry = myRooms.get(project);
  if (!entry) return [];
  return entry.room.feedFor(session).map((l) => ({ ...l, kind: l.type === 'chat' ? 'chat' : 'activity' }));
}

// Display NAMES, for parseCommand's /kill and @name resolution — those are typed
// by a human, so they stay names even though every room accessor is now keyed by
// session. Two sessions sharing a name collapse to one entry, which is exactly
// what a typed name can address.
function agentNames() {
  const names = new Set();
  for (const { room } of myRooms.values()) {
    for (const s of room.agentSessions()) {
      const n = room.nameOf(s);
      if (n) names.add(n);
    }
  }
  return [...names];
}

// labelFor, not projectLabel: /focus and /launch resolve what the user typed
// against these labels, and what they see on a tab is the cached human name.
function projectList() {
  return [...rooms.keys()].map((key) => {
    const info = projectInfo.get(key);
    return info?.label ? { key, label: labelFor(key), aliases: [info.label] } : { key, label: labelFor(key) };
  });
}

// The `rooms` shape consoleTarget expects. label is the CACHED SessionStart label
// (a raw slug would read "-Users-me-trainer-room has no main session running.").
function gateRooms() {
  return [...rooms.entries()].map(([key, e]) => {
    const main = e.room.mainSession();
    const mains = e.room.agentSessions().filter((s) => e.room.isMain(s));
    return {
      key,
      label: labelFor(key),
      mainSession: main,
      mainName: main ? e.room.nameOf(main) : '',
      mainShortId: main ? main.slice(0, 8) : '',
      mainCount: mains.length,
    };
  });
}

// Description column is 31 across every entry — the width the longest command
// (/launch) already forced. Targeting is listed with the working commands, not
// the Slice B block, because it is the one interaction this slice ships.
const labButton = document.getElementById('labButton');
const labMenu = document.getElementById('labMenu');
const labStatusEl = document.getElementById('labStatus');
const labBadge = document.getElementById('labBadge');
const labBanner = document.getElementById('labBanner');
let nameRefreshed = false;

function applyLabStatus(s) {
  labStatusEl.hidden = false;
  labBadge.textContent = s.badge;
  labBadge.className = `badge badge-${s.badge.replace(/\s+/g, '-')}`;
  labBanner.textContent = s.banner ?? '';
  // A newly saved lab learns its name from its first live frame (the bridge stores it).
  if (s.badge === 'online' && !nameRefreshed) { nameRefreshed = true; refreshLabs(); }
}

function switchLab(next) {
  visit?.stop();
  visit = null;
  for (const key of [...visitRooms.keys()]) dropCard(visitRooms, key);
  activeLab = next;
  viewMode = 'all';
  lastTabKeys = '';
  nameRefreshed = false;
  closeLabMenu();
  if (next.kind === MINE) {
    rooms = myRooms;
    labStatusEl.hidden = true;
    for (const entry of myRooms.values()) { entry.card.style.display = ''; entry.repaint2d = true; }
  } else {
    rooms = visitRooms;
    closeTerm();
    visit = startVisit({ query: watchQuery(next), client: labsClient, onEvents: feedVisit, onStatus: applyLabStatus });
  }
  renderLabButton();
  renderTabs();
}

function renderLabButton() {
  labButton.textContent = `${activeLabel(activeLab, savedLabs)} ▾`;
}

function setSavedLabs(list) {
  savedLabs = list;
  const next = reconcileActive(activeLab, savedLabs);
  if (next !== activeLab) switchLab(next);
  renderLabButton();
  if (!labMenu.hidden && menuSignature(activeLab, savedLabs) !== renderedMenu) renderLabMenu();
}

function refreshLabs() {
  labsClient.list().then((list) => { if (list) setSavedLabs(list); });
}

let renderedMenu = '';
function renderLabMenu() {
  renderedMenu = menuSignature(activeLab, savedLabs);
  labMenu.replaceChildren();
  for (const item of menuItems(activeLab, savedLabs)) {
    if (item.type === 'add') labMenu.appendChild(document.createElement('hr'));
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    if (item.current) b.classList.add('current');
    b.addEventListener('click', () => {
      if (item.type === 'mine') switchLab({ kind: MINE });
      else if (item.type === 'saved') switchLab({ kind: 'saved', id: item.id });
      else if (item.type === 'add') { closeLabMenu(); consoleInput.value = '/lab add '; consoleInput.focus(); }
      else if (item.type === 'browse') { closeLabMenu(); openDirectory(); }
    });
    labMenu.appendChild(b);
  }
}
function openLabMenu() { renderLabMenu(); labMenu.hidden = false; labButton.setAttribute('aria-expanded', 'true'); labMenu.querySelector('button')?.focus(); }
function closeLabMenu() { labMenu.hidden = true; labButton.setAttribute('aria-expanded', 'false'); }
labButton.addEventListener('click', () => { if (labMenu.hidden) openLabMenu(); else closeLabMenu(); });
document.addEventListener('click', (e) => { if (!labMenu.hidden && !e.target.closest('#labSwitch')) closeLabMenu(); });

const dirOverlay = document.getElementById('dirOverlay');
const dirList = document.getElementById('dirList');
function dirNote(text) {
  const p = document.createElement('div'); p.className = 'dir-note'; p.textContent = text;
  dirList.replaceChildren(p);
}
async function openDirectory() {
  dirOverlay.hidden = false;
  dirNote('Loading…');
  const list = await labsClient.directory();
  if (dirOverlay.hidden) return;
  if (!list) { dirNote('Could not reach the public directory. Try again in a moment.'); return; }
  if (list.length === 0) { dirNote('No public labs right now.'); return; }
  dirList.replaceChildren();
  for (const row of directoryRows(list, savedLabs)) {
    const el = document.createElement('div'); el.className = 'dir-row';
    const name = document.createElement('span'); name.className = 'dir-name'; name.textContent = row.name;
    const detail = document.createElement('span'); detail.className = 'dir-detail'; detail.textContent = row.detail;
    const actions = document.createElement('span'); actions.className = 'dir-actions';
    const watch = document.createElement('button'); watch.type = 'button'; watch.textContent = 'Watch';
    watch.addEventListener('click', () => { closeDirectory(); switchLab({ kind: 'public', publicId: row.publicId, name: row.name }); });
    const save = document.createElement('button'); save.type = 'button';
    save.textContent = row.saved ? 'Saved' : 'Save';
    save.disabled = row.saved;
    save.addEventListener('click', async () => {
      save.disabled = true;
      const r = await labsClient.savePublic(row.publicId, row.name);
      if (r.labs) setSavedLabs(r.labs);
      for (const text of r.lines) pushLine({ ts: new Date().toISOString(), kind: r.ok ? 'system' : 'error', text });
      save.textContent = r.ok ? 'Saved' : 'Save';
      save.disabled = r.ok;
    });
    actions.append(watch, save);
    el.append(name, detail, actions);
    dirList.appendChild(el);
  }
}
function closeDirectory() { dirOverlay.hidden = true; }
document.getElementById('dirClose').addEventListener('click', closeDirectory);
dirOverlay.addEventListener('click', (e) => { if (e.target === dirOverlay) closeDirectory(); });

const HELP = [
  '/focus <project> | all         switch the room view',
  '/hour <0-23>                   override the day/night clock',
  '/clear                         clear the console',
  '/share on <name> | off         share your lab by link (counts only)',
  '/share public on|off           list it in the public directory',
  '/share reset-link              new link; the old one stops working',
  '/lab                           list saved labs',
  '/lab add <invite link>         save a lab and watch it',
  '/lab <n> | mine | browse       switch lab · public labs',
  '/lab remove <n>                forget a saved lab',
  'click a trainer → Target       aim the console at one agent',
  '/launch <project> "<prompt>"   (Slice B)',
  '/agents, /kill <name>          (Slice B)',
  '@<agent> <message>             (Slice B)',
];

// Sharing (spec §3): the bridge owns it and talks to the relay; the page only
// asks its own bridge and mirrors the answer in the header pill.
const sharePill = document.getElementById('sharePill');
const SHARE_POLL_MS = 15 * 1000;
function applyShareStatus(s) {
  const text = sharePillText(s);
  sharePill.hidden = text == null;
  if (text == null) return;
  sharePill.textContent = text;
  sharePill.title = 'Type /share to see your link';   // never the URL: it holds the invite token
}
function refreshShare() {
  fetch('/api/share')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((b) => applyShareStatus(b?.status));
}
async function runShare(cmd) {
  const now = () => new Date().toISOString();
  try {
    const r = await fetch('/api/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: cmd.action, name: cmd.name ?? null, value: cmd.value }),
    });
    const body = await r.json().catch(() => ({}));
    if (body.status) applyShareStatus(body.status);
    const lines = Array.isArray(body.lines) ? body.lines : [`Sharing request failed (HTTP ${r.status}).`];
    for (const text of lines) pushLine({ ts: now(), kind: r.ok && body.ok !== false ? 'system' : 'error', text: String(text) });
  } catch {
    pushLine({ ts: now(), kind: 'error', text: 'Could not reach the bridge.' });
  }
}

// The kinds that ACT on an agent, and so need an authorized target. `view` and
// `noop` are deliberately absent: /focus is the only way back out of a project
// (and, from the All view, the only way in without a mouse), and /help is how
// the rest is discovered — gating those made the console a dead end at boot,
// since the app starts in the All view where the gate is closed.
const GATED_KINDS = new Set(['message', 'manage', 'launch']);

function labGate() {
  if (activeLab.kind === MINE) return consoleTarget({ viewMode, rooms: gateRooms() });
  return { enabled: false, project: null, session: null, label: '', reason: 'Visiting a lab: switch to My lab to message.' };
}

async function runLab(cmd) {
  const say = (text, kind = 'system') => pushLine({ ts: new Date().toISOString(), kind, text });
  if (cmd.action === 'list') {
    if (savedLabs.length === 0) say('No saved labs yet. Paste an invite link with /lab add <link>.');
    labChoices(savedLabs).forEach((c, i) => say(`${i + 1}. ${c.label}`));
    say(`On screen: ${activeLabel(activeLab, savedLabs)}`);
    return;
  }
  if (cmd.action === 'go') {
    switchLab(cmd.target === MINE ? { kind: MINE } : { kind: 'saved', id: cmd.target });
    say(`On screen: ${activeLabel(activeLab, savedLabs)}`);
    return;
  }
  if (cmd.action === 'browse') { openDirectory(); return; }
  const before = activeLab;   // the user may switch while the request is out
  const r = cmd.action === 'add' ? await labsClient.add(cmd.link) : await labsClient.remove(cmd.id);
  if (r.labs) setSavedLabs(r.labs);
  for (const text of r.lines) say(text, r.ok ? 'system' : 'error');
  if (cmd.action === 'add' && r.ok && r.entry && activeLab === before) switchLab({ kind: 'saved', id: r.entry.id });
}

function runCommand(text) {
  const raw = String(text ?? '').trim();
  const gate = labGate();
  const refuse = () => pushLine({ ts: new Date().toISOString(), kind: 'error', text: gate.reason });
  // Gate on INTENT, not on the parse outcome. Anything not starting with '/' is
  // unambiguously a message attempt — bare text aimed at the chip, or @name — so
  // the intent is knowable without the parser, and asking the parser first
  // answers a closed gate with its "No target. Click a trainer…" advice, which
  // walks the user into two paths the gate then refuses. That is the console's
  // most likely first-contact response, since the app boots into the All view
  // with no chip. '/'-prefixed input keeps the parse-then-gate path below, so
  // /help and /focus stay reachable in every mode.
  if (raw && !raw.startsWith('/') && !gate.enabled) { refuse(); return; }
  // The chip is reconciled against the view by loop(), a frame later. Consume it
  // through that SAME predicate here, because this is where it actually decides a
  // target: "/focus beta" then "hi" submitted in one frame would otherwise send
  // the second at the chip's old project. rAF drops to ~1Hz in a background
  // window, so that gap is wide enough to click a tab and press Enter — this is
  // the correctness half, and loop()'s clear is only the cosmetic half.
  const live = chip && (viewMode === 'all' || viewMode === chip.project) ? chip : null;
  // parseCommand wants a target NAME string (it returns it verbatim as
  // {kind:'message', target}); the chip is an object, so unwrap it here.
  const cmd = parseCommand(text, { chip: live?.name ?? null, agents: agentNames(), projects: projectList(), labs: labChoices(savedLabs) });
  if (cmd.kind === 'noop') return;
  // Refuses BEFORE anything executes — parsing is pure, so nothing has happened
  // yet at this point. The input is no longer disabled while the gate is closed
  // (view commands have to remain typable), so this is now the ONLY thing
  // stopping a gated command, not a backstop behind a disabled input.
  if (GATED_KINDS.has(cmd.kind) && !gate.enabled) { refuse(); return; }
  pushLine({ ts: new Date().toISOString(), kind: 'user', text: `> ${text}` });

  if (cmd.kind === 'error') {
    pushLine({ ts: new Date().toISOString(), kind: 'error', text: cmd.message });
    return;
  }
  if (cmd.kind === 'view') {
    if (cmd.name === 'focus') { viewMode = cmd.arg; renderTabs(); }
    else if (cmd.name === 'hour') { hourOverride = cmd.arg; }
    else if (cmd.name === 'clear') { globalLines.length = 0; markConsoleDirty(); }
    else if (cmd.name === 'help') {
      for (const h of HELP) pushLine({ ts: new Date().toISOString(), kind: 'system', text: h });
    }
    return;
  }
  if (cmd.kind === 'share') { runShare(cmd); return; }
  if (cmd.kind === 'lab') { runLab(cmd); return; }
  pushLine({ ts: new Date().toISOString(), kind: 'system', text: `"${cmd.kind}" is not wired yet — Slice B.` });
}

// preventDefault is load-bearing: a <form> with a single text input implicitly
// submits on Enter, which would navigate and reload the whole app.
consoleForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = consoleInput.value;
  consoleInput.value = '';
  runCommand(text);
});

function renderTabs() {
  const keys = [...rooms.keys()];
  const sig = viewMode + '|' + keys.join(',');
  if (sig === lastTabKeys) { // still refresh active state + counts cheaply
    for (const b of tabsEl.children) {
      b.classList.toggle('active', b.dataset.key === viewMode);
      if (b.dataset.key !== 'all') {
        const e = rooms.get(b.dataset.key);
        if (e) b.textContent = `${labelFor(b.dataset.key)} (${e.room.agentCount()})`;
      }
    }
    return;
  }
  lastTabKeys = sig;
  tabsEl.replaceChildren();
  const mk = (key, label) => {
    const b = document.createElement('button');
    b.dataset.key = key; b.textContent = label;
    b.classList.toggle('active', key === viewMode);
    b.onclick = () => { viewMode = key; renderTabs(); };
    tabsEl.appendChild(b);
  };
  mk('all', 'All');
  for (const key of keys) {
    const { room } = rooms.get(key);
    mk(key, `${labelFor(key)} (${room.agentCount()})`);
  }
}

function openTermFor(project, entry, hit) {
  openTerm = { room: entry.room, session: hit.session, name: hit.name, project };
  termOverlay.hidden = false;
  renderTerm();
  const mine = openTerm;
  // Only closes the terminal this call opened, not a later one.
  return () => { if (openTerm === mine) closeTerm(); };
}

function attach3d(project, entry) {
  r3d.ensureRoom(project, entry.overlayEl);
  entry.detach3d = r3d.attachControls(project, entry.canvas, {
    isSingle: () => viewMode === project,
    onClick: (x, y) => {
      const slot = r3d.pick(project, entry.canvas, x, y);
      const hit = slot == null ? null : entry.room.agentAtSlot(slot);
      return hit ? openTermFor(project, entry, hit) : null;
    },
  });
}

// One-way switch to 2D (spec §7): room state lives in the shared simulation, so
// nothing is lost; the next frame simply draws through room.render().
function fallbackTo2d(next) {
  const state = nextFallback(rendererState, next);
  if (!state) return;   // already 2D: one switch, one console line
  rendererState = state;
  if (r3d) r3d.hideOverlays();
  for (const entry of [...myRooms.values(), ...visitRooms.values()]) { entry.detach3d?.(); entry.detach3d = null; }
  // Free the GPU side; a failure here must never block the fallback itself.
  if (r3d) { try { r3d.dispose(); } catch (error) { console.warn('[trainer-room] 3D dispose failed', error); } }
  r3d = null;
  roomsEl.classList.remove('r3d');
  // An idle room would keep showing its last 3D frame: repaint every room in 2D.
  for (const entry of [...myRooms.values(), ...visitRooms.values()]) entry.repaint2d = true;
  console.warn(...fallbackLogArgs(state));
}

function dropCard(map, key) {
  const entry = map.get(key);
  if (!entry) return;
  if (openTerm && openTerm.project === key) closeTerm();
  entry.detach3d?.();
  r3d?.dropRoom(key);
  drawFailures.delete(key);   // a room re-created under this key gets a fresh chance
  entry.card.remove();
  map.delete(key);
}

function ensureRoom(project) {
  if (myRooms.has(project)) return myRooms.get(project);
  const card = document.createElement('div'); card.className = 'card';
  const h = document.createElement('h2');
  const title = document.createElement('span'); title.textContent = labelFor(project);
  const count = document.createElement('span'); h.append(title, count);
  // A <button>, so it is keyboard-focusable and Enter/Space open it for free.
  const goal = document.createElement('button'); goal.type = 'button'; goal.className = 'goal'; goal.hidden = true;
  const caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '▸ ';
  const goalText = document.createElement('span');
  goal.append(caret, goalText);
  goal.addEventListener('click', () => openReadme(project));
  // The stage wraps the canvas so the 3D text overlay can sit exactly on it.
  const stage = document.createElement('div'); stage.className = 'stage';
  const canvas = document.createElement('canvas');
  const overlayEl = document.createElement('div'); overlayEl.className = 'ov';
  stage.append(canvas, overlayEl);
  const statsEl = document.createElement('div'); statsEl.className = 'stats';
  card.append(h, goal, stage, statsEl);
  roomsEl.appendChild(card);
  if (rooms !== myRooms) card.style.display = 'none';
  // Per-room deps: live getters for the SHARED assets (config/manifest/bundle load
  // asynchronously) plus this card's own statsEl. Built per room (not spread) so the
  // getters stay live — a spread would snapshot them to values at creation time.
  const deps = {
    get config() { return config; },
    get manifest() { return manifest; },
    get bundle() { return bundle; },
    statsEl,
  };
  const entry = { room: createRoom(project, deps), card, canvas, ctx: canvas.getContext('2d'), overlayEl, detach3d: null, count, header: h, title, goal, goalText, statsEl, lastEventTs: Date.now(), lastReapCheck: Date.now() };
  canvas.addEventListener('click', (e) => {
    if (r3d) return;   // 3D: attachControls owns click detection (drag vs click)
    // agentAtPoint returns {session, name}: session keys the feed/status lookups,
    // name is carried along purely for display.
    const hit = entry.room.agentAtPoint(canvas, e.clientX, e.clientY);
    if (hit) openTermFor(project, entry, hit);
  });
  myRooms.set(project, entry);
  if (r3d) {
    // A throw here would leave this room half-wired for 3D; 2D can draw it whole.
    try { attach3d(project, entry); }
    catch (error) { fallbackTo2d({ kind: '2d', reason: 'attach-failed', error }); }
  }
  applyInfo(project);
  loadProjectInfo(project);
  if (rooms === myRooms) renderTabs();
  return entry;
}

// A visited lab's room (spec §5): presence only, so no goal row, no stats bar,
// no terminal on click; the 3D camera still orbits in single-room view.
const visitDeps = {
  config: VIEWER_CONFIG,
  get manifest() { return manifest; },
  get bundle() { return bundle; },
  presenceOnly: true,
};
function ensureVisitRoom(key) {
  if (visitRooms.has(key)) return visitRooms.get(key);
  const card = document.createElement('div'); card.className = 'card';
  const h = document.createElement('h2');
  const title = document.createElement('span'); title.textContent = labelFor(key);
  const count = document.createElement('span'); h.append(title, count);
  const stage = document.createElement('div'); stage.className = 'stage';
  const canvas = document.createElement('canvas');
  const overlayEl = document.createElement('div'); overlayEl.className = 'ov';
  stage.append(canvas, overlayEl);
  card.append(h, stage);
  roomsEl.appendChild(card);
  const entry = { room: createRoom(key, visitDeps), card, canvas, ctx: canvas.getContext('2d'), overlayEl, detach3d: null,
    count, header: h, title, goal: null, statsEl: null, lastEventTs: Date.now(), lastReapCheck: Date.now() };
  visitRooms.set(key, entry);
  if (r3d) {
    try {
      r3d.ensureRoom(key, overlayEl);
      entry.detach3d = r3d.attachControls(key, canvas, { isSingle: () => viewMode === key, onClick: () => null });
    } catch (error) { fallbackTo2d({ kind: '2d', reason: 'attach-failed', error }); }
  }
  if (rooms === visitRooms) renderTabs();
  return entry;
}

function feedVisit(events) {
  for (const ev of events) {
    const entry = ensureVisitRoom(ev.project);
    entry.lastEventTs = Date.now();
    entry.room.applyEvent(ev);
  }
}

function handle(ev) {
  // M2: discard malformed events so one bad line can't freeze the page.
  if (!ev || typeof ev.agent !== 'string' || ev.agent.length === 0 || typeof ev.type !== 'string') return;
  ev = scrubEvent(ev);   // no file-system paths reach any display (spec §3)
  // H2: dedupe against the server's monotonic seq so reconnect snapshots are idempotent.
  const d = applySeq(lastSeq, ev);
  if (!d.apply) return;
  lastSeq = d.lastSeq;
  const key = roomKey(ev);
  // Before ensureRoom: the card title is written once at creation, so the label
  // has to be cached by the time the room is first materialized.
  // typeof, not truthiness: labelFor widened what a label may be. routing's projectLabel
  // used to String() every key on its way out, so a non-string could never reach
  // parse.mjs; a cached 42 renders a "42" tab fine but throws out of resolve()'s
  // keyOf(...).toLowerCase on the next /focus. Same posture as the M2 guard above.
  if (typeof ev.projectLabel === 'string' && ev.projectLabel) rememberLabel(key, ev.projectLabel);
  const entry = ensureRoom(key);
  if (ev.type === 'agent_start') { infoRetried.delete(key); loadProjectInfo(key); }   // retry a 404'd room on SessionStart
  entry.lastEventTs = Date.now();
  entry.room.applyEvent(ev);
  pushLine({
    ts: ev.ts, agent: ev.agent,
    kind: ev.type === 'chat' ? 'chat' : 'activity',
    text: ev.detail ?? ev.summary ?? ev.type,
  });
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (m) => {
    try { for (const ev of JSON.parse(m.data)) handle(ev); }
    catch (err) { console.warn('bad snapshot', err); }
  });
  es.onmessage = (m) => {
    try { handle(JSON.parse(m.data)); }
    catch (err) { console.warn('bad event', err); }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

let last = performance.now();
let lastConsoleRev = -1;       // -1, not 0: guarantees one initial console render
let lastConsoleRender = 0;
function loop(now) {
  const dt = now - last; last = now;
  const wall = Date.now();
  const hour = currentHour();
  // Every agent for a project has ended -> the room is gone, not just idle.
  // Sweep before computing keys/vis below so a removed selected-tab room
  // never leaves the dashboard blank for a frame.
  for (const map of [myRooms, visitRooms]) {
    const counts = {};
    for (const [key, entry] of map) counts[key] = entry.room.agentCount();
    for (const key of emptyRoomKeys(counts)) dropCard(map, key);
  }
  // The hidden lab's cards stay out of the grid (own rooms keep their state).
  if (rooms !== myRooms) for (const entry of myRooms.values()) entry.card.style.display = 'none';
  if (rooms !== myRooms) {
    for (const entry of myRooms.values()) {
      if (wall - entry.lastReapCheck > REAP_CHECK_MS) { entry.lastReapCheck = wall; entry.room.reapTick(wall); }
    }
  }
  // Don't strand the user on a dead channel. Check the chip's OWN room: this
  // covers both the agent ending (dropped from that room's world) and the whole
  // room being swept above when its last agent left.
  if (chip) {
    const entry = myRooms.get(chip.project);
    if (!entry || !entry.room.agentSessions().includes(chip.session)) {
      pushLine({ ts: new Date().toISOString(), kind: 'system', text: `${chip.name} left — console back to all agents.` });
      clearChip();
    } else if (activeLab.kind === MINE && viewMode !== 'all' && viewMode !== chip.project) {
      // Same class of staleness, different cause: the chip aims at one project
      // while the gate authorizes another. This runs a frame LATE, so it is not
      // what makes that safe — runCommand re-tests the same predicate when it
      // consumes the chip, and that is the correctness half. This half is
      // cosmetic: retire the pill and say why, so the console does not keep
      // showing a target it would no longer use.
      // Scoped to a FOCUSED view on purpose — see the note above clearChip.
      pushLine({ ts: new Date().toISOString(), kind: 'system', text: `${chip.name} is in another project — console back to all agents.` });
      clearChip();
    }
  }
  const keys = [...rooms.keys()];
  const vis = new Set(visibleRooms(viewMode, keys));
  // selected project disappeared -> fall back to all and show everything
  if (viewMode !== 'all' && !vis.has(viewMode)) {
    viewMode = 'all';
    for (const k of keys) vis.add(k);
  }
  roomsEl.classList.toggle('single', viewMode !== 'all');
  for (const [key, entry] of rooms) {
    const visible = vis.has(key);
    entry.card.style.display = visible ? '' : 'none';
    // Ghost-agent reap safety net: runs for EVERY room on a throttled cadence,
    // independent of both the visibility skip and the idle-pause skip below.
    // A room whose only agent's SessionEnd never arrived stops receiving any
    // events at all, which is exactly what triggers the idle-pause skip — so a
    // reap wired only into tickSim/render would never run for that room.
    if (wall - entry.lastReapCheck > REAP_CHECK_MS) {
      entry.lastReapCheck = wall;
      entry.room.reapTick(wall);
    }
    if (!visible) continue;   // hidden rooms keep their state (events still routed) but don't tick/render
    const { room, canvas, ctx, count } = entry;
    // size each canvas to its card width at the room's aspect ratio. Sizing runs
    // BEFORE the idle guard below so selecting an idle project's tab still
    // re-letterboxes its canvas (idle only skips sim/render, never layout).
    const S = manifest ? manifest.tileSize : 16;
    const { w: rw, h: rh } = roomPx(ROOM, S);
    let sizing;
    if (viewMode !== 'all') {
      // single-room: fit the WHOLE card inside the visible #rooms area so the
      // room never exceeds the viewport. Letterbox by whichever of width or the
      // remaining height (after the card's header + stats chrome) is limiting —
      // otherwise the canvas follows full container width and the integer tile
      // scale jumps ~4-7x, blowing the room past the scroll area ("too zoomed in").
      const chrome = entry.header.offsetHeight + (entry.goal?.offsetHeight ?? 0) + (entry.statsEl?.offsetHeight ?? 0);
      const availW = roomsEl.clientWidth - 22;   // 20px #rooms padding + card border
      const availH = roomsEl.clientHeight - 22 - chrome;
      sizing = canvasSizing(true, availW, availH, rw, rh);
    } else {
      canvas.style.width = '';                   // revert to CSS width:100% before measuring full width
      sizing = canvasSizing(false, 0, 0, rw, rh, canvas.clientWidth || 360);
    }
    canvas.style.width = sizing.styleWidth;
    // Backing store in device pixels for 3D (crisp); 1:1 for 2D's integer pixel
    // art. Assign only on change: assigning clears the canvas, which would blank
    // an idle-paused room and flicker the 30 fps grid between its frames.
    const pr = r3d ? r3d.pixelRatio(viewMode === 'all' ? 'grid' : 'single') : 1;
    const bw = Math.round(sizing.width * pr), bh = Math.round(sizing.height * pr);
    const resized = canvas.width !== bw || canvas.height !== bh;
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    // pause stale rooms (no events for ROOM_IDLE_MS): keep the last frame, spend
    // no CPU/DOM on sim — sizing above already ran so an idle-but-visible room is
    // still correctly letterboxed. An idle room still draws (without ticking)
    // when its backing store was just cleared by a resize, and in 3D while the
    // user is orbiting/zooming it or its camera is still settling.
    const { simulate } = roomFrame(wall - entry.lastEventTs > ROOM_IDLE_MS);
    if (simulate) room.tickSim(dt);
    if (r3d) {
      const mode = viewMode === 'all' ? 'grid' : 'single';
      // A resize cleared the canvas, so it repaints now rather than at the next due frame.
      const due = resized || r3d.frameDue(key, now, mode);
      if (!drawFailures.has(key) && due && (simulate || r3d.wantsFrame(key, { canvas, now }))) {
        try { r3d.renderRoom(key, { snapshot: room.snapshot(now, hour), ctx, canvas, mode, now }); }
        catch (err) {
          // One bad room must not blank the others: stop drawing it in 3D, say so once.
          drawFailures.add(key);
          console.warn(`[trainer-room:${key}] 3D draw failed; skipping this room's frames`, err);
        }
      }
      if (simulate && entry.statsEl) room.tickStats(now);
    } else if (wants2dDraw({ simulate, resized, repaint: entry.repaint2d })) {
      entry.repaint2d = false;
      room.render(ctx, canvas, now, hour);
    }
    if (!simulate) continue;
    count.textContent = `${room.agentCount()} agents`;
  }
  renderTabs();
  if (openTerm) renderTerm();
  // Messaging needs exactly one project in view and aims at that project's main
  // session. The input is NEVER disabled — view commands stay typable in every
  // mode — so the placeholder alone carries the state, and it has to do two jobs
  // at once: point at /help and say why messaging is unavailable. It is the only
  // place either is said: index.html's static hint and clearChip's write are both
  // reclaimed here within a frame, so no human ever reads them.
  //
  // Compared by TEXT rather than against a flag: focusing a SECOND project changes
  // nothing but the label, so a flag check would leave the previous project's main
  // session named here. While the gate is open a chip owns the string (setChip
  // wrote the identical text, so this is a no-op then); while it is closed the
  // gate's own wording wins. Converges after one write, so it does not re-dirty
  // the console every tick.
  const target = labGate();
  const wantPlaceholder = target.enabled
    ? `message ${chip ? chip.name : target.label}`
    // Short prefix, not the full '/help for commands': the pane is 280px at its
    // narrowest and the focused-but-no-main reason is a whole sentence on its own.
    : `/help · ${viewMode === 'all' && activeLab.kind === MINE ? 'select a project to message' : target.reason}`;
  if (consoleInput.placeholder !== wantPlaceholder) {
    consoleInput.placeholder = wantPlaceholder;
    markConsoleDirty();
  }
  // Redraw only when the contents actually changed AND at most every
  // CONSOLE_RENDER_MS. Rebuilding ~800 nodes per frame competed with the canvas
  // loop and forced a reflow (the scroll read lands after renderTabs/renderTerm
  // already dirtied layout). A quiet console now never rebuilds at all, which
  // also lets a text selection survive long enough to copy.
  if (consoleRev !== lastConsoleRev && now - lastConsoleRender >= CONSOLE_RENDER_MS) {
    lastConsoleRev = consoleRev;
    lastConsoleRender = now;
    const feedLines = chip ? feedLinesFor(chip) : [];
    renderConsole(consoleBody, consoleRows({ globalLines, feedLines, chip }));
  }
  requestAnimationFrame(loop);
}

async function boot() {
  try {
    const cfg = await fetch('/config/agents.json');
    if (cfg.ok) config = await cfg.json();
  } catch { /* keep defaults */ }
  try {
    const loaded = await withTimeout((async () => {
      const res = await fetch('/assets/manifest.json');
      const m = await res.json();
      const b = await loadImages(m, browserLoad('/assets'));
      return { m, b };
    })(), ASSET_TIMEOUT_MS, 'asset load');
    manifest = loaded.m; bundle = loaded.b;
  } catch (err) {
    console.warn('[trainer-room] asset load failed/timed out; falling back to procedural rendering', err);
    manifest = null; bundle = null;
  }
  rendererState = await loadRenderer({ param: new URLSearchParams(location.search).get('renderer'), webgl: probeWebGL() });
  if (rendererState.kind === '3d') {
    try {
      r3d = rendererState.mod.createRenderer3d({
        reducedMotion: () => reducedMotionMq.matches,
        onContextLost: () => fallbackTo2d(afterContextLoss(rendererState)),
      });
      roomsEl.classList.add('r3d');
      console.log('[trainer-room] renderer: 3d');
    } catch (error) {
      r3d = null;
      fallbackTo2d({ kind: '2d', reason: 'init-failed', error });
    }
  } else {
    // A chosen 2D (?renderer=2d, no WebGL) is informational; a failed import is a warning.
    (rendererState.error ? console.warn : console.log)(...fallbackLogArgs(rendererState));
  }
  connect();   // after the backend is known, so every room is created for it
  refreshShare();
  setInterval(refreshShare, SHARE_POLL_MS);
  refreshLabs();
  setInterval(refreshLabs, SHARE_POLL_MS);
  renderLabButton();
  requestAnimationFrame(loop);
}

boot();
