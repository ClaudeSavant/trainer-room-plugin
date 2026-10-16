// Where Trainer Room keeps per-user state: share.json, labs.json and, for a
// plugin install, events.jsonl. TRAINER_ROOM_HOME overrides it, which is how
// tests stay away from the owner's real files.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function trainerRoomHome(env = process.env) {
  return env.TRAINER_ROOM_HOME || join(homedir(), '.trainer-room');
}

// A plugin install has no checkout to write into (Claude Code replaces the
// plugin's folder on every update), so the plugin's hooks pass --plugin and
// write under the home. A manual install keeps writing next to the code.
export function eventsPathFor({ argv = [], env = process.env, repoRoot }) {
  if (env.TRAINER_ROOM_EVENTS) return env.TRAINER_ROOM_EVENTS;
  if (argv.includes('--plugin')) return join(trainerRoomHome(env), 'events.jsonl');
  return join(repoRoot, 'events.jsonl');
}
