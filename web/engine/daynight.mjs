// Pure time-of-day lighting. hour is 0..24 (float). Interpolated between
// keyframes; wraps at 24. No Date/Math.random — hour is injected.
const KF = [
  { h: 0,    overlay: [10, 20, 60, 0.45],    sky: [20, 30, 70] },     // night
  { h: 5,    overlay: [10, 20, 60, 0.45],    sky: [20, 30, 70] },     // night holds til 5am
  { h: 7,    overlay: [255, 160, 90, 0.22],  sky: [250, 180, 140] },  // dawn
  { h: 9,    overlay: [255, 255, 255, 0.02], sky: [150, 205, 245] },  // day
  { h: 16,   overlay: [255, 255, 255, 0.02], sky: [150, 205, 245] },  // day
  { h: 18.5, overlay: [255, 120, 60, 0.28],  sky: [255, 150, 90] },   // dusk
  { h: 20.5, overlay: [10, 20, 60, 0.45],    sky: [20, 30, 70] },     // night
  { h: 24,   overlay: [10, 20, 60, 0.45],    sky: [20, 30, 70] },     // wrap anchor == h0
];

const lerp = (a, b, t) => a + (b - a) * t;

export function lightingFor(hour) {
  let h = Number.isFinite(hour) ? hour : 12;
  h = ((h % 24) + 24) % 24;
  let i = 0;
  while (i < KF.length - 1 && !(h >= KF[i].h && h < KF[i + 1].h)) i++;
  const a = KF[i], b = KF[Math.min(i + 1, KF.length - 1)];
  const span = b.h - a.h || 1;
  const t = (h - a.h) / span;
  return {
    overlay: [
      Math.round(lerp(a.overlay[0], b.overlay[0], t)),
      Math.round(lerp(a.overlay[1], b.overlay[1], t)),
      Math.round(lerp(a.overlay[2], b.overlay[2], t)),
      lerp(a.overlay[3], b.overlay[3], t),
    ],
    sky: [
      Math.round(lerp(a.sky[0], b.sky[0], t)),
      Math.round(lerp(a.sky[1], b.sky[1], t)),
      Math.round(lerp(a.sky[2], b.sky[2], t)),
    ],
  };
}

export function phaseLabel(hour) {
  const h0 = Number.isFinite(hour) ? hour : 12;
  const h = ((h0 % 24) + 24) % 24;
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}
