export function bubbleBox(text, anchorX, anchorY, opts = {}) {
  const { charW = 6, padX = 4, padY = 3, lineH = 10, gap = 14 } = opts;
  const w = text.length * charW + 2 * padX;
  const h = lineH + 2 * padY;
  return { x: anchorX - w / 2, y: anchorY - gap - h, w, h };
}

export function drawBubble(ctx, text, anchorX, anchorY, opts = {}) {
  const b = bubbleBox(text, anchorX, anchorY, opts);
  ctx.save();
  ctx.fillStyle = '#f8f8f8';
  ctx.fillRect(b.x, b.y, b.w, b.h);            // pixel box (no anti-aliased radius)
  ctx.fillStyle = '#f8f8f8';                   // little tail under the box
  ctx.beginPath();
  ctx.moveTo(anchorX - 3, b.y + b.h);
  ctx.lineTo(anchorX + 3, b.y + b.h);
  ctx.lineTo(anchorX, b.y + b.h + 4);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#1a1f2b';
  ctx.font = '8px ui-monospace'; ctx.textAlign = 'center';
  ctx.fillText(text, anchorX, b.y + b.h - 5);
  ctx.restore();
}
