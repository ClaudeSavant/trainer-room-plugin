export const SPEED = 60;          // px per second
export const PRODUCE_MS = 450;    // pop duration
export const IDLE_AFTER_MS = 4000;
const ARRIVE_EPS = 0.5;

export function createTrainer(name, spawn) {
  return {
    name, x: spawn.x, y: spawn.y, dir: 'down',
    status: 'idle', path: [], pendingProduce: false,
    produceTimer: 0, sinceWork: 0,
  };
}

// Placed at the desk stand, standing still (no walk).
export function createSeated(name, stand) {
  return { ...createTrainer(name, stand), status: 'idle', sinceWork: IDLE_AFTER_MS };
}

// Walk the waypoints in order, ending at the desk (idle unless work arrives).
export function arrive(t, path) {
  return { ...t, status: 'walking', path: path.map((p) => ({ ...p })), sinceWork: IDLE_AFTER_MS };
}

// Walk the waypoints out of the room; status becomes 'gone' at the last one.
export function leave(t, path) {
  return { ...t, status: 'leaving', path: path.map((p) => ({ ...p })), pendingProduce: false };
}

export function isWorking(t) {
  return t.status === 'working' || t.status === 'producing';
}

function atDesk(t, desk) {
  return Math.hypot(desk.x - t.x, desk.y - t.y) <= ARRIVE_EPS;
}

export function onEvent(t, ev, desk) {
  const n = { ...t };
  if (ev.type === 'agent_start') return n;
  if (ev.type === 'agent_stop') {
    n.sinceWork = IDLE_AFTER_MS;
    return n;
  }
  if (n.status === 'leaving' || n.status === 'gone') return n;
  const walkingPath = n.path && n.path.length > 0;
  // A synthetic keepalive (visited labs) keeps a trainer at its desk without the pop.
  if (ev.type === 'presence') {
    n.sinceWork = 0;
    if (walkingPath) return n;
    if (atDesk(n, desk)) { if (n.status !== 'producing') n.status = 'working'; }
    else { n.path = [{ x: desk.x, y: desk.y }]; n.status = 'walking'; }
    return n;
  }
  // work-producing events: tool_call | file_write | task_done | commit
  n.sinceWork = 0;
  if (walkingPath) { n.pendingProduce = true; return n; }
  if (atDesk(n, desk)) {
    n.status = 'producing';
    n.produceTimer = PRODUCE_MS;
    n.pendingProduce = false;
  } else {
    n.path = [{ x: desk.x, y: desk.y }];
    n.status = 'walking';
    n.pendingProduce = true;
  }
  return n;
}

export function tick(t, dtMs, desk) {
  const n = { ...t };
  const dt = dtMs / 1000;

  if (n.status === 'walking' || n.status === 'leaving') {
    n.path = n.path ? [...n.path] : [];
    if (n.path.length === 0) {
      if (n.status === 'leaving') n.status = 'gone';
      else if (n.pendingProduce) { n.status = 'producing'; n.produceTimer = PRODUCE_MS; n.pendingProduce = false; }
      else n.status = n.sinceWork >= IDLE_AFTER_MS ? 'idle' : 'working';
      return n;
    }
    const target = n.path[0];
    const dx = target.x - n.x;
    const dy = target.y - n.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) {
      n.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
    const step = SPEED * dt;
    if (dist <= step) {
      n.x = target.x; n.y = target.y; // snap to the waypoint; next one (or the end) on the next tick
      n.path.shift();
    } else {
      n.x += (dx / dist) * step;
      n.y += (dy / dist) * step;
    }
    return n;
  }

  if (n.status === 'producing') {
    n.produceTimer -= dtMs;
    if (n.produceTimer <= 0) { n.status = 'working'; n.sinceWork = 0; }
    return n;
  }

  if (n.status === 'working' || n.status === 'idle') {
    n.sinceWork += dtMs;
    if (n.status === 'working' && n.sinceWork >= IDLE_AFTER_MS) n.status = 'idle';
    return n;
  }

  return n; // gone / offline
}

export function frameFor(status, dtAccumMs) {
  if (status === 'walking' || status === 'leaving') return Math.floor(dtAccumMs / 150) % 4;
  if (status === 'working' || status === 'producing') return Math.floor(dtAccumMs / 250) % 2;
  return 0; // idle / gone / offline
}
