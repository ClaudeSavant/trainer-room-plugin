// Pure gate for the console input. Commands are only available when exactly one
// project is in view, and the target is that project's main session — implied by
// the focus, never picked from a list.
export function consoleTarget({ viewMode = 'all', rooms = [] } = {}) {
  const off = (reason) => ({ enabled: false, project: null, session: null, label: '', reason });
  // Deliberate sentinel, and provably redundant with the `!room` guard below: no slug
  // can be 'all' (every slug starts with '-'; the degenerate cases are '(no project)'
  // and 'unknown'), so `find` would miss and return the same result. Kept because it
  // states the product rule at the top of the function, keeps the common all-view case
  // O(1) rather than an O(n) find, and short-circuits before `find` could throw on a
  // non-array. Mutation runs flag it as a survivor — that is expected. Don't delete it.
  if (viewMode === 'all') return off('Select a project to send commands.');
  const room = rooms.find((r) => r.key === viewMode);
  if (!room) return off('Select a project to send commands.');
  if (!room.mainSession) return off(`${room.label} has no main session running.`);
  const label = room.mainCount > 1
    ? `${room.mainName} ${room.mainShortId}`   // disambiguate the rare concurrent case
    : room.mainName;
  return { enabled: true, project: room.key, session: room.mainSession, label, reason: null };
}
