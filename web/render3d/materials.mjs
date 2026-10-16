// One cache per renderer: every room shares materials, so N rooms cost no extra
// shader programs. Cached materials are never mutated after creation; anything
// that changes per frame swaps between two cached materials instead.
import * as THREE from '../vendor/three.module.min.js';

export function createMaterials() {
  const cache = new Map();
  const get = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };
  return {
    std(color, { flat = true, emissive = null, emissiveIntensity = 0, roughness = 0.85 } = {}) {
      return get(`std|${color}|${flat}|${emissive}|${emissiveIntensity}|${roughness}`, () => new THREE.MeshStandardMaterial({
        color, flatShading: flat, roughness, ...(emissive ? { emissive, emissiveIntensity } : {}),
      }));
    },
    basic(color) { return get(`basic|${color}`, () => new THREE.MeshBasicMaterial({ color })); },
    shadow() {
      return get('shadow', () => new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.28, depthWrite: false }));
    },
    size() { return cache.size; },
    dispose() { for (const m of cache.values()) m.dispose(); cache.clear(); },
  };
}
