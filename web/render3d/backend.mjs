// Chooses the renderer for this page load (spec §7). 3D is the default; 2D runs
// on ?renderer=2d, without WebGL, when the 3D code fails to load, or after a
// WebGL context loss. Falling back is one-way for the page session.
export function chooseRenderer({ param, webgl }) {
  if (param === '2d') return { kind: '2d', reason: 'param' };
  if (!webgl) return { kind: '2d', reason: 'no-webgl' };
  return { kind: '3d' };
}

export function probeWebGL(doc = globalThis.document) {
  try {
    const c = doc.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

export async function loadRenderer({ param, webgl, importer = () => import('./renderer3d.mjs') }) {
  const choice = chooseRenderer({ param, webgl });
  if (choice.kind === '2d') return choice;
  try { return { kind: '3d', mod: await importer() }; }
  catch (error) { return { kind: '2d', reason: 'import-failed', error }; }
}

export function afterContextLoss(state) {
  return state.kind === '3d' ? { kind: '2d', reason: 'context-lost' } : state;
}

// The 2D state to switch to, or null when the page is already in 2D: a second
// cause (e.g. a context loss after an attach failure) must not switch or log again.
export function nextFallback(current, next) {
  return current.kind === '2d' ? null : next;
}

// Whether a room redraws through 2D this frame. `repaint` is set on every room
// at fallback: an idle room would otherwise keep its last 3D frame until an event.
export function wants2dDraw({ simulate, resized, repaint }) { return simulate || resized || repaint; }

// Console arguments announcing a 2D backend. The error (import or init failure)
// rides along so the cause of a fallback is never swallowed.
export function fallbackLogArgs(state) {
  return [`[trainer-room] renderer: 2d (${state.reason})`, state.error ?? ''];
}
