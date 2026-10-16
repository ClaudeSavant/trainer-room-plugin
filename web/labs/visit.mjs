// One visit to one lab (spec §5, in-app): the bridge's relay stream → the
// Part 1 counts adapter → synthetic room events, keyed apart from the owner's
// own rooms, plus the header status. Pure apart from the injected client,
// timers and document.
import { createCountsAdapter, statusView, KEEPALIVE_MS } from '../viewer/adapter.mjs';
import { startKeepalive } from '../viewer/keepalive.mjs';
import { visitKey, roomOfVisitKey } from './switcher.mjs';

export function startVisit({
  query, client, onEvents, onStatus,
  doc = globalThis.document, setIv = setInterval, clearIv = clearInterval,
  adapter = createCountsAdapter(),
}) {
  let stopped = false;
  const emit = (events) => {
    if (stopped || events.length === 0) return;
    onEvents(events.map((e) => ({ ...e, project: visitKey(e.project) })));
  };
  onStatus(statusView(null));
  const stopWatch = client.watch(query, (state) => {
    if (stopped) return;
    // Unreachable: we don't know, so keep the last rooms on screen.
    if (!state?.unreachable) emit(adapter.update(state && state.online ? state.rooms : []));
    onStatus(statusView(state));
  });
  const stopKeepalive = startKeepalive({ adapter, feed: emit, ms: KEEPALIVE_MS, doc, setIv, clearIv });
  return {
    labelOf: (key) => adapter.labelOf(roomOfVisitKey(key)),
    stop() {
      if (stopped) return;
      stopped = true;
      stopWatch();
      stopKeepalive();
    },
  };
}
