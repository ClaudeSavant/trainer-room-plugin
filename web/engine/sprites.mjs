export function colorForAgent(name, deskIndex, config) {
  const conf = config?.agents?.[name];
  if (conf?.color) return conf.color;
  const pal = (config?.palette && config.palette.length) ? config.palette : ['#4aa3ff'];
  return pal[deskIndex % pal.length];
}

const TIER_COLOR = { token: '#cfd8e3', doc: '#8ecbff', parcel: '#d8a25a', deliverable: '#ffd24a' };

const ROLE_BY_NAME = {
  lead: 'professor', pm: 'professor',
  backend: 'dev-a', frontend: 'dev-b',
  reviewer: 'reviewer', 'codex-reviewer': 'reviewer',
};

export function resolveSprite(agentName, config) {
  const explicit = config?.agents?.[agentName]?.sprite;
  if (explicit) return explicit;
  return ROLE_BY_NAME[String(agentName).toLowerCase()] ?? 'npc';
}

export function frameRect(dir, frame, manifest) {
  const { frameW, frameH, dirs } = manifest.characters;
  const row = Math.max(0, dirs.indexOf(dir));
  return { sx: frame * frameW, sy: row * frameH, sw: frameW, sh: frameH };
}

export function drawTrainerShadow(ctx, t) {
  ctx.save();
  ctx.translate(t.x, t.y + 8); // feet
  ctx.scale(1, 0.42);          // flatten the disc into a ground ellipse
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 9);
  g.addColorStop(0, 'rgba(0,0,0,0.22)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

export function drawTrainer(ctx, t, { color, frame, sheet, dir, manifest } = {}) {
  ctx.save();
  ctx.translate(t.x, t.y);
  if (sheet && manifest) {
    const r = frameRect(dir ?? t.dir, frame ?? 0, manifest);
    ctx.drawImage(sheet, r.sx, r.sy, r.sw, r.sh, -r.sw / 2, -r.sh + 8, r.sw, r.sh);
  } else { // fallback (kept from v1 so early integration/tests still render)
    ctx.fillStyle = color || '#4aa3ff';
    ctx.fillRect(-7, -10, 14, 18);
  }
  ctx.restore();
}

export function drawItem(ctx, x, y, tier, opts = {}) {
  const { items, manifest } = opts;
  if (items && manifest?.items?.sprites?.[tier]) {
    const s = manifest.tileSize;
    const [c, r] = manifest.items.sprites[tier];
    ctx.drawImage(items, c * s, r * s, s, s, x - s / 2, y - s / 2, s, s);
    return;
  }
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = TIER_COLOR[tier] ?? '#fff';
  if (tier === 'deliverable') { // v1 parity: pokeball-ish round token
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
  } else {
    const sz = tier === 'parcel' ? 9 : tier === 'doc' ? 7 : 5;
    ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
  }
  ctx.restore();
}
