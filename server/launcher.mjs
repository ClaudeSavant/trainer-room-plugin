// The /trainer-room command (sharing spec §7): find the local bridge, start it
// in the background if it isn't running, open the lab, and report status or
// stop it. It only ever signals a process that identified itself as Trainer
// Room on the port, and every outcome it can explain prints plain lines.
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trainerRoomHome, eventsPathFor } from '../hooks/paths.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BRIDGE = join(REPO_ROOT, 'server', 'bridge.mjs');
export const DEFAULT_PORT = 4123;
export const USAGE = 'Usage: /trainer-room [status|stop]';
export const PORT_BUSY = (port) =>
  `Port ${port} is in use by another program (or an older Trainer Room bridge). Stop it, or set TRAINER_ROOM_PORT to another port.`;
const pluginEventsPath = (env) => eventsPathFor({ argv: ['--plugin'], env, repoRoot: REPO_ROOT });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlFor = (port) => `http://127.0.0.1:${port}`;

export function portFrom(env) {
  const raw = env.TRAINER_ROOM_PORT;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export async function probe(port, fetchImpl = globalThis.fetch) {
  try {
    const r = await fetchImpl(`${urlFor(port)}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!r.ok) return { state: 'other' };
    const body = await r.json().catch(() => null);
    return body && body.app === 'trainer-room' ? { state: 'ours', health: body } : { state: 'other' };
  } catch (err) {
    return { state: err?.cause?.code === 'ECONNREFUSED' ? 'free' : 'other' };
  }
}

function logTail(path, lines = 10) {
  try {
    const text = readFileSync(path, 'utf8');
    return text.slice(-4000).trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

export async function start({
  port = DEFAULT_PORT, env = process.env, home = trainerRoomHome(env),
  fetchImpl = globalThis.fetch, waitMs = 5000, bridgeScript = BRIDGE,
} = {}) {
  const p = await probe(port, fetchImpl);
  if (p.state === 'ours') return { ok: true, already: true, url: urlFor(port), health: p.health };
  if (p.state === 'other') return { ok: false, error: PORT_BUSY(port) };
  const childEnv = { ...env, TRAINER_ROOM_HOME: home };
  const events = pluginEventsPath(childEnv);         // the file the plugin's hooks write
  const logPath = join(home, 'bridge.log');
  let child;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(events), { recursive: true, mode: 0o700 });
    closeSync(openSync(events, 'a', 0o600));         // exists (and private) before the bridge tails it
    const log = openSync(logPath, 'a', 0o600);
    try {
      child = spawn(process.execPath, [bridgeScript, '--events', events, '--port', String(port)], {
        detached: true, stdio: ['ignore', log, log], env: childEnv,
      });
      child.on('error', () => {});
      child.unref();
    } finally {
      closeSync(log);
    }
  } catch (err) {
    return { ok: false, error: `Could not prepare ${home}: ${err.code || err.message}` };
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    await sleep(100);
    const q = await probe(port, fetchImpl);
    if (q.state === 'ours') return { ok: true, already: false, url: urlFor(port), health: q.health };
  }
  // Still alive but not listening: it is ours by construction, so stop it rather
  // than leave it to answer the next /trainer-room as "already running".
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    return {
      ok: false, pid: child.pid,
      error: `The bridge did not start within ${waitMs / 1000}s, so it was stopped (pid ${child.pid}). Last lines of ${logPath}:\n${logTail(logPath)}`,
    };
  }
  return { ok: false, error: `The bridge did not start. Last lines of ${logPath}:\n${logTail(logPath)}` };
}

export async function stop({ port = DEFAULT_PORT, fetchImpl = globalThis.fetch, waitMs = 3000, kill = process.kill.bind(process) } = {}) {
  const p = await probe(port, fetchImpl);
  if (p.state !== 'ours') return { ok: true, wasRunning: false };
  const { pid } = p.health;
  // pid 0, -1 or 1 would signal a process group, every process we own, or init.
  if (!(Number.isInteger(pid) && pid > 1 && pid !== process.pid)) {
    return { ok: false, error: `The process on port ${port} did not report a usable pid; stop it yourself.` };
  }
  try { kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    await sleep(100);
    if ((await probe(port, fetchImpl)).state !== 'ours') return { ok: true, wasRunning: true, pid };
  }
  return { ok: false, error: `Could not stop Trainer Room (pid ${pid}).`, pid };
}

export function openCommand(platform, url) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url] };
  return { cmd: 'xdg-open', args: [url] };
}

function openInBrowser(url, platform) {
  const { cmd, args } = openCommand(platform, url);
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); }
  catch { /* the URL is printed anyway */ }
}

export async function runCli(args, {
  env = process.env, platform = process.platform, openUrl = (url) => openInBrowser(url, platform),
  fetchImpl = globalThis.fetch,
} = {}) {
  const port = portFrom(env);
  const words = args.filter((a) => a !== '--no-open');
  const sub = words[0] ?? 'open';
  if (sub === 'status') {
    const p = await probe(port, fetchImpl);
    if (p.state === 'ours') return [`Trainer Room is running at ${urlFor(port)} (pid ${p.health.pid}).`];
    if (p.state === 'free') return ['Trainer Room is not running. Start it with /trainer-room.'];
    return [PORT_BUSY(port)];
  }
  if (sub === 'stop') {
    const r = await stop({ port, fetchImpl });
    if (!r.ok) return [r.error];
    return [r.wasRunning ? `Stopped Trainer Room (pid ${r.pid}).` : 'Trainer Room is not running.'];
  }
  if (sub !== 'open' || words.length > 1) return [USAGE];
  const r = await start({ port, env, fetchImpl });
  if (!r.ok) return [r.error];
  const lines = [r.already ? `Trainer Room is already running at ${r.url}` : `Trainer Room is running at ${r.url}`];
  const expected = pluginEventsPath(env);
  if (r.health.events && r.health.events !== expected) {
    lines.push(`Note: this bridge reads ${r.health.events}, but the plugin's hooks write ${expected}. If your hooks come from the plugin, run /trainer-room stop and then /trainer-room.`);
  }
  // A note only, never a restart: the owner's manual bridge runs from the repo
  // root, and a root mismatch must never make /trainer-room stop it.
  if (r.health.root && r.health.root !== REPO_ROOT) {
    lines.push(`Note: this bridge runs a different copy of Trainer Room (${r.health.root}). If you just updated the plugin, run /trainer-room stop and then /trainer-room.`);
  }
  if (!args.includes('--no-open')) openUrl(r.url);
  return lines;
}
