export function imageList(manifest) {
  return [
    manifest.tileset.image,
    manifest.items.image,
    ...Object.values(manifest.characters.sheets),
  ];
}

// Browser default loader; replaced by a fake in tests.
function browserLoad(base) {
  return (rel) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${rel}`));
    img.src = `${base}/${rel}`;
  });
}

export async function loadImages(manifest, loadOne = browserLoad('/assets')) {
  const [tileset, items] = await Promise.all([
    loadOne(manifest.tileset.image),
    loadOne(manifest.items.image),
  ]);
  const characters = {};
  await Promise.all(Object.entries(manifest.characters.sheets).map(
    async ([role, rel]) => { characters[role] = await loadOne(rel); }));
  return { tileset, items, characters };
}

// Race a promise against a deadline so a stalled image load can never hang the
// boot sequence (spec: page must always render, falling back to procedural draw).
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export { browserLoad };
