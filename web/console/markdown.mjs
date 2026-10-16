// README -> a small node tree for the README popup. Pure: no DOM here. main.mjs
// builds elements from it with createElement(tag) + textContent ONLY, so README
// content can never inject markup. The tag set is closed (ALLOWED_TAGS); raw
// HTML lines, images and rules are dropped, links render as their text.
export const ALLOWED_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'em', '#text']);

// Every class is length-bounded so unclosed openers cannot cause quadratic scans.
const INLINE_RE = /`([^`]{1,500})`|\*\*([^*]{1,500})\*\*|__([^_]{1,500})__|\*([^*\s][^*]{0,499})\*|!\[[^\]]{0,200}\]\([^)]{0,500}\)|\[([^\]]{1,200})\]\([^)]{0,500}\)/g;

function inline(s) {
  const out = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    if (m.index > last) out.push({ tag: '#text', text: s.slice(last, m.index) });
    if (m[1] != null) out.push({ tag: 'code', text: m[1] });
    else if (m[2] != null || m[3] != null) out.push({ tag: 'strong', text: m[2] ?? m[3] });
    else if (m[4] != null) out.push({ tag: 'em', text: m[4] });
    else if (m[5] != null) out.push({ tag: '#text', text: m[5] });
    // else: image -> dropped
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ tag: '#text', text: s.slice(last) });
  return out;
}

// Linear strip of an optional closing run of '#' (only when preceded by whitespace).
function stripClosing(r) {
  let e = r.length;
  while (e > 0 && r[e - 1] === '#') e--;
  return e < r.length && (e === 0 || /\s/.test(r[e - 1])) ? r.slice(0, e).trimEnd() : r;
}

export function parseMarkdown(md) {
  if (typeof md !== 'string' || !md) return [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { out.push({ tag: 'p', children: inline(para.join(' ')) }); para = []; } };
  const flushList = () => { if (list) { out.push(list); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const fence = /^(```|~~~)/.exec(t);
    if (fence) {
      flushPara(); flushList();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push({ tag: 'pre', children: [{ tag: 'code', text: body.join('\n') }] });
      continue;
    }
    if (!t) { flushPara(); flushList(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { flushPara(); flushList(); out.push({ tag: `h${h[1].length}`, children: inline(stripClosing(h[2])) }); continue; }
    if (t.startsWith('<') || /^!\[[^\]]*\]\([^)]*\)$/.test(t) || t.startsWith('[![')) { flushPara(); continue; }
    if (/^([-*_]\s*){3,}$/.test(t)) { flushPara(); flushList(); continue; }
    const li = /^([-*+]|\d+[.)])\s+(.*)$/.exec(t);
    if (li) {
      flushPara();
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, children: [] }; }
      list.children.push({ tag: 'li', children: inline(li[2]) });
      continue;
    }
    if (list && /^\s+/.test(line)) {
      list.children[list.children.length - 1].children.push({ tag: '#text', text: ' ' }, ...inline(t));
      continue;
    }
    flushList();
    para.push(t.replace(/^>\s?/, ''));
  }
  flushPara(); flushList();
  return out;
}
