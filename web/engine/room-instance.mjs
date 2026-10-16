// A self-contained per-project Trainer Room: its own world, stats, desk
// assignment, trainers and fx. One Room never reads/mutates another's state.
//
// deps: { config, manifest, bundle, statsEl, presenceOnly? }. `config`/`manifest`/`bundle` may be
// live getters (assets load asynchronously), so we read them off `deps` at use
// time rather than destructuring once — this keeps the Room reading current
// values after the async asset load without buffering events.
import { createWorld, applyEvent as applyWorldEvent, tierFor, reapStale, REAP_AFTER_MS } from '../sim/world.mjs';
import { createTrainer, onEvent, tick, frameFor } from '../sim/trainer.mjs';
import { deskStand, deskRect, spawnPoint, assignDesks, MAX_DESKS, deskTileCells, barracksBunkTileCells, barracksBunkLie, deskSlotAt } from './layout.mjs';
import { colorForAgent, drawTrainer, drawTrainerShadow, drawItem, resolveSprite } from './sprites.mjs';
import { captionFor, trainerLabel, nameCensus } from './labels.mjs';
import { ROOM, FIXTURES } from './room.mjs';
import { lightingFor } from './daynight.mjs';
import { drawRoom, drawTile, roomPx } from './tilemap.mjs';
import { drawBubble } from './bubble.mjs';
import { createCelebration, drawCelebration, isExpired, blinkOn, celebrationProgress } from './fx.mjs';
import { createStats, accumulate } from '../sim/stats.mjs';
import { buildStatsView } from './statsview.mjs';

const ROLE_ORDER = ['lead', 'Backend', 'Frontend', 'reviewer'];

const WINDOW_CELLS = ROOM.layers.flatMap((l) => l.cells).filter((c) => c.tile === 'window');

export function createRoom(project, deps) {
  let world = createWorld();
  let stats = createStats();
  let assignment = { slots: {}, overflow: [] };
  let lastOverflow = -1;
  // Everything per-agent is keyed by SESSION, never by name: every main session
  // is called 'lead', so name-keying silently merged two concurrent sessions
  // into one trainer/feed/stats bucket. The display name lives on the world
  // entry (`a.name`) and is read from there at render time.
  const trainers = new Map();   // session -> trainer
  const frameClock = new Map(); // session -> ms accumulator
  const fxByAgent = new Map();  // session -> celebration[]
  const feeds = new Map();      // session -> [{ ts, summary, tool, model }] (cap 50)
  const FEED_CAP = 50;
  let lastStatsDraw = 0;
  // Activity cues for the 3D camera director, drained by snapshot(). Bounded:
  // the 2D path never drains it, so it must not grow without limit.
  const pendingEvents = [];
  const EVENT_CAP = 32;

  // Same key derivation as world.mjs/stats.mjs, deliberately duplicated rather
  // than imported so all three modules stay independently readable: a legacy
  // event with no session falls back to the name so it still lands
  // deterministically instead of under 'undefined'.
  const keyOf = (ev) => ev.session || ev.agent;

  function recomputeDesks() {
    assignment = assignDesks(Object.values(world.agents), ROLE_ORDER);
    if (assignment.overflow.length !== lastOverflow) {
      lastOverflow = assignment.overflow.length;
      // Log names alongside session ids: a bare session id is unreadable, and
      // two overflowed sessions can share a name.
      const who = assignment.overflow.map((s) => `${world.agents[s]?.name ?? '?'} (${s})`).join(', ');
      if (lastOverflow > 0) console.log(`[trainer-room:${project}] ${lastOverflow} agent(s) beyond desk cap, shown as "+N more": ${who}`);
    }
  }
  function slotFor(session) { return assignment.slots[session]; }

  // A skipped chat mirror is a real (if minor) loss of information, so say so
  // once per recipient name rather than failing invisibly. Deduped because chat
  // to an offline teammate repeats; the set is bounded because `ev.to` is
  // untrusted input and an unbounded one would be a slow leak.
  const warnedMirrors = new Set();
  function warnUnmirrored(to) {
    if (warnedMirrors.has(to)) return;
    if (warnedMirrors.size >= 64) warnedMirrors.clear();
    warnedMirrors.add(to);
    console.warn(`[trainer-room:${project}] chat to "${to}" not mirrored: no single live session has that name (absent, or shared by several). The sender's own feed still has it.`);
  }

  // Resolve a display NAME to the single session holding it. Chat's `ev.to` is a
  // name, but feeds are session-keyed, so the mirror needs this bridge. Returns
  // null when nothing matches or when the name is ambiguous (two sessions both
  // called 'lead' — the exact case this slice exists for): guessing would file
  // the message in the wrong trainer's feed, so callers skip instead.
  function sessionForName(name) {
    let hit = null;
    for (const [session, a] of Object.entries(world.agents)) {
      if (a.name !== name) continue;
      if (hit) return null; // ambiguous
      hit = session;
    }
    return hit;
  }

  // Drop all per-agent render/sim/stats bookkeeping once an agent has left the
  // world (SessionEnd delete or stale reap) so nothing lingers keyed to a gone
  // session. Stats matters most on the reap path: reapStale deletes the world
  // entry directly with no event, so if we didn't purge stats.bySession here a
  // reaped agent frozen mid-'working' would leave its status stuck that way —
  // and a restart reusing that session id would accrue the entire dead gap as
  // phantom active time/cost the next time accumulate() sees a gap since
  // prev.lastTs.
  function purgeAgent(session) {
    trainers.delete(session);
    frameClock.delete(session);
    fxByAgent.delete(session);
    feeds.delete(session);
    if (stats.bySession[session]) {
      const bySession = { ...stats.bySession };
      delete bySession[session];
      stats = { ...stats, bySession };
    }
  }

  // Reap agents whose shutdown event never arrived (defense-in-depth against a
  // missed SessionEnd). Pure diff-and-purge, no sim tick, no render — safe to
  // call on a cadence independent of whether this room is currently
  // visible/ticking, which matters because the ghost-agent scenario this
  // guards against is exactly the one that stops events (and therefore
  // tickSim/render) from ever running for this room again.
  function doReap(nowMs) {
    const before = Object.keys(world.agents);
    world = reapStale(world, nowMs, REAP_AFTER_MS);
    if (Object.keys(world.agents).length !== before.length) {
      for (const session of before) if (!(session in world.agents)) purgeAgent(session);
      recomputeDesks();
    }
  }

  function pushFeedLine(session, line) {
    const buf = feeds.get(session) ?? [];
    buf.push(line);
    if (buf.length > FEED_CAP) buf.splice(0, buf.length - FEED_CAP);
    feeds.set(session, buf);
  }

  // Keyed by session; the trainer carries the display name for readability only.
  function ensureTrainer(session, name, slot) {
    if (!trainers.has(session)) {
      trainers.set(session, createTrainer(name, spawnPoint(slot ?? 0)));
      frameClock.set(session, 0);
    }
    return trainers.get(session);
  }

  // Shared by render() and snapshot(): drop expired celebrations for ALL agents
  // (incl. overflow/undrawn) so the arrays never grow.
  function pruneCelebrations(now) {
    for (const [session, list] of fxByAgent) {
      const live = list.filter((fx) => !isExpired(fx, now));
      if (live.length) fxByAgent.set(session, live); else fxByAgent.delete(session);
    }
  }

  function tickStats(now) {
    if (now - lastStatsDraw > 250) { renderStats(Date.now()); lastStatsDraw = now; }
  }

  // A desk monitor glows while its trainer is up and about. Shared by render()
  // and snapshot() so the 2D screen and the 3D desk can never disagree.
  function isActive(t) {
    return !!t && t.status !== 'idle' && t.status !== 'sleeping';
  }

  // Callers get both: the session to key state by, the name to display. A
  // closure rather than a method so agentAtPoint works even when detached.
  function agentAtSlot(slot) {
    const session = Object.keys(assignment.slots).find((s) => assignment.slots[s] === slot);
    return session ? { session, name: world.agents[session]?.name ?? '' } : null;
  }

  function viewTransform(canvas, manifest) {
    const S = manifest ? manifest.tileSize : 16;
    const { w: rw, h: rh } = roomPx(ROOM, S);
    const scale = Math.max(1, Math.floor(Math.min(canvas.width / rw, canvas.height / rh)));
    return { scale, ox: Math.floor((canvas.width - rw * scale) / 2), oy: Math.floor((canvas.height - rh * scale) / 2), rw, rh };
  }

  function drawAmbient(ctx, manifest, now) {
    const S = manifest.tileSize;
    FIXTURES.forEach((f, i) => {
      const x = f.col * S, y = f.row * S;
      const on = blinkOn(1200, now, i * 300);
      if (f.tile === 'machine') {
        ctx.fillStyle = on ? '#9affc8' : '#3a455c';
        ctx.fillRect(x + 3, y + 12, 2, 2);
        ctx.fillStyle = on ? '#ffe27a' : '#3a455c';
        ctx.fillRect(x + 11, y + 12, 2, 2);
      } else { // console glow
        ctx.save();
        ctx.globalAlpha = on ? 0.55 : 0.2;
        ctx.fillStyle = '#a0f0ff';
        ctx.fillRect(x + 3, y + 2, 10, 4);
        ctx.restore();
      }
    });
  }

  function renderStats(now) {
    const statsEl = deps.statsEl;
    if (!statsEl) return;
    const order = Object.keys(assignment.slots)
      .sort((a, b) => assignment.slots[a] - assignment.slots[b]);
    const view = buildStatsView(stats, { order, overflow: assignment.overflow, now });
    // Build DOM nodes (never interpolate untrusted agent names / model ids into HTML).
    const cell = (label, rows, dotClass) => {
      const col = document.createElement('div');
      col.className = 'agent';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = label;
      const dot = document.createElement('span');
      dot.className = dotClass;
      dot.textContent = '●';
      col.append(name, document.createTextNode(' '), dot);
      const body = rows.map((r) => `${r.modelLabel.padEnd(9)} T${r.tool} D${r.doc} P${r.parcel} ★${r.deliverable}  ${r.activeLabel}  ${r.costLabel}`).join('\n');
      col.append(document.createTextNode('\n' + body));
      return col;
    };
    const nodes = view.agents.map((a) => cell(a.name, a.rows, a.status === 'working' ? 'dot-working' : 'dot-idle'));
    if (view.overflowCount > 0) nodes.push(cell(`+${view.overflowCount} more`, view.overflowRows, 'dot-idle'));
    if (view.overall.length) {
      const mix = document.createElement('div');
      mix.className = 'mix';
      mix.textContent = `mix: ${view.overall.map((m) => `${m.modelLabel} ${m.pct}%`).join(' · ')}`;
      nodes.push(mix);
    }
    const cost = document.createElement('div');
    cost.className = 'mix';
    cost.textContent = `cost: ${view.totalCostLabel}` + (view.overall.length ? ' — ' + view.overall.map((m) => `${m.modelLabel} ${m.costLabel}`).join(' · ') : '');
    nodes.push(cost);
    statsEl.replaceChildren(...nodes);
  }

  return {
    project,

    applyEvent(ev) {
      const session = keyOf(ev);
      world = applyWorldEvent(world, ev);
      // SessionEnd removed the agent from the world — drop all its per-agent
      // render/sim state too, then recompute desks so the freed slot is available.
      // Nothing below should re-materialize a gone agent, so we stop here.
      if (ev.type === 'agent_shutdown') {
        purgeAgent(session);
        recomputeDesks();
        return;
      }
      stats = accumulate(stats, ev);
      const line = {
        ts: ev.ts, summary: ev.summary || ev.type, tool: ev.tool ?? null, model: ev.model ?? null,
        type: ev.type,
        // `to`/`from` stay display NAMES: they are read by a human in the feed,
        // not used as keys.
        ...(ev.type === 'chat' ? { detail: ev.detail ?? null, to: ev.to ?? null, from: ev.agent } : {}),
      };
      pushFeedLine(session, line);
      // Chat is two-sided: mirror into the recipient's own feed too so clicking
      // EITHER party's desk shows the full exchange, not just the sender's
      // outbox. `ev.to` is a NAME and feeds are session-keyed, so it has to be
      // resolved; an unknown or ambiguous name is skipped rather than guessed
      // (see sessionForName). The sender's own copy above always lands, so a
      // skipped mirror hides no message — it only means the exchange shows up
      // on one desk instead of two.
      if (ev.type === 'chat' && ev.to) {
        const target = sessionForName(ev.to);
        const selfAddressed = world.agents[session]?.name === ev.to;
        if (target && target !== session) pushFeedLine(target, line);
        // A sender addressing its OWN name needs no mirror, so that is not a
        // skip and must not warn — including when the name looks ambiguous
        // only because a second session happens to share it.
        else if (!target && !selfAddressed) warnUnmirrored(ev.to);
      }
      recomputeDesks();
      const slot = slotFor(session);
      // Only materialize/track trainers that actually have a desk; overflow agents
      // are represented solely by the "+N more" indicator (no sim, no fx).
      if (slot !== undefined) {
        ensureTrainer(session, ev.agent, slot);
        trainers.set(session, onEvent(trainers.get(session), ev, deskStand(slot)));
        // A synthetic keepalive is not activity worth a camera cue.
        if (ev.type !== 'presence') {
          pendingEvents.push({ session, kind: tierFor(ev.type) === 'deliverable' ? 'deliverable' : 'tool', ts: performance.now() });
          if (pendingEvents.length > EVENT_CAP) pendingEvents.splice(0, pendingEvents.length - EVENT_CAP);
        }
        // delivery celebration on commit/PR
        if (tierFor(ev.type) === 'deliverable') {
          const r = deskRect(slot), s = deskStand(slot);
          const list = fxByAgent.get(session) ?? [];
          list.push(createCelebration(s.x, r.y, performance.now()));
          fxByAgent.set(session, list);
        }
      }
    },

    tickSim(dtMs) {
      // Cheap no-op unless something is genuinely stale; see reapTick below for
      // the decoupled version main.mjs also calls for idle-paused/hidden rooms.
      doReap(Date.now());
      // update sim (skip any trainer that has since been bumped to overflow)
      for (const [session, t] of trainers) {
        const slot = slotFor(session);
        if (slot === undefined) continue;
        trainers.set(session, tick(t, dtMs, deskStand(slot), barracksBunkLie(slot)));
        frameClock.set(session, (frameClock.get(session) + dtMs) % 100000);
      }
    },

    render(ctx, canvas, now, hour) {
      const manifest = deps.manifest;
      const bundle = deps.bundle;
      const config = deps.config;
      const { overlay, sky } = lightingFor(hour == null ? 12 : hour);
      const S = manifest ? manifest.tileSize : 16;

      pruneCelebrations(now);

      // clear full canvas in device space
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#11151c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // apply centered integer-scale room transform
      const { scale, ox, oy } = viewTransform(canvas, manifest);
      ctx.setTransform(scale, 0, 0, scale, ox, oy);

      // floor + furniture (or fallback bg if assets missing)
      if (bundle && manifest) { drawRoom(ctx, ROOM, bundle, manifest); drawAmbient(ctx, manifest, now); }
      else { ctx.fillStyle = '#1b2230'; ctx.fillRect(0, 0, ROOM.cols * 16, ROOM.rows * 16); }

      // window-sky tint (current time of day)
      ctx.fillStyle = `rgba(${sky[0]},${sky[1]},${sky[2]},0.5)`;
      for (const c of WINDOW_CELLS) ctx.fillRect(c.col * S, c.row * S, S, S);

      // desks + beds + stacked items (cap 8 shown per desk)
      for (const [session, a] of Object.entries(world.agents)) {
        const slot = slotFor(session);
        if (slot === undefined) continue;
        const r = deskRect(slot);
        if (bundle && manifest) {
          for (const c of deskTileCells(slot)) drawTile(ctx, bundle, manifest, 'desk', c.col, c.row);
          const t = trainers.get(session);
          const active = isActive(t);
          const mx = Math.round(r.x + r.w / 2 - 6), my = r.y + 2;
          ctx.fillStyle = '#10151c'; ctx.fillRect(mx, my, 12, 8);          // bezel
          ctx.fillStyle = active ? '#6ce67a' : '#33415a';                  // screen (glows when active)
          ctx.fillRect(mx + 1, my + 1, 10, 6);
        } else {
          ctx.fillStyle = '#33415a'; ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        const shown = a.items.slice(-8);
        shown.forEach((it, i) => drawItem(ctx, r.x + 8 + i * 5, r.y - 6, it.tier,
          bundle ? { items: bundle.items, manifest } : {}));
      }

      // barracks — a single shared row of bunks, drawn once per frame
      // regardless of occupancy. Unlike desks (which only materialize once an
      // agent is present), the barracks is a fixed room fixture agents walk to.
      if (bundle && manifest) {
        for (let i = 0; i < MAX_DESKS; i++) {
          for (const c of barracksBunkTileCells(i)) drawTile(ctx, bundle, manifest, 'bed', c.col, c.row);
        }
      }

      // trainers, y-sorted so lower ones overlap correctly
      const drawables = [];
      // Name census, once per frame. Two concurrent sessions are two separate
      // trainers, but config.agents keys BOTH sprite and colour by name, so a
      // duplicated name (every interactive session is called 'lead') renders
      // pixel-identical at adjacent desks. Counting once up front keeps the
      // draw loop below O(n) per frame. Counted over all of world.agents, not
      // just the drawn subset, to agree with the console's mainCount
      // (web/main.mjs).
      const nameCounts = nameCensus(world.agents);
      for (const [session, a] of Object.entries(world.agents)) {
        if (slotFor(session) === undefined) continue;
        const t = trainers.get(session);
        if (t) drawables.push({ session, a, t });
      }
      drawables.sort((p, q) => p.t.y - q.t.y);

      // ground-decal pass: all shadows sit under all sprites so no trainer's
      // shadow paints over a farther trainer's feet
      for (const { t } of drawables) drawTrainerShadow(ctx, t);

      for (const { session, a, t } of drawables) {
        // Sprite and colour stay keyed by the display NAME — config.agents is a
        // name map and a session id would never match it. Only identity/keying
        // moved to the session.
        const color = colorForAgent(a.name, slotFor(session), config);
        const sheet = bundle ? bundle.characters[resolveSprite(a.name, config)] : null;
        drawTrainer(ctx, t, { color, sheet, dir: t.dir, manifest, frame: frameFor(t.status, frameClock.get(session)) });

        // name label — the human-readable name, never the raw session id ALONE.
        // When a name is held by more than one session the short id is appended,
        // because sprite and colour above resolve by name and would otherwise
        // leave the two indistinguishable. Same shape and same 8-char slice as
        // the console placeholder (web/console/gate.mjs, web/main.mjs's
        // mainShortId), so a user reading 'lead a1b2c3d4' in the input hint sees
        // the same string under the desk. A sole holder stays a bare name — the
        // common case must not pick up an id it has no need for.
        // A visited lab (presenceOnly) paints neither: no names, no captions.
        if (deps.presenceOnly !== true) {
          const label = trainerLabel(a.name, session, nameCounts);
          ctx.fillStyle = color; ctx.font = '7px ui-monospace'; ctx.textAlign = 'center';
          ctx.fillText(label, t.x, t.y - 20);

          // speech bubble while active (never over a sleeping / bed-bound trainer)
          const cap = captionFor(t, a);
          if (cap) drawBubble(ctx, cap, t.x, t.y - 16, { charW: 4 });
        }

        // sleeping indicator
        if (t.status === 'sleeping') drawBubble(ctx, 'Zzz', t.x, t.y - 18, { charW: 4 });

        // celebrations (already pruned above)
        const list = fxByAgent.get(session);
        if (list) list.forEach((fx) => drawCelebration(ctx, fx, now));
      }

      // overflow indicator near the entrance (bottom center)
      if (assignment.overflow.length) {
        ctx.fillStyle = '#ffd24a'; ctx.font = '7px ui-monospace'; ctx.textAlign = 'center';
        ctx.fillText(`+${assignment.overflow.length} more`, (ROOM.cols * (manifest ? manifest.tileSize : 16)) / 2, ROOM.rows * (manifest ? manifest.tileSize : 16) - 4);
      }

      // day/night overlay wash over the whole room
      if (overlay[3] > 0.001) {
        ctx.fillStyle = `rgba(${overlay[0]},${overlay[1]},${overlay[2]},${overlay[3]})`;
        ctx.fillRect(0, 0, ROOM.cols * S, ROOM.rows * S);
      }

      tickStats(now);
    },

    // Read-only plain-data view for the 3D renderer (spec §2). Drains the
    // pending activity events; everything else is a pure read.
    snapshot(now, hour) {
      pruneCelebrations(now);
      const config = deps.config;
      // A visited lab (sharing spec §5) shows presence only: no names, labels or
      // captions, and shirts coloured by desk so generic trainers stay tellable apart.
      const presence = deps.presenceOnly === true;
      const census = nameCensus(world.agents);
      const desks = [], trainersOut = [], celebrations = [];
      for (const [session, a] of Object.entries(world.agents)) {
        const slot = slotFor(session);
        if (slot === undefined) continue;
        const t = trainers.get(session);
        desks.push({ slot, session, active: isActive(t), items: a.items.slice(-8).map((it) => it.tier) });
        if (t) trainersOut.push({
          session, name: presence ? '' : a.name, label: presence ? '' : trainerLabel(a.name, session, census),
          labelColor: colorForAgent(a.name, slot, config),
          role: resolveSprite(a.name, config),
          color: presence ? colorForAgent(a.name, slot, config) : (config?.agents?.[a.name]?.color ?? null),
          slot, x: t.x, y: t.y, dir: t.dir, status: t.status,
          caption: presence ? null : captionFor(t, a), phaseMs: frameClock.get(session) ?? 0,
        });
        for (const fx of fxByAgent.get(session) ?? []) celebrations.push({ session, x: fx.x, y: fx.y, progress: celebrationProgress(fx, now) });
      }
      desks.sort((p, q) => p.slot - q.slot);
      return {
        project, hour: hour == null ? 12 : hour,
        desks, trainers: trainersOut, celebrations,
        events: pendingEvents.splice(0),
        overflow: assignment.overflow.length,
      };
    },

    tickStats(now) { tickStats(now); },

    // Decoupled reap entry point: no sim tick, no render — safe (and intended)
    // to call for rooms that are hidden or idle-paused, since those are exactly
    // the rooms whose tickSim/render never run and so could otherwise never
    // reap a ghost agent. Callers should throttle (45min threshold doesn't need
    // per-frame precision); see main.mjs's lastReapCheck.
    reapTick(nowMs) { doReap(nowMs); },

    // Every accessor below takes a SESSION id, not a display name. `nameOf`
    // is the bridge back to something a human can read.
    agentSessions() { return Object.keys(world.agents); },

    agentCount() { return Object.keys(world.agents).length; },

    nameOf(session) { return world.agents[session]?.name ?? ''; },

    isMain(session) { return world.agents[session]?.main === true; },

    // The addressable session for this room: the main session, most recently
    // active if the rare concurrent case occurs. Teammates are never a target.
    mainSession() {
      let best = null;
      for (const a of Object.values(world.agents)) {
        if (!a.main) continue;
        if (!best || (a.lastEventTs ?? 0) > (best.lastEventTs ?? 0)) best = a;
      }
      return best ? best.session : null;
    },

    // Escape hatch: a main session is reap-exempt for 72h, so one whose
    // SessionEnd never arrived would sleep in the barracks until then. This
    // removes it by hand.
    dismiss(session) {
      if (!world.agents[session]) return false;
      const agents = { ...world.agents };
      delete agents[session];
      world = { agents };
      purgeAgent(session);
      recomputeDesks();
      return true;
    },

    feedFor(session) { return feeds.get(session) ?? []; },

    statusOf(session) { const t = trainers.get(session); return t ? t.status : (world.agents[session] ? 'idle' : ''); },

    positionOf(session) { const t = trainers.get(session); return t ? { x: t.x, y: t.y } : null; },

    statsFor(session) { return stats.bySession[session] ?? null; },

    agentAtPoint(canvas, clientX, clientY) {
      const manifest = deps.manifest;
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width ? canvas.width / rect.width : 1;
      const sy = rect.height ? canvas.height / rect.height : 1;
      const cx = (clientX - rect.left) * sx;
      const cy = (clientY - rect.top) * sy;
      const { scale, ox, oy } = viewTransform(canvas, manifest);
      const px = (cx - ox) / scale;
      const py = (cy - oy) / scale;
      const slot = deskSlotAt(px, py);
      return slot == null ? null : agentAtSlot(slot);
    },

    // Shared by 2D (agentAtPoint) and 3D (ray picking) so both resolve a desk
    // the same way.
    agentAtSlot(slot) { return agentAtSlot(slot); },
  };
}
