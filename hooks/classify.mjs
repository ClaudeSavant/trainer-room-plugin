const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const COMMIT_RE = /\bgit\s+commit\b|\bgh\s+pr\s+create\b/;
const CHAT_DETAIL_CAP = 500;

function basename(p) {
  if (!p) return '';
  return p.split(/[\\/]/).pop();
}

function truncate(s, cap) {
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

// Deterministic, template-only — no LLM call here. Hooks run synchronously in
// the critical path of every tool call and must stay fast; free-text
// generation would add latency/cost to every single tool use.
const CASUAL_SUMMARY = {
  Bash: (input) => `Running: ${truncate(input.command ?? '', 60)}`,
  Grep: (input) => `Searching for "${truncate(input.pattern ?? '', 40)}"`,
  Read: (input) => `Reading ${basename(input.file_path) || 'a file'}`,
};

export function classify(payload) {
  const ev = payload?.hook_event_name;
  if (ev === 'SessionStart') return { type: 'agent_start', tool: null, path: null, summary: 'Arrived' };
  if (ev === 'SubagentStop') return { type: 'task_done', tool: null, path: null, summary: 'Finished a task' };
  if (ev === 'Stop') return { type: 'agent_stop', tool: null, path: null, summary: 'Idle' };
  if (ev === 'SessionEnd') return { type: 'agent_shutdown', tool: null, path: null, summary: 'Shut down' };
  if (ev !== 'PostToolUse') return null;

  const tool = payload.tool_name ?? null;
  const input = payload.tool_input ?? {};

  if (FILE_TOOLS.has(tool)) {
    const path = input.file_path ?? null;
    return { type: 'file_write', tool, path, summary: `Editing ${basename(path) || 'a file'}` };
  }
  if (tool === 'Bash' && COMMIT_RE.test(input.command ?? '')) {
    const pr = /\bgh\s+pr\s+create\b/.test(input.command);
    return { type: 'commit', tool, path: null, summary: pr ? 'Opening a PR' : 'Committing' };
  }
  if (tool === 'SendMessage') {
    const to = input.to ?? null;
    const msg = input.message;
    if (typeof msg === 'string' && msg.length > 0) {
      const detail = truncate(msg, CHAT_DETAIL_CAP);
      const preview = msg.length > 40 ? msg.slice(0, 39) + '…' : msg;
      return { type: 'chat', tool, path: null, to, detail, summary: to ? `→ ${to}: ${preview}` : preview };
    }
    return { type: 'chat', tool, path: null, to, detail: null, summary: to ? `Messaged ${to}` : 'Sent a message' };
  }

  const wording = CASUAL_SUMMARY[tool];
  const summary = wording ? wording(input) : `Running ${tool ?? 'a tool'}`;
  return { type: 'tool_call', tool, path: input.file_path ?? null, summary };
}
