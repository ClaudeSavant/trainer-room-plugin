// 3D lighting from the same pure time-of-day curve as the 2D overlay wash
// (lightingFor), so both renderers agree on what "dusk" means.
import { lightingFor } from '../engine/daynight.mjs';

const NIGHT_ALPHA = 0.45; // lightingFor's full-night overlay alpha
const SUN_DAY = [255, 244, 224];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

// Light through the window: cool and dim at night, amber at dawn and dusk,
// warm white by day. lightingFor's overlay is a wash, not a light colour, so
// this has its own keyframes, timed to lightingFor's night (until 5, from
// 20.5), dawn (7) and dusk (18.5).
const WINDOW_KF = [
  { h: 0, rgb: [90, 110, 170] },
  { h: 5, rgb: [90, 110, 170] },
  { h: 6.75, rgb: [255, 176, 112] },
  { h: 8, rgb: [255, 241, 204] },
  { h: 17, rgb: [255, 241, 204] },
  { h: 18.5, rgb: [255, 154, 85] },
  { h: 20.5, rgb: [90, 110, 170] },
  { h: 24, rgb: [90, 110, 170] },
];

function windowLightColor(hour) {
  const h = (((Number.isFinite(hour) ? hour : 12) % 24) + 24) % 24;
  let i = 0;
  while (i < WINDOW_KF.length - 2 && h >= WINDOW_KF[i + 1].h) i++;
  const a = WINDOW_KF[i], b = WINDOW_KF[i + 1];
  return hex(mix(a.rgb, b.rgb, (h - a.h) / (b.h - a.h)));
}

export function lightingParams(hour) {
  const { overlay, sky } = lightingFor(hour);
  const dark = Math.min(1, overlay[3] / NIGHT_ALPHA);
  return {
    dark,
    sunColor: hex(mix(SUN_DAY, [overlay[0], overlay[1], overlay[2]], Math.min(1, overlay[3] * 1.6))),
    sunIntensity: 1.9 * (1 - 0.8 * dark),
    hemiIntensity: 1.15 * (1 - 0.55 * dark),
    windowColor: hex(sky),
    windowLight: 18 * (1 - 0.85 * dark),
    windowLightColor: windowLightColor(hour),
  };
}
