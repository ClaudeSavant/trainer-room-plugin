// Delivery celebration (commit/PR): a pokeball rises and spins while yellow
// sparks burst outward and everything fades — the 3D take on 2D drawCelebration.
// Geometry is shared; materials are per instance because opacity animates,
// so dispose() frees just those two.
import * as THREE from '../vendor/three.module.min.js';

export const SPARKS = 6;
export const RISE = 1.2;
const BALL = new THREE.SphereGeometry(0.16, 12, 10);
const SPARK = new THREE.OctahedronGeometry(0.06);

// Renderer teardown: the module-level geometry every celebration shares.
export function disposeSharedFx3d() { BALL.dispose(); SPARK.dispose(); }

export function createCelebration3d() {
  const group = new THREE.Group();
  group.name = 'celebration';
  const ballMat = new THREE.MeshStandardMaterial({ color: '#d93a3a', emissive: '#5a1010', emissiveIntensity: 0.4, transparent: true });
  const sparkMat = new THREE.MeshBasicMaterial({ color: '#ffd24a', transparent: true });
  const ball = new THREE.Mesh(BALL, ballMat);
  group.add(ball);
  const sparks = Array.from({ length: SPARKS }, () => {
    const s = new THREE.Mesh(SPARK, sparkMat);
    group.add(s);
    return s;
  });
  return {
    group,
    update(progress) {
      const p = Math.min(1, Math.max(0, progress));
      ball.position.y = p * RISE;
      ball.rotation.y = p * Math.PI * 4;
      sparks.forEach((s, i) => {
        const a = (i / SPARKS) * Math.PI * 2;
        s.position.set(Math.cos(a) * p * 0.8, p * RISE, Math.sin(a) * p * 0.8);
      });
      ballMat.opacity = 1 - p;
      sparkMat.opacity = 1 - p;
      group.visible = p < 1;
    },
    dispose() { ballMat.dispose(); sparkMat.dispose(); },
  };
}
