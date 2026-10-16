// Living camera (spec §4). Pure: no three.js, no DOM, no clock — `now` is
// injected (performance.now() timebase, same as the room's event timestamps).
export const HOME = Object.freeze({ tx: 10, ty: 0.4, tz: 6.6, az: 0, el: 0.72, dist: 21 });
export const LIMITS = Object.freeze({ elMin: 0.25, elMax: 1.35, distMin: 8, distMax: 32 });
export const SWAY = Object.freeze({ az: 0.18, el: 0.05, azPeriodMs: 50000, elPeriodMs: 70000 });
export const LEAN = Object.freeze({ toward: 0.4, distScale: 0.8, holdMs: 3000, everyMs: 4000, staleMs: 4000 });
export const IDLE_RESUME_MS = 8000;
export const EASE_MS = 450;
// Five ease time constants: under 1% of the gap is left, so the pose has settled.
export const SETTLE_MS = 5 * EASE_MS;
const QUEUE_CAP = 8;
const PRIORITY = { deliverable: 2, tool: 1 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Wrap an angle into (-π, π] so spinning never accumulates turns to unwind.
const wrapAngle = (a) => {
  const w = a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  return w <= -Math.PI ? w + 2 * Math.PI : w;
};
const prio = (e) => PRIORITY[e.kind] ?? 0;

export function createDirector(home = HOME) {
  return { home: { ...home }, pose: { ...home }, queue: [], lean: null, lastLeanAt: -Infinity, lastInputAt: -Infinity, manual: false };
}

export function cameraPosition(pose) {
  return {
    x: pose.tx + Math.sin(pose.az) * Math.cos(pose.el) * pose.dist,
    y: pose.ty + Math.sin(pose.el) * pose.dist,
    z: pose.tz + Math.cos(pose.az) * Math.cos(pose.el) * pose.dist,
  };
}

// Manual input moves the pose directly (no easing: it must feel attached to the
// pointer) and suspends the living behaviour.
function applyInput(s, input, now) {
  if (input.kind === 'reset') return { ...s, manual: false, lastInputAt: -Infinity, lean: null };
  const pose = { ...s.pose };
  if (input.kind === 'orbit') {
    pose.az = wrapAngle(pose.az + (input.dAz ?? 0));
    pose.el = clamp(pose.el + (input.dEl ?? 0), LIMITS.elMin, LIMITS.elMax);
  } else if (input.kind === 'zoom') {
    pose.dist = clamp(pose.dist * (input.factor ?? 1), LIMITS.distMin, LIMITS.distMax);
  } else return s;
  return { ...s, pose, manual: true, lastInputAt: now, lean: null };
}

// When the camera has settled after this input: a reset eases home at once; an
// orbit or zoom holds for IDLE_RESUME_MS and then eases home. The renderer keeps
// drawing an otherwise idle room until then, so the motion plays out in full.
export function settledBy(input, now) {
  return now + (input.kind === 'reset' ? 0 : IDLE_RESUME_MS) + SETTLE_MS;
}

// Freshest highest-priority event; stale ones are dropped so the camera never
// leans at something that happened long ago.
function pickLean(queue, now) {
  const fresh = queue.filter((e) => now - e.ts <= LEAN.staleMs);
  if (!fresh.length) return { pick: null, rest: [] };
  let best = fresh[0];
  for (const e of fresh) if (prio(e) > prio(best) || (prio(e) === prio(best) && e.ts > best.ts)) best = e;
  return { pick: best, rest: fresh.filter((e) => e !== best) };
}

export function stepDirector(s, { now, dt = 16, events = [], input = null, mode = 'single', reducedMotion = false, positionOf = () => null } = {}) {
  // The "All" grid is a calm overview: every room sits at home, ignoring input.
  if (mode === 'grid') return { ...s, pose: { ...s.home }, queue: [], lean: null, manual: false, lastInputAt: -Infinity };
  let st = input ? applyInput(s, input, now) : s;
  st = { ...st, queue: reducedMotion ? [] : [...st.queue, ...events].slice(-QUEUE_CAP) };
  if (st.manual && now - st.lastInputAt < IDLE_RESUME_MS) return st; // the user is driving
  st = { ...st, manual: false };
  const h = st.home;
  const goal = { ...h };
  let lean = st.lean;
  if (!reducedMotion) {
    goal.az += SWAY.az * Math.sin((2 * Math.PI * now) / SWAY.azPeriodMs);
    goal.el += SWAY.el * Math.sin((2 * Math.PI * now) / SWAY.elPeriodMs);
    if ((!lean || now >= lean.until) && now - st.lastLeanAt >= LEAN.everyMs) {
      lean = null;
      const { pick, rest } = pickLean(st.queue, now);
      st = { ...st, queue: rest };
      if (pick && positionOf(pick.session)) {
        lean = { session: pick.session, until: now + LEAN.holdMs };
        st = { ...st, lastLeanAt: now };
      }
    }
    if (lean && now < lean.until) {
      const p = positionOf(lean.session);
      if (p) {
        goal.tx = h.tx + (p.X - h.tx) * LEAN.toward;
        goal.tz = h.tz + (p.Z - h.tz) * LEAN.toward;
        goal.dist = h.dist * LEAN.distScale;
      } else lean = null; // that trainer left: go home rather than chase nothing
    }
  } else lean = null;
  // Frame-rate-independent exponential ease toward the goal.
  const k = 1 - Math.exp(-Math.max(0, dt) / EASE_MS);
  const pose = {};
  for (const key of Object.keys(h)) {
    // az takes the shortest way round, so a spun-out camera never whips back through its turns.
    const d = key === 'az' ? wrapAngle(goal.az - st.pose.az) : goal[key] - st.pose[key];
    pose[key] = st.pose[key] + d * k;
  }
  pose.az = wrapAngle(pose.az);
  return { ...st, lean, pose };
}
