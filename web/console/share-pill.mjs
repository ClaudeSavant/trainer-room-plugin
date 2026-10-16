// Header pill text for the bridge's share status; null hides the pill.
// 'off' while enabled means the bridge is not actually publishing (e.g. an
// invalid saved name on resume), so it reads as stopped, never as live.
const TEXT = {
  live: 'Sharing',
  connecting: 'Sharing · connecting',
  retrying: 'Sharing · reconnecting',
  rejected: 'Sharing · stopped',
  off: 'Sharing · stopped',
};

export function sharePillText(status) {
  if (!status?.enabled) return null;
  return TEXT[status.relay] ?? 'Sharing';
}
