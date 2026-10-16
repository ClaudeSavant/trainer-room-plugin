export const SPEED = 60;          // px per second
export const PRODUCE_MS = 450;    // pop duration
export const IDLE_AFTER_MS = 4000;
// total ms of no events (since last work) before walking to bed; spans the 4s idle-grace + the lull
export const SLEEPY_AFTER_MS = 20000;
const ARRIVE_EPS = 0.5;

export function createTrainer(name, spawn) {
  return {
    name, x: spawn.x, y: spawn.y, dir: 'down',
    status: 'idle', target: null, pendingProduce: false,
    produceTimer: 0, sinceWork: 0, pendingSleep: false,
  };
}

function atDesk(t, desk) {
  return Math.hypot(desk.x - t.x, desk.y - t.y) <= ARRIVE_EPS;
}

export function onEvent(t, ev, desk) {
  const n = { ...t };
  if (ev.type === 'agent_start') {
    n.pendingSleep = false;
    return n;
  }
  if (ev.type === 'agent_stop') {
    n.sinceWork = IDLE_AFTER_MS;
    return n;
  }
  // A synthetic keepalive (visited labs) keeps a trainer at its desk without the pop.
  if (ev.type === 'presence') {
    n.sinceWork = 0;
    n.pendingSleep = false;
    n.target = { x: desk.x, y: desk.y };
    if (atDesk(n, desk)) { if (n.status !== 'producing') n.status = 'working'; }
    else { n.status = 'walking'; }
    return n;
  }
  // work-producing events: tool_call | file_write | task_done | commit
  n.sinceWork = 0;
  n.pendingSleep = false;
  n.target = { x: desk.x, y: desk.y };
  if (atDesk(n, desk)) {
    n.status = 'producing';
    n.produceTimer = PRODUCE_MS;
    n.pendingProduce = false;
  } else {
    n.status = 'walking';
    n.pendingProduce = true;
  }
  return n;
}

export function tick(t, dtMs, desk, bed) {
  const n = { ...t };
  const dt = dtMs / 1000;

  if (n.status === 'walking' && n.target) {
    const dx = n.target.x - n.x;
    const dy = n.target.y - n.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) {
      n.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
    const step = SPEED * dt;
    if (dist === 0) {
      if (n.pendingSleep) { n.status = 'sleeping'; n.pendingSleep = false; }
      else if (n.pendingProduce) { n.status = 'producing'; n.produceTimer = PRODUCE_MS; n.pendingProduce = false; }
      else { n.status = 'working'; }
    } else if (dist <= step) {
      n.x = n.target.x; n.y = n.target.y; // snap to desk; transition on next tick
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
    if (n.status === 'idle' && bed && n.sinceWork >= SLEEPY_AFTER_MS) {
      n.target = { x: bed.x, y: bed.y };
      n.status = 'walking';
      n.pendingSleep = true;
    }
    return n;
  }

  if (n.status === 'sleeping') return n; // resting

  return n; // offline
}

export function frameFor(status, dtAccumMs) {
  if (status === 'walking') return Math.floor(dtAccumMs / 150) % 4;
  if (status === 'working' || status === 'producing') return Math.floor(dtAccumMs / 250) % 2;
  return 0; // idle / offline / sleeping
}
