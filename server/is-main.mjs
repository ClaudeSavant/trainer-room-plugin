// True when this module is the script node was started with. Compares real
// paths, so a symlinked checkout or tmpdir (macOS /var -> /private/var) still
// counts; any error (no argv[1], missing file, bad URL) means "not main".
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
