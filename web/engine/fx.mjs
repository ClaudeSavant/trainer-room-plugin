export function createCelebration(x, y, nowMs, DURATION = 700) {
  return { x, y, start: nowMs, DURATION };
}
export function celebrationProgress(fx, nowMs) {
  return Math.min(1, Math.max(0, (nowMs - fx.start) / fx.DURATION));
}
export function isExpired(fx, nowMs) { return celebrationProgress(fx, nowMs) >= 1; }

export function blinkOn(periodMs, nowMs, phase = 0) {
  return ((nowMs + phase) % periodMs) < periodMs / 2;
}

export function drawCelebration(ctx, fx, nowMs) {
  const p = celebrationProgress(fx, nowMs);
  ctx.save();
  ctx.globalAlpha = 1 - p;
  ctx.translate(fx.x, fx.y - p * 12);          // pokeball rises
  ctx.fillStyle = '#ffd24a';
  for (let i = 0; i < 4; i++) {                 // 4 sparkles expanding outward
    const a = (i / 4) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * p * 10, Math.sin(a) * p * 10, 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
