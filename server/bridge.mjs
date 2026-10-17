import { createServer as createHttp } from 'node:http';
import { readFileSync, existsSync, readFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { dirname, join, normalize, extname, relative, isAbsolute } from 'node:path';
import { tailLines } from './tail.mjs';
import { createWorld, applyEvent } from '../web/sim/world.mjs';
import { resolveProjectInfo, isSlug, isProjectPath, DEFAULT_PROJECTS_DIR } from './project-info.mjs';
import { createShare, DEFAULT_RELAY, STOPPED } from './share/index.mjs';
import { trainerRoomHome } from '../hooks/paths.mjs';
import { createLabs } from './labs/index.mjs';
import { isMain } from './is-main.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB_DIR = join(REPO_ROOT, 'web');
const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

export function createServer({ eventsPath, replayFile, port = 0, projectsDir = DEFAULT_PROJECTS_DIR, homeDir = homedir(), share: shareOpts = null, labs: labsOpts = null } = {}) {
  let world = createWorld();
  const recent = [];            // recent events for snapshot (cap 200)
  const clients = new Set();
  let seq = 0;                  // monotonic id so reconnects are idempotent
  // Sharing (spec §3) is opt-in per bridge: null means no /api/share at all,
  // which is what every embedder and existing test gets.
  const share = shareOpts ? createShare(shareOpts) : null;
  // Visiting other labs (spec §5): null means no /api/labs at all.
  const labs = labsOpts ? createLabs(labsOpts) : null;
  const labStreams = new Set();   // open /api/labs/watch responses, ended on close()

  // /api/project results are disk reads (transcript head, git config, README),
  // so cache briefly. 30s means a README edit shows up on the next page fetch
  // after at most half a minute. Bounded: only slug- or path-shaped keys are cached and
  // the map is cleared if it ever grows past 500. Misses are NOT cached: a new
  // session's first lookup can 404 before its transcript exists, and caching
  // that would hide the project for the whole TTL.
  const INFO_TTL_MS = 30 * 1000;
  const infoCache = new Map();   // key -> { at, info }
  function projectInfo(key) {
    if (!isSlug(key) && !isProjectPath(key, homeDir)) return null;
    const hit = infoCache.get(key);
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.info;
    let info = null;
    try { info = resolveProjectInfo(key, { projectsDir, homeDir }); } catch { /* treat as unknown */ }
    if (!info) { infoCache.delete(key); return null; }
    if (infoCache.size > 500) infoCache.clear();
    infoCache.set(key, { at: Date.now(), info });
    return info;
  }

  function broadcast(ev) {
    const out = { ...ev, seq: ++seq };
    world = applyEvent(world, out);
    recent.push(out);
    if (recent.length > 200) recent.shift();
    const frame = `id: ${out.seq}\ndata: ${JSON.stringify(out)}\n\n`;
    for (const res of clients) res.write(frame);
    // After the browser has it: sharing can never delay or drop the local view.
    try { share?.onEvent(out); } catch { /* sharing is best-effort */ }
  }

  // DNS-rebinding guard: a hostile page that rebinds its own name to 127.0.0.1
  // still sends its own Host, so only the loopback names on our port pass.
  function hostAllowed(host) {
    const h = String(host ?? '').toLowerCase();
    return h === `127.0.0.1:${boundPort}` || h === `localhost:${boundPort}`;
  }

  // The Host guard stops DNS rebinding, but any site the owner visits can
  // still fire a CORS-simple POST at 127.0.0.1 with our Host. Requiring JSON
  // forces a preflight we never answer, and a present Origin must be our own.
  // Non-browser clients (curl, tests) send no Origin.
  function originAllowed(origin) {
    if (origin === undefined) return true;
    const o = String(origin).toLowerCase();
    return o === `http://127.0.0.1:${boundPort}` || o === `http://localhost:${boundPort}`;
  }

  // Browsers send Sec-Fetch-Site on every request; anything but our own page
  // (or a typed URL) is a cross-site page using the owner's browser as a proxy.
  function fetchSiteAllowed(req) {
    const s = req.headers['sec-fetch-site'];
    return s === undefined || s === 'same-origin' || s === 'none';
  }

  function jsonSender(res) {
    return (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
  }

  // POST guard + body read shared by /api/share and /api/labs: own Origin,
  // JSON content type, at most BODY_MAX bytes, valid JSON object.
  const BODY_MAX = 4096;
  function readJsonPost(req, send, then) {
    if (!originAllowed(req.headers.origin)) { send(403, { lines: ['Forbidden origin.'] }); return; }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
      send(415, { lines: ['Expected application/json.'] });
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      if (size > BODY_MAX) return;   // already refused: drain the rest
      size += c.length;
      if (size > BODY_MAX) { send(413, { lines: ['Request too large.'] }); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > BODY_MAX) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { send(400, { lines: ['Bad JSON.'] }); return; }
      then(body && typeof body === 'object' ? body : {});
    });
  }

  function handleShare(req, res) {
    const send = jsonSender(res);
    if (!share) { send(404, { lines: ['Sharing is not available on this bridge.'] }); return; }
    if (req.method === 'GET') { send(200, { status: share.status() }); return; }
    if (req.method !== 'POST') { send(405, { lines: ['Use GET or POST.'] }); return; }
    readJsonPost(req, send, async (body) => {
      try {
        const r = await share.command(body);
        send(r.ok ? 200 : 400, r);
      } catch (err) {
        send(500, { lines: [`Sharing failed: ${err.message}`] });
      }
    });
  }

  const LAB_KEEPALIVE_MS = 25_000;
  function handleLabs(req, res, url) {
    const send = jsonSender(res);
    if (!labs) { send(404, { lines: ['Visiting labs is not available on this bridge.'] }); return; }
    if (!fetchSiteAllowed(req)) { send(403, { lines: ['Forbidden.'] }); return; }
    const path = url.pathname;
    if (path === '/api/labs') {
      if (req.method === 'GET') { send(200, { labs: labs.list() }); return; }
      if (req.method !== 'POST') { send(405, { lines: ['Use GET or POST.'] }); return; }
      readJsonPost(req, send, (body) => {
        try {
          const r = labs.command(body);
          send(r.ok ? 200 : 400, r);
        } catch (err) {
          send(500, { lines: [`Lab request failed: ${err.message}`] });
        }
      });
      return;
    }
    if (req.method !== 'GET') { send(405, { lines: ['Use GET.'] }); return; }
    if (path === '/api/labs/directory') {
      labs.directory().then((list) => {
        if (list) send(200, { ok: true, labs: list });
        else send(502, { ok: false, lines: ['Could not reach the public directory. Try again in a moment.'] });
      });
      return;
    }
    if (path === '/api/labs/watch') {
      const id = url.searchParams.get('id');
      const target = id != null ? { id } : { publicId: url.searchParams.get('public') };
      // The relay answers asynchronously, so headers are always out before the first frame.
      let h;
      try { h = labs.watch(target, (view) => { res.write(`data: ${JSON.stringify(view)}\n\n`); }); }
      catch { send(502, { ok: false, lines: ['Could not reach the relay for that lab.'] }); return; }
      if (h.error === 429) { send(429, { ok: false, lines: ['Too many labs open at once. Close another lab tab first.'] }); return; }
      if (h.error) { send(404, { ok: false, lines: ['That lab is not saved.'] }); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const ka = setInterval(() => res.write(': ka\n\n'), LAB_KEEPALIVE_MS);
      labStreams.add(res);
      res.on('close', () => { clearInterval(ka); h.stop(); labStreams.delete(res); });
      return;
    }
    send(404, { lines: ['Not found.'] });
  }

  const server = createHttp((req, res) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    // The launcher's way to tell this bridge from any other program on the port.
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ app: 'trainer-room', version: VERSION, pid: process.pid, events: replayFile ? null : eventsPath, root: REPO_ROOT }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(recent)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/share') { handleShare(req, res); return; }
    if (url.pathname === '/api/labs' || url.pathname.startsWith('/api/labs/')) { handleLabs(req, res, url); return; }
    if (url.pathname === '/api/project') {
      const info = projectInfo(url.searchParams.get('key') ?? '');
      res.writeHead(info ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(info ?? {}));
      return;
    }
    // static files: /config/* -> repo config dir; everything else -> web/
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); }
    catch { res.writeHead(404); res.end('not found'); return; }
    // Reject any traversal segment outright.
    if (decoded.split(/[\\/]/).includes('..')) {
      res.writeHead(404); res.end('not found'); return;
    }
    let baseDir = WEB_DIR;
    let rel = decoded;
    if (rel === '/') rel = '/index.html';
    if (rel.startsWith('/config/')) { baseDir = join(REPO_ROOT, 'config'); rel = rel.slice('/config'.length); }
    const filePath = normalize(join(baseDir, rel));
    // Real boundary check: filePath must resolve inside baseDir.
    const relToBase = relative(baseDir, filePath);
    if (relToBase.startsWith('..') || isAbsolute(relToBase) || !existsSync(filePath)) {
      res.writeHead(404); res.end('not found'); return;
    }
    readFile(filePath, (err, data) => {
      if (err) { res.writeHead(500); res.end('error'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  // Track the bound port so port() never depends on server.address() being
  // populated synchronously. For an explicit port we already know the value;
  // for an ephemeral port (0) we learn it once the socket is listening.
  let boundPort = port > 0 ? port : null;
  // Passing a host to listen() defers the bind through an async lookup, so the
  // socket is not listening synchronously and address()/an ephemeral port() are
  // null until the 'listening' event fires. `ready` lets callers await that.
  let markReady;
  const ready = new Promise((resolve) => { markReady = resolve; });
  server.on('listening', () => { boundPort = server.address().port; markReady(); });
  // Bind explicitly to loopback so the bridge is only reachable from this host.
  // The startup log advertises http://127.0.0.1, and the SSE stream + static
  // file server are unauthenticated, so it must not be exposed on the LAN.
  server.listen(port, '127.0.0.1');

  let stop = () => {};
  if (replayFile) {
    const lines = existsSync(replayFile)
      ? readFileSync(replayFile, 'utf8').split('\n').filter(Boolean)
      : [];
    let i = 0;
    const timer = setInterval(() => {
      if (lines.length === 0) return;
      try { broadcast(JSON.parse(lines[i % lines.length])); } catch { /* skip */ }
      i++;
    }, 700);
    stop = () => clearInterval(timer);
  } else {
    stop = tailLines(eventsPath, (line) => {
      try { broadcast(JSON.parse(line)); } catch { /* skip */ }
    }, { intervalMs: 100 });
  }

  return {
    server,
    ready,
    share,
    labs,
    port: () => boundPort ?? (server.address() ? server.address().port : null),
    close: () => {
      stop(); share?.close(); labs?.close();
      for (const c of clients) c.end();
      for (const r of labStreams) r.end();
      server.close();
    },
  };
}

// Replay mode replays canned events, so it never shares by default: only an
// explicit TRAINER_ROOM_SHARE_FILE opts a replay bridge in (and then it uses
// that file, never the real ~/.trainer-room/share.json).
export function shareOptionsFor({ replayFile, env = {} } = {}) {
  if (replayFile && !env.TRAINER_ROOM_SHARE_FILE) return null;
  return {
    statePath: env.TRAINER_ROOM_SHARE_FILE || join(trainerRoomHome(env), 'share.json'),
    relayUrl: env.TRAINER_ROOM_RELAY || DEFAULT_RELAY,
  };
}

// Same rule as sharing: a replay bridge visits nothing unless a labs file is
// named, so demos never touch the owner's real ~/.trainer-room/labs.json.
export function labsOptionsFor({ replayFile, env = {} } = {}) {
  if (replayFile && !env.TRAINER_ROOM_LABS_FILE) return null;
  const relayUrl = env.TRAINER_ROOM_RELAY || DEFAULT_RELAY;
  try { new URL(relayUrl); } catch {
    console.warn(`[labs] TRAINER_ROOM_RELAY is not a valid URL (${relayUrl}); visiting labs is off.`);
    return null;
  }
  return { statePath: env.TRAINER_ROOM_LABS_FILE || join(trainerRoomHome(env), 'labs.json'), relayUrl };
}

// CLI entry
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const replayFile = args.includes('--replay') ? get('--replay') : undefined;
  const eventsPath = get('--events') || join(REPO_ROOT, 'events.jsonl');
  const port = Number(get('--port') || 4123);
  const app = createServer({
    eventsPath, replayFile, port,
    share: shareOptionsFor({ replayFile, env: process.env }),
    labs: labsOptionsFor({ replayFile, env: process.env }),
  });
  // Emit the startup URL once the socket is actually listening so the bound
  // port is known regardless of how/when server.address() populates.
  const announce = () => {
    console.log(`Trainer Room on http://127.0.0.1:${app.port()}  ${replayFile ? '(replay)' : '(live)'}`);
    const s = app.share?.status();
    if (s?.enabled && s.relay !== 'off') console.log(`Sharing on as "${s.name}". Invite link: ${s.inviteUrl}`);
    else if (s?.enabled) console.log(STOPPED);
  };
  if (app.server.listening) announce();
  else app.server.on('listening', announce);
}
