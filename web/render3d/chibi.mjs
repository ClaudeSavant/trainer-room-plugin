// Faceted chibi trainers (owner ruling: style B). Geometry is module-level and
// shared by every trainer; materials come from the shared cache.
import * as THREE from '../vendor/three.module.min.js';

export const OUTFITS = {
  professor: { shirt: '#f4f4f0', pants: '#5b5f6b', hair: '#c9c9c9', skin: '#f2c29b', coat: true, accent: '#3b7dd8' },
  'dev-a': { shirt: '#3b7dd8', pants: '#2f3e66', hair: '#5a3a22', skin: '#e8b48a', hat: '#d9453b' },
  'dev-b': { shirt: '#4caf6a', pants: '#3a3a48', hair: '#1e1e24', skin: '#c98d62', hood: true },
  reviewer: { shirt: '#8e5bd1', pants: '#2d2d3a', hair: '#b0552e', skin: '#f6d2b0', glasses: true },
  npc: { shirt: '#9aa3ad', pants: '#4a4f5a', hair: '#5a3a22', skin: '#e8b48a' },
};

// ~1.3x the brainstorm mockup's 0.78, which read too small at full-room framing.
export const TRAINER_SCALE = 1.0;
export const HEAD_Y = 1.38; // skull centre height above the root

// A sleeper's head may sink this far below its back into the pillow: the
// sheet top (0.45) less the bunk frame top (0.35), less a hair.
const HEAD_SINK = 0.09;

export function outfitFor(role, color = null) {
  const base = OUTFITS[role] ?? OUTFITS.npc;
  return color ? { ...base, shirt: color } : base;
}

// Pure pose curve, kept apart from the meshes so it is testable.
export function poseFor(status, timeMs) {
  const t = timeMs / 1000;
  if (status === 'walking') {
    const s = Math.sin(t * 9) * 0.6;
    return { leg: s, armL: -s, armR: s, bob: Math.abs(Math.sin(t * 9)) * 0.04, lying: false };
  }
  if (status === 'working' || status === 'producing') {
    const ty = Math.sin(t * 14) * 0.15;
    return { leg: 0, armL: -1.1 + ty, armR: -1.1 - ty, bob: 0, lying: false };
  }
  if (status === 'sleeping') return { leg: 0, armL: 0, armR: 0, bob: 0, lying: true };
  return { leg: 0, armL: 0, armR: 0, bob: Math.max(0, Math.sin(t * 2)) * 0.02, lying: false };
}

const G = {
  leg: new THREE.CylinderGeometry(0.1, 0.09, 0.4, 6),
  arm: new THREE.CylinderGeometry(0.075, 0.07, 0.4, 5),
  body: new THREE.CylinderGeometry(0.22, 0.32, 0.55, 7),
  coat: new THREE.CylinderGeometry(0.22, 0.4, 0.7, 7),
  head: new THREE.IcosahedronGeometry(0.42, 2),
  eye: new THREE.SphereGeometry(0.06, 5, 4),
  mouth: new THREE.BoxGeometry(0.1, 0.03, 0.02),
  hair: new THREE.SphereGeometry(0.46, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.52),
  cap: new THREE.CylinderGeometry(0.42, 0.47, 0.2, 9),
  brim: new THREE.BoxGeometry(0.6, 0.05, 0.3),
  hood: new THREE.SphereGeometry(0.5, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.6),
  lens: new THREE.TorusGeometry(0.09, 0.02, 4, 8),
  tie: new THREE.BoxGeometry(0.08, 0.3, 0.02),
  shadow: new THREE.CircleGeometry(0.45, 16),
};

function part(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}
// Limbs hang from a pivot at the hip/shoulder so rotation.x swings them.
function limb(geo, mat, pivotY, x) {
  const p = new THREE.Group();
  p.position.set(x, pivotY, 0);
  p.add(part(geo, mat, 0, -0.2, 0));
  return p;
}

// Renderer teardown: the 3D path is one-way, so nothing builds from G again.
export function disposeSharedChibi() { for (const g of Object.values(G)) g.dispose(); }

export function createChibi(outfit, mats) {
  const root = new THREE.Group();   // placed and turned by the room scene
  const body = new THREE.Group();   // bobs, and tips over when lying down
  body.name = 'body';
  const shadow = new THREE.Mesh(G.shadow, mats.shadow());
  shadow.name = 'shadow';
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  root.add(shadow, body);

  const legs = [-0.12, 0.12].map((x) => limb(G.leg, mats.std(outfit.pants), 0.42, x));
  const arms = [-0.3, 0.3].map((x) => {
    const a = limb(G.arm, mats.std(outfit.shirt), 0.92, x);
    a.rotation.z = x > 0 ? 0.25 : -0.25;
    return a;
  });
  body.add(...legs, ...arms);
  const torso = outfit.coat ? part(G.coat, mats.std(outfit.shirt), 0, 0.68) : part(G.body, mats.std(outfit.shirt), 0, 0.7);
  torso.name = 'torso';
  body.add(torso);
  if (outfit.coat) {
    const tie = part(G.tie, mats.std(outfit.accent), 0, 0.78, 0.27);
    tie.rotation.x = -0.25;
    body.add(tie);
  }
  // The head and its gear move together so a sleeper's pillow can lift them
  // without tilting the body.
  const head = new THREE.Group();
  head.name = 'head';
  body.add(head);
  // Smooth-shaded, slightly self-lit skin: flat facets under a brown ground
  // light made the lower face read as a beard in the mockups.
  head.add(part(G.head, mats.std(outfit.skin, { flat: false, emissive: outfit.skin, emissiveIntensity: 0.18, roughness: 0.8 }), 0, HEAD_Y));
  for (const x of [-0.14, 0.14]) head.add(part(G.eye, mats.std('#1a1a2e'), x, HEAD_Y, 0.38));
  head.add(part(G.mouth, mats.std('#8a3a30'), 0, 1.22, 0.4));
  const hair = part(G.hair, mats.std(outfit.hair), 0, 1.45, -0.06);
  hair.rotation.x = -0.3;
  head.add(hair);
  if (outfit.hat) {
    head.add(part(G.cap, mats.std(outfit.hat), 0, 1.72));
    head.add(part(G.brim, mats.std(outfit.hat), 0, 1.64, 0.42));
  }
  if (outfit.hood) {
    const hood = part(G.hood, mats.std(outfit.shirt), 0, 1.3, -0.12);
    hood.rotation.x = -1.1;
    head.add(hood);
  }
  if (outfit.glasses) for (const x of [-0.15, 0.15]) head.add(part(G.lens, mats.std('#111111'), x, 1.38, 0.4));
  // Lying flat (owner ruling: at most 3 degrees of tilt). The big head and its
  // gear reach further behind the body than the torso does, so the body is
  // lifted until the torso's back, not the head, sits at the root's origin
  // (the sheet), and the pillow lifts the head just far enough that its
  // lowest point sinks no more than HEAD_SINK below the back. A lift, not a
  // nod: nodding swings the head toward the feet and off the pillow.
  // Measured once here because the head gear and torso differ per outfit.
  body.rotation.x = -Math.PI / 2;
  root.updateMatrixWorld(true);
  const backBox = new THREE.Box3();
  for (const o of body.children) if (o !== head) backBox.expandByObject(o, true);
  const lieLift = -backBox.min.y;
  const headLow = new THREE.Box3().setFromObject(head, true).min.y;
  const headRaise = Math.max(0, backBox.min.y - HEAD_SINK - headLow);
  body.rotation.x = 0;
  root.scale.setScalar(TRAINER_SCALE);

  function applyPose(p) {
    legs[0].rotation.x = p.leg;
    legs[1].rotation.x = -p.leg;
    arms[0].rotation.x = p.armL;
    arms[1].rotation.x = p.armR;
    body.position.y = p.lying ? lieLift : p.bob;
    // Lying: face up, head toward -Z in root space; the room scene turns the
    // root so the head lands on the bunk's pillow and lifts the root to the
    // mattress top.
    body.rotation.x = p.lying ? -Math.PI / 2 : 0;
    head.position.z = p.lying ? headRaise : 0; // body +Z is up when lying
    shadow.visible = !p.lying;
  }
  return { root, legs, arms, applyPose };
}
