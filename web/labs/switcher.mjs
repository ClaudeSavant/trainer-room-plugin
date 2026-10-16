// Pure model for the lab switcher (sharing spec §5, in-app): which lab is on
// screen, what the menu lists, and how a visit is addressed to the bridge.
// No DOM, no network.
export const MINE = 'mine';

export function labLabel(lab, index) {
  return lab.name || `Lab ${index + 1}`;
}

export function labChoices(saved) {
  return saved.map((lab, i) => ({ id: lab.id, label: labLabel(lab, i) }));
}

export function activeLabel(active, saved) {
  if (active.kind === 'saved') {
    const i = saved.findIndex((l) => l.id === active.id);
    return i === -1 ? 'My lab' : labLabel(saved[i], i);
  }
  if (active.kind === 'public') return active.name || 'Public lab';
  return 'My lab';
}

export function watchQuery(active) {
  if (active.kind === 'saved') return `id=${encodeURIComponent(active.id)}`;
  if (active.kind === 'public') return `public=${encodeURIComponent(active.publicId)}`;
  return null;
}

export function menuItems(active, saved) {
  return [
    { type: 'mine', label: 'My lab', current: active.kind === MINE },
    ...saved.map((lab, i) => ({ type: 'saved', id: lab.id, label: labLabel(lab, i), current: active.kind === 'saved' && active.id === lab.id })),
    { type: 'add', label: '+ Add lab', current: false },
    { type: 'browse', label: 'Browse public', current: false },
  ];
}

// What the open menu shows, as one comparable string: the 15 s list poll
// rebuilds the menu (and drops keyboard focus) only when this changes.
export function menuSignature(active, saved) {
  return JSON.stringify(menuItems(active, saved));
}

// A saved lab that was removed (here or in another tab) falls back to mine.
export function reconcileActive(active, saved) {
  if (active.kind === 'saved' && !saved.some((l) => l.id === active.id)) return { kind: MINE };
  return active;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function directoryRows(list, saved) {
  const savedPublic = new Set(saved.filter((l) => l.kind === 'public').map((l) => l.publicId));
  return list.map((e) => ({
    publicId: e.publicId,
    name: e.name,
    online: e.online,
    detail: e.online ? `${plural(e.rooms, 'room')} · ${plural(e.agents, 'agent')}` : 'offline',
    saved: savedPublic.has(e.publicId),
  }));
}

// Visited rooms live beside the owner's own rooms; the prefix keeps their keys
// apart from project slugs in every shared map (3D renderer included).
const PREFIX = 'lab:';
export const visitKey = (room) => PREFIX + room;
export const isVisitKey = (key) => typeof key === 'string' && key.startsWith(PREFIX);
export const roomOfVisitKey = (key) => key.slice(PREFIX.length);
