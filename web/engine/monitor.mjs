// Desk monitor colour, shared by the 2D and 3D renderers so a screen can never
// read differently depending on which one drew it. Off while idle; a hard
// step blink (no fade) while working, offset per desk slot so a room does not
// flash in unison. Driven by the render clock: no per-monitor timers.
export const SCREEN = { off: '#0b0d12', bright: '#bff3ff', dim: '#4fb8d8' };
export const BLINK_MS = 900;
export const PHASE_STEP_MS = 150;

export function screenColor({ active, now, slot = 0, reducedMotion = false }) {
  if (!active) return SCREEN.off;
  if (reducedMotion) return SCREEN.bright;
  return Math.floor((now + slot * PHASE_STEP_MS) / (BLINK_MS / 2)) % 2 === 0 ? SCREEN.bright : SCREEN.dim;
}
