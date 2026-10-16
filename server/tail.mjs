import { openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';

export function tailLines(path, onLine, { intervalMs = 100 } = {}) {
  // Start at the current end of file: the bridge tails a log that already holds
  // tens of thousands of historical events, and replaying them on startup fills
  // the room with month-old agents that then have to be reaped. A file that does
  // not exist yet stays at 0, so everything written to it counts as new.
  //
  // The size below ignores whether the file ends on a newline. If the log ends
  // mid-record at startup - a writer's append caught in flight - offset lands
  // inside that record, and the next poll emits only its trailing fragment as
  // though it were a whole line. The sole consumer (server/bridge.mjs) parses
  // each line inside a try/catch, so such a fragment is dropped as unparseable
  // rather than faulting.
  let offset = existsSync(path) ? statSync(path).size : 0;
  let buffer = '';

  function poll() {
    try {
      if (!existsSync(path)) return;
      const size = statSync(path).size;
      if (size < offset) { offset = 0; buffer = ''; } // truncated/rotated
      if (size === offset) return;
      const fd = openSync(path, 'r');
      try {
        const len = size - offset;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, offset);
        offset = size;
        buffer += buf.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length) onLine(line);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      /* transient read error: try again next interval */
    }
  }

  const timer = setInterval(poll, intervalMs);
  poll();
  return function stop() { clearInterval(timer); };
}
