#!/usr/bin/env node
// /trainer-room [status|stop] — see server/launcher.mjs. runCli turns every
// outcome it can explain into plain lines (exit 0); anything else is a crash.
import { runCli } from '../server/launcher.mjs';

try {
  for (const line of await runCli(process.argv.slice(2))) console.log(line);
} catch (err) {
  console.log(`Trainer Room launcher failed: ${err?.message ?? err}`);
  process.exit(1);
}
