// Text rules shared by the 2D and 3D renderers, so a caption or name label can
// never read differently depending on which renderer drew it.
export const CAPTION_MAX = 22;

export function trimCaption(s) {
  return s.length > CAPTION_MAX ? s.slice(0, CAPTION_MAX - 1) + '…' : s;
}

// Bubble text for a trainer, or null when no bubble should show: never over an
// idle trainer, a sleeper, or one already heading to bed.
export function captionFor(t, a) {
  if (!t || !a) return null;
  if (t.status === 'idle' || t.status === 'sleeping' || t.pendingSleep || !a.caption) return null;
  return trimCaption(a.caption);
}

// The human-readable name, plus the short session id only when another session
// holds the same name (sprite and colour key by name, so the pair would
// otherwise be indistinguishable). Same 8-char slice as the console placeholder.
export function trainerLabel(name, session, nameCounts) {
  return nameCounts.get(name) > 1 ? `${name} ${session.slice(0, 8)}` : name;
}

export function nameCensus(agents) {
  const counts = new Map();
  for (const a of Object.values(agents)) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  return counts;
}
