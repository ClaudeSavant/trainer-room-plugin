// The one WebGL context for the whole page (spec §6; see the plan's deviation
// note). It renders each visible room offscreen and blits the frame into that
// room's own card canvas, so there is no browser context cap, no z-index fight
// with popups, and clicks land on the card canvas exactly as in 2D.
import * as THREE from '../vendor/three.module.min.js';
import { createMaterials } from './materials.mjs';
import { createRoomScene } from './room-scene.mjs';
import { createDirector, stepDirector, cameraPosition, settledBy } from './director.mjs';
import { disposeSharedChibi } from './chibi.mjs';
import { disposeSharedDesks } from './desks.mjs';
import { disposeSharedLab } from './lab.mjs';
import { disposeSharedFx3d } from './fx3d.mjs';
import { pickDesk } from './pick.mjs';
import { overlayItems, createOverlay } from './overlay.mjs';

export const QUALITY = Object.freeze({
  single: Object.freeze({ shadows: true, pixelRatio: 2, fps: 60 }),
  grid: Object.freeze({ shadows: false, pixelRatio: 1.5, fps: 30 }),
});
export function qualityFor(mode) { return QUALITY[mode] ?? QUALITY.grid; }

// 2 ms of slack so a 60 Hz display does not skip every other 30 fps frame.
export function frameDue(last, now, fps) { return last == null || now - last >= 1000 / fps - 2; }

// y is written as 1 - t*2 rather than -(t*2 - 1) so the rect centre gives 0, not -0.
export function ndcFromClient(rect, clientX, clientY) {
  return { x: ((clientX - rect.left) / rect.width) * 2 - 1, y: 1 - ((clientY - rect.top) / rect.height) * 2 };
}

export const CLICK_SLOP_PX = 5;
export function isClick(down, up) { return Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_SLOP_PX; }

// Pointer decisions for one canvas, kept free of DOM events so they can be
// tested. Once a press leaves the slop it stays a drag, so a drag that wanders
// back to its start never opens a terminal; the later ups of a double-click
// (detail > 1) are not clicks either, since that gesture means "reset camera".
export function createGesture() {
  let down = null, last = null, dragged = false;
  return {
    down(x, y) { down = last = { x, y }; dragged = false; },
    // Returns the orbit delta since the last move while dragging, else null.
    move(x, y, buttons) {
      if (!down || buttons === 0) return null; // missed release: never orbit on hover
      const p = { x, y };
      const prev = last;
      last = p;
      if (!dragged && isClick(down, p)) return null;
      dragged = true;
      return { dx: p.x - prev.x, dy: p.y - prev.y };
    },
    up(x, y, detail = 1) {
      if (!down) return null;
      const wasDrag = dragged || !isClick(down, { x, y });
      down = null;
      if (wasDrag) return 'drag';
      return detail > 1 ? null : 'click';
    },
    cancel() { down = null; },
  };
}

// A dropped room must free its own GPU resources exactly once; a scene is
// unusable after dispose(), so it leaves the map in the same step.
export function dropRoomEntry(rooms, key) {
  const r = rooms.get(key);
  if (!r) return;
  r.overlay.hide();
  r.rs.dispose();
  rooms.delete(key);
}

// One-way teardown (the page never returns to 3D): rooms first, then the shared
// caches they drew from, then the context. Idempotent; gl.dispose on a lost
// context must not stop the fallback, so it is guarded.
export function createDispose({ rooms, mats, gl, disposeShared }) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    // Independent stages: one failing must not leak the rest (above all the GL context).
    const stage = (fn) => { try { fn(); } catch (e) { console.warn('dispose stage failed', e); } };
    for (const key of [...rooms.keys()]) stage(() => dropRoomEntry(rooms, key));
    stage(() => mats.dispose());
    stage(disposeShared);
    stage(() => gl.dispose()); // throws on a lost context
  };
}

// An idle room (no sim ticks) still draws while this is true: input is queued,
// the camera is still moving from earlier input, or its canvas was resized or
// never drawn (a resize clears the backing store, and overlay labels must follow).
export function roomWantsFrame(r, { width, height, now }) {
  return r.inputs.length > 0 || !r.drawn || r.drawn.w !== width || r.drawn.h !== height || now < r.busyUntil;
}

// Successive orbits (or zooms) merge into one, so a burst of pointer events
// costs one director step; the queue is also capped so it can never grow
// without bound, dropping the oldest input first.
export const INPUT_CAP = 16;
export function queueInput(queue, input) {
  const prev = queue.at(-1);
  if (prev && prev.kind === 'orbit' && input.kind === 'orbit') {
    queue[queue.length - 1] = { kind: 'orbit', dAz: prev.dAz + input.dAz, dEl: prev.dEl + input.dEl };
  } else if (prev && prev.kind === 'zoom' && input.kind === 'zoom') {
    queue[queue.length - 1] = { kind: 'zoom', factor: prev.factor * input.factor };
  } else {
    queue.push(input);
    if (queue.length > INPUT_CAP) queue.splice(0, queue.length - INPUT_CAP);
  }
}

// Zoom in proportion to the scroll distance: a trackpad fires many small deltas
// and a mouse wheel few large ones, so a fixed step per event was uncontrollable
// on a trackpad. Each event is clamped to ~8%, the old per-notch step.
const ZOOM_PER_PX = 0.0016, ZOOM_MAX_PX = 50, LINE_PX = 16;
export function zoomFactor({ deltaY, deltaMode = 0 }) {
  // deltaMode 1 = lines, 2 = pages (a page is always a full step).
  const px = deltaMode === 1 ? deltaY * LINE_PX : deltaMode === 2 ? deltaY * ZOOM_MAX_PX : deltaY;
  return Math.exp(Math.min(ZOOM_MAX_PX, Math.max(-ZOOM_MAX_PX, px)) * ZOOM_PER_PX);
}

const ORBIT_PER_PX = 0.008, TILT_PER_PX = 0.006;
// Above slow double-click settings; only single-room clicks wait it out.
const DBLCLICK_MS = 500;
// A dblclick this soon after a click that opened a terminal was a slow
// double-click, not a request for the terminal: close it again.
export const UNDO_MS = 1500;
export function createUndo() {
  let last = null;
  return {
    arm(close, at) { last = typeof close === 'function' ? { close, at } : null; },
    fire(now) {
      const l = last; last = null;
      if (!l || now - l.at >= UNDO_MS) return false;
      l.close();
      return true;
    },
  };
}
// The second click of a slow double-click lands on whatever now covers the
// canvas (the terminal modal), so the dblclick is watched on the document in
// the capture phase while an undo is armed, and the watch ends when the undo
// fires, expires, is re-armed, or the controls detach.
export function createUndoWatch(doc, undo) {
  let timer = null;
  const onDbl = () => { undo.fire(Date.now()); disarm(); };
  function disarm() {
    clearTimeout(timer); timer = null;
    doc.removeEventListener('dblclick', onDbl, true);
  }
  return {
    arm(close, at) {
      disarm();
      undo.arm(close, at);
      if (typeof close !== 'function') return;
      doc.addEventListener('dblclick', onDbl, true);
      timer = setTimeout(() => { undo.arm(null, 0); disarm(); }, UNDO_MS);
    },
    disarm,
  };
}
// A room that has not drawn for a while eases from where it was rather than snapping.
const MAX_STEP_MS = 100;

export function createRenderer3d({ reducedMotion = () => false, onContextLost = () => {} } = {}) {
  const glCanvas = document.createElement('canvas'); // offscreen: never in the DOM
  const gl = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
  gl.setPixelRatio(1); // the card canvas is already sized in device pixels
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;
  glCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); onContextLost(); });
  const mats = createMaterials();
  const rooms = new Map(); // key -> { rs, director, overlay, camera, inputs, last, drawn, busyUntil }
  const v = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();

  const dispose = createDispose({
    rooms, mats, gl,
    disposeShared() { disposeSharedChibi(); disposeSharedDesks(); disposeSharedLab(); disposeSharedFx3d(); },
  });
  let disposed = false;

  const api = {
    dispose() { disposed = true; dispose(); },
    pixelRatio(mode) { return Math.min(globalThis.devicePixelRatio || 1, qualityFor(mode).pixelRatio); },

    ensureRoom(key, overlayEl) {
      if (disposed || rooms.has(key)) return;
      rooms.set(key, {
        rs: createRoomScene(mats), director: createDirector(), overlay: createOverlay(overlayEl),
        camera: new THREE.PerspectiveCamera(36, 20 / 12, 0.1, 120), inputs: [], last: null,
        drawn: null, busyUntil: -Infinity,
      });
    },

    dropRoom(key) { dropRoomEntry(rooms, key); },

    frameDue(key, now, mode) { const r = rooms.get(key); return !!r && frameDue(r.last, now, qualityFor(mode).fps); },

    wantsFrame(key, { canvas, now }) {
      const r = rooms.get(key);
      return !!r && roomWantsFrame(r, { width: canvas.width, height: canvas.height, now });
    },

    renderRoom(key, { snapshot, ctx, canvas, mode, now }) {
      const r = rooms.get(key);
      if (!r || disposed) return;
      const dt = r.last == null ? 16 : Math.min(MAX_STEP_MS, now - r.last);
      r.last = now;
      r.rs.sync(snapshot, now, { reducedMotion: reducedMotion() });
      const q = qualityFor(mode);
      r.rs.setShadows(q.shadows);
      gl.shadowMap.enabled = q.shadows; // part of three's program cache key: no manual recompile needed

      // Advance the director: inputs first (each its own step), then the frame.
      const positions = r.rs.trainerPositions();
      const base = { mode, reducedMotion: reducedMotion(), positionOf: (s) => positions.get(s) ?? null };
      let st = r.director;
      for (const input of r.inputs.splice(0)) {
        st = stepDirector(st, { ...base, now, dt: 0, input });
        r.busyUntil = Math.max(r.busyUntil, settledBy(input, now));
      }
      st = stepDirector(st, { ...base, now, dt, events: snapshot.events });
      r.director = st;

      const w = canvas.width, h = canvas.height;
      r.drawn = { w, h };
      if (glCanvas.width !== w || glCanvas.height !== h) gl.setSize(w, h, false);
      r.camera.aspect = w / h;
      r.camera.updateProjectionMatrix();
      const p = cameraPosition(st.pose);
      r.camera.position.set(p.x, p.y, p.z);
      r.camera.lookAt(st.pose.tx, st.pose.ty, st.pose.tz);
      r.camera.updateMatrixWorld();
      gl.render(r.rs.scene, r.camera);
      // Same task as the render, so the drawing buffer is still intact.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(glCanvas, 0, 0, w, h, 0, 0, w, h);

      const cssW = canvas.clientWidth || w, cssH = canvas.clientHeight || h;
      r.overlay.update(overlayItems(snapshot, { mode }), (X, Y, Z) => {
        v.set(X, Y, Z).project(r.camera);
        return { x: ((v.x + 1) / 2) * cssW, y: ((1 - v.y) / 2) * cssH, visible: v.z > -1 && v.z < 1 };
      });
    },

    input(key, input) { const r = rooms.get(key); if (r) queueInput(r.inputs, input); },

    pick(key, canvas, clientX, clientY) {
      const r = rooms.get(key);
      if (!r) return null;
      const ndc = ndcFromClient(canvas.getBoundingClientRect(), clientX, clientY);
      raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), r.camera);
      const { origin: o, direction: d } = raycaster.ray;
      return pickDesk([o.x, o.y, o.z], [d.x, d.y, d.z], r.rs.occupiedSlots());
    },

    hideOverlays() { for (const r of rooms.values()) r.overlay.hide(); },

    // Pointer handling for one room canvas. Drags orbit (single room only); a
    // press that moves no more than CLICK_SLOP_PX is a click, so dragging across
    // a desk never opens its terminal. In the single room a click waits out the
    // double-click window, so a double-click to reset never opens a terminal.
    attachControls(key, el, { isSingle, onClick }) {
      const g = createGesture();
      const undo = createUndo();
      const watch = createUndoWatch(el.ownerDocument ?? document, undo);
      const fireClick = (x, y) => watch.arm(onClick(x, y), Date.now());
      let pending = null;
      const clearPending = () => { clearTimeout(pending); pending = null; };
      const onDown = (e) => {
        g.down(e.clientX, e.clientY);
        if (isSingle()) el.setPointerCapture?.(e.pointerId);
      };
      const onMove = (e) => {
        const d = g.move(e.clientX, e.clientY, e.buttons);
        if (d && isSingle()) api.input(key, { kind: 'orbit', dAz: -d.dx * ORBIT_PER_PX, dEl: d.dy * TILT_PER_PX });
      };
      const onUp = (e) => {
        if (g.up(e.clientX, e.clientY, e.detail) !== 'click') return;
        const { clientX, clientY } = e;
        if (!isSingle()) { fireClick(clientX, clientY); return; }
        clearPending();
        pending = setTimeout(() => { pending = null; fireClick(clientX, clientY); }, DBLCLICK_MS);
      };
      const onCancel = () => g.cancel();
      const onWheel = (e) => {
        if (!isSingle()) return; // the grid keeps normal page scrolling
        e.preventDefault();
        api.input(key, { kind: 'zoom', factor: zoomFactor(e) });
      };
      const onDbl = () => { clearPending(); undo.fire(Date.now()); if (isSingle()) api.input(key, { kind: 'reset' }); };
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onCancel);
      el.addEventListener('lostpointercapture', onCancel);
      el.addEventListener('wheel', onWheel, { passive: false });
      el.addEventListener('dblclick', onDbl);
      return () => {
        clearPending();
        watch.disarm();
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onCancel);
        el.removeEventListener('lostpointercapture', onCancel);
        el.removeEventListener('wheel', onWheel);
        el.removeEventListener('dblclick', onDbl);
      };
    },
  };
  return api;
}
