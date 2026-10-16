// Which of a shared lab's rooms the hosted viewer shows: the grid ('all') or one
// room filling the window, as in the app. Pure: no DOM.
export const ALL = 'all';

// A room that left the screen (emptied, or the lab went offline) drops the
// visitor back to the grid rather than a blank page.
export function resolveView(viewMode, shown) {
  return viewMode && viewMode !== ALL && shown.includes(viewMode) ? viewMode : ALL;
}

export function visibleIds(viewMode, shown) {
  return viewMode === ALL ? shown : shown.filter((id) => id === viewMode);
}

export function tabItems(shown, viewMode, labelOf, countOf) {
  return [
    { id: ALL, label: 'All', active: viewMode === ALL },
    ...shown.map((id) => ({ id, label: `${labelOf(id)} (${countOf(id)})`, active: viewMode === id })),
  ];
}
