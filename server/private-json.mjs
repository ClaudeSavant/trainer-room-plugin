// JSON files that hold secrets (share.json, labs.json): mode 0600 in a 0700
// directory, written to a temp file and renamed so a crash never leaves half a
// file, and the result carries 0600 even when an older 0644 file was there.
import { writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
