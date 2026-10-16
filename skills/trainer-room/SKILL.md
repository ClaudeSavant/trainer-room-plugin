---
name: trainer-room
description: Open the Trainer Room lab view, starting its local bridge if needed. Also /trainer-room status and /trainer-room stop.
argument-hint: "[status|stop]"
disable-model-invocation: true
allowed-tools: Bash(node *)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/trainer-room.mjs" $ARGUMENTS`

Tell the user the result above in one short line, keeping any URL exactly as printed. Do not run anything else.
