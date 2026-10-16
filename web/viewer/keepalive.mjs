// Keeps visitors at their desks: a timer (rAF stops in background tabs) plus an
// immediate beat when a throttled hidden tab becomes visible again.
export function startKeepalive({ adapter, feed, ms, doc = document, setIv = setInterval, clearIv = clearInterval }) {
  const beat = () => feed(adapter.keepalive());
  const id = setIv(beat, ms);
  const onVis = () => { if (doc.visibilityState === 'visible') beat(); };
  doc.addEventListener('visibilitychange', onVis);
  return () => { clearIv(id); doc.removeEventListener('visibilitychange', onVis); };
}
