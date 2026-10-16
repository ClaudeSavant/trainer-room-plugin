# Asset Credits & Licenses

All art in this directory is **original work authored by this project** and released
into the public domain under **[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)**.
No third-party art was used. No Nintendo / Pokémon (FireRed) rips. No CC-BY / CC-BY-SA / GPL assets.

The PNGs are generated programmatically by `web/assets/_gen.mjs` (a small hand-rolled
PNG encoder built on Node's stdlib `zlib` — zero npm dependencies). Re-run with
`node web/assets/_gen.mjs` to regenerate them deterministically.

| File | Description | Source | Author | License | Date |
|------|-------------|--------|--------|---------|------|
| `tileset.png` | 16×16 interior tiles: floor, wall, machine, window, bookshelf, desk, healing console | original (`_gen.mjs`) | Trainer Room project | CC0 1.0 | 2026-06-27 |
| `items.png` | 16×16 item sprites: note/token, document, parcel, pokeball deliverable | original (`_gen.mjs`) | Trainer Room project | CC0 1.0 | 2026-06-27 |
| `characters/professor.png` | 16×24 role spritesheet (4 dirs × 4 walk frames) — lab-coat professor | original (`_gen.mjs`) | Trainer Room project | CC0 1.0 | 2026-06-27 |
| `characters/dev-a.png` | 16×24 role spritesheet — blue dev trainer | original (`_gen.mjs`) | Trainer Room project | CC0 1.0 | 2026-06-27 |
| `characters/dev-b.png` | 16×24 role spritesheet — pink dev trainer | original (`_gen.mjs`) | Trainer Room project | CC0 1.0 | 2026-06-27 |
| `characters/reviewer.png` | 16×24 role spritesheet — gold reviewer trainer | original (`_gen.mjs`) | Trainer Room project | CC0 1.0 | 2026-06-27 |
| `characters/npc.png` | 16×24 role spritesheet — generic green NPC | original (`_gen.mjs`) | Trainer Room project | CC0 1.0 | 2026-06-27 |

CC0 requires no attribution; provenance is logged here for auditability.

## three.js (3D view)

`web/vendor/three.module.min.js` is three.js r160 (0.160.0), vendored unmodified from
`https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js`
(sha256 `3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6`).
Copyright 2010-2023 Three.js Authors, MIT licence — full text in `web/vendor/three.LICENSE`.
All 3D models (lab, chibi trainers, items) are built in code by this project (CC0).
