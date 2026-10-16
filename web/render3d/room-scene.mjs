// One room's three.js scene, kept in step with its snapshot each frame. Desks
// and trainers are created on arrival and removed on departure; the lab is
// built once. No WebGL here, so the whole sync is testable in node.
import * as THREE from '../vendor/three.module.min.js';
import { deskRect } from '../engine/layout.mjs';
import { labLayout, DESK_TOP_Y } from './lab-layout.mjs';
import { buildLab, disposeLab, updateLabFx } from './lab.mjs';
import { createDesk } from './desks.mjs';
import { createChibi, outfitFor, poseFor, TRAINER_SCALE } from './chibi.mjs';
import { createCelebration3d } from './fx3d.mjs';
import { lightingParams } from './lighting.mjs';
import { pxToWorld, yawFor, TILE_PX } from './coords.mjs';

// A lying chibi's back sits at its root's origin (chibi.mjs; the head may sink lower into the pillow), so
// the root goes on the bunk sheet's top (0.45), plus a hair against z-fighting.
const LYING_Y = 0.46;
// Feet sit this far +X of the lie point (the bunk centre): a flat sleeper is
// 1.89 long head gear to toes, so this centres it on the 1.8 frame.
export const LYING_SHIFT = 0.965;
const DESK_HALF_D = deskRect(0).h / TILE_PX / 2;

export function createRoomScene(mats, layout = labLayout()) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1d2230');
  const lab = buildLab(layout, mats);
  scene.add(lab.group);

  const cx = layout.cols / 2, cz = layout.rows / 2;
  const hemi = new THREE.HemisphereLight('#e6efff', '#6a5a48', 1.15);
  const sun = new THREE.DirectionalLight('#fff4e0', 1.9);
  sun.position.set(cx - 6, 16, cz + 8);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 10, bottom: -10, near: 1, far: 50 });
  sun.shadow.camera.updateProjectionMatrix(); // bounds set after construction need this, or shadows clip to ±5
  scene.add(hemi, sun, sun.target);
  let windowLight = null;
  if (lab.fx.window) {
    windowLight = new THREE.SpotLight('#fff1cc', 18, 14, 0.55, 0.6, 1.5);
    windowLight.position.set(lab.fx.window.X, 2.2, 1.2);
    windowLight.target.position.set(lab.fx.window.X - 1, 0, 5.5);
    scene.add(windowLight, windowLight.target);
  }

  const desks = new Map();     // slot -> desk
  const trainers = new Map();  // session -> { chibi, look }
  const positions = new Map(); // session -> { X, Z }
  const celebrations = [];
  let lastHour = null;

  function relight(hour) {
    if (lastHour !== null && Math.abs(hour - lastHour) < 0.01) return;
    lastHour = hour;
    const L = lightingParams(hour);
    hemi.intensity = L.hemiIntensity;
    sun.color.set(L.sunColor);
    sun.intensity = L.sunIntensity;
    if (lab.fx.window) lab.fx.window.material.color.set(L.windowColor);
    if (windowLight) {
      windowLight.intensity = L.windowLight;
      windowLight.color.set(L.windowLightColor);
    }
  }

  function syncDesks(list) {
    const live = new Set(list.map((d) => d.slot));
    for (const [slot, d] of desks) if (!live.has(slot)) { scene.remove(d.group); desks.delete(slot); }
    for (const d of list) {
      let desk = desks.get(d.slot);
      if (!desk) { desk = createDesk(d.slot, mats); desks.set(d.slot, desk); scene.add(desk.group); }
      desk.setActive(d.active);
      desk.setItems(d.items);
    }
  }

  function syncTrainers(list) {
    const live = new Set(list.map((t) => t.session));
    for (const [s, e] of trainers) if (!live.has(s)) { scene.remove(e.chibi.root); trainers.delete(s); }
    positions.clear();
    for (const t of list) {
      const look = `${t.role}|${t.color ?? ''}`;
      let e = trainers.get(t.session);
      if (e && e.look !== look) { scene.remove(e.chibi.root); e = null; }
      if (!e) {
        const chibi = createChibi(outfitFor(t.role, t.color), mats);
        chibi.root.name = `trainer-${t.session}`;
        e = { chibi, look };
        trainers.set(t.session, e);
        scene.add(chibi.root);
      }
      const pose = poseFor(t.status, t.phaseMs);
      e.chibi.applyPose(pose);
      const { X, Z } = pxToWorld(t.x, t.y);
      positions.set(t.session, { X, Z });
      const root = e.chibi.root;
      if (pose.lying) { root.position.set(X + LYING_SHIFT * TRAINER_SCALE, LYING_Y, Z); root.rotation.y = Math.PI / 2; }
      else { root.position.set(X, 0, Z); root.rotation.y = yawFor(t.dir); }
    }
  }

  // Celebration materials are per instance, so a finished one is freed, not pooled.
  function dropCelebration(c) {
    c.group.visible = false;
    scene.remove(c.group);
    c.dispose();
  }

  function syncCelebrations(list) {
    list.forEach((c, i) => {
      if (!celebrations[i]) { celebrations[i] = createCelebration3d(); scene.add(celebrations[i].group); }
      const { X, Z } = pxToWorld(c.x, c.y);
      celebrations[i].group.position.set(X, DESK_TOP_Y + 0.6, Z + DESK_HALF_D);
      celebrations[i].update(c.progress);
    });
    celebrations.splice(list.length).forEach(dropCelebration);
  }

  return {
    scene,
    sun,
    sync(snapshot, timeMs) {
      relight(snapshot.hour);
      updateLabFx(lab.fx, timeMs);
      syncDesks(snapshot.desks);
      syncTrainers(snapshot.trainers);
      syncCelebrations(snapshot.celebrations);
    },
    trainerPositions() { return positions; },
    occupiedSlots() { return [...desks.keys()]; },
    setShadows(on) { sun.castShadow = on; },
    // Frees only this room's resources. Desk and trainer meshes use shared
    // geometry and cached materials, so they are just detached.
    dispose() {
      disposeLab(lab);
      celebrations.splice(0).forEach(dropCelebration);
      sun.dispose();
      windowLight?.dispose();
      hemi.dispose();
      desks.clear();
      trainers.clear();
      positions.clear();
      scene.clear();
    },
  };
}
