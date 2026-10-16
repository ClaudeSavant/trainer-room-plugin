# Trainer Room

A live 3D lab of your Claude Code agents at work. Every session and subagent is a trainer
who walks to a desk, works, and heads off when it's done — one room per project. Share your
lab by link (room counts only) and visit other people's labs.

## Install
Needs Node 18+ on your PATH. In Claude Code:

    /plugin marketplace add ClaudeSavant/trainer-room-plugin
    /plugin install trainer-room@trainer-room

Then run `/trainer-room` in any session: it starts the local bridge in the background if it
isn't running and opens your lab at http://127.0.0.1:4123.

| Command | Effect |
|---|---|
| `/trainer-room` | start the bridge if needed and open the lab |
| `/trainer-room status` | is it running, and where |
| `/trainer-room stop` | stop the bridge |

The plugin registers its hooks for you. They write to `~/.trainer-room/events.jsonl`, next to
your sharing and lab settings; nothing leaves your machine unless you turn sharing on. Set
`TRAINER_ROOM_PORT` to use another port. After a plugin update, run `/trainer-room stop` and
then `/trainer-room` to pick up the new version.

To uninstall: `/trainer-room stop`, then `/plugin uninstall trainer-room@trainer-room` (the
hooks go with it). Your events and settings stay in `~/.trainer-room` until you delete it.

## The lab
- The rooms render in 3D (three.js, bundled — no npm install). In a single room the camera
  sways gently and leans toward whoever just acted; drag to orbit, scroll to zoom,
  double-click to snap home. `?renderer=2d` forces the pixel-art view, which is also the
  automatic fallback without WebGL.
- Click a trainer to open its desk terminal and see what it's been doing.
- The console beside the rooms tails every agent's activity. `/help` lists its commands.

## Share your lab
Let someone watch your lab live, with or without Trainer Room installed. Only **room
counts** leave your machine: your chosen display name, a public/private flag, secrets your
bridge generated, and `{ room: <random id>, n }` per active project. No names, paths,
captions, models, costs or timings are ever sent.

| Console command | Effect |
|---|---|
| `/share on <display name>` | start sharing; prints your invite link |
| `/share off` | stop; the link stops showing your lab |
| `/share public on\|off` | list or unlist in the public directory |
| `/share reset-link` | new link; the old one stops working |
| `/share` | show status and the link |

Your secrets and per-project room ids live in `~/.trainer-room/share.json` (mode 0600).

## Visit other labs
The lab menu sits left of the project tabs: **My lab**, your saved labs, **+ Add lab**
(paste an invite link) and **Browse public**. A visited lab shows presence only — generic
trainers in "Room 1, Room 2…", no names, captions, stats or terminals — and your own lab
keeps running in the background.

| Console command | Effect |
|---|---|
| `/lab add <invite link>` | save a lab and switch to it |
| `/lab` | list saved labs |
| `/lab <n>` · `/lab mine` | switch to saved lab *n* · back to your own |
| `/lab browse` | open the public directory |
| `/lab remove <n>` | forget a saved lab |

Saved labs live in `~/.trainer-room/labs.json` (mode 0600). Each visiting browser tab holds a
connection to your bridge, so keep visiting tabs to a few at a time.

## License
MIT — see `LICENSE`.
