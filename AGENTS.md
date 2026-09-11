# AGENTS.md

Client-side 3MF analyzer built with Nuxt 4 (Vue 3, Composition API), plain JavaScript (no TypeScript), Tailwind CSS via `@nuxtjs/tailwindcss`.

## Environment

- Requires Node >= 22.18 (Nuxt 4.5). This machine has `v24.14.1` under nvm; the default shell Node (`v20`) is too old and fails `nuxt prepare`. Always run npm/nuxt with node 24 on PATH:
  `export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"`

## Commands

- `npm run dev` — dev server
- `npm run generate` — static SSG output into `dist/` (symlink → `.output/public`; the app must work fully client-side; all parsing runs in the browser)
- `npm run build` — server build
- `node scripts/smoke.mjs` — no formal test suite, but a hand-rolled smoke script (28 asserts) verifies volume/surface-area math (a 10mm cube must be 1 cm³ and 600 mm², origin-independent), the shell-and-infill formula (0.5 mm shell + 20% infill → 0.44 cm³ effective), slicer weight/time detection (slice_info beats gcode per metric; gcode "2h 14m 31s" → 2.242 h) against synthetic `.3mf` files built in memory. It uses the `jsdom` dev-dependency as a `DOMParser` polyfill because three's 3MFLoader needs one under Node. Run it after touching parser/volume logic.

## Architecture

- `pages/index.vue` — orchestrates upload → parse → results; holds `file/analysis/material/infill/wallThickness` state.
- `composables/use3mfParser.js` — the only entry point to file analysis. JSZip extraction, three.js `ThreeMFLoader().parse()`, model metadata (DOMParser), and the slicer-metadata scan.
- `composables/useMeshVolume.js` — signed-tetrahedra volume (`a·(b×c)/6`), triangle-cross-product surface area, and `Box3` dimensions; geometry is in mm, so `cm³ = mm³/1000` and area is in mm².
- `components/FileDropzone.vue`, `MaterialSelector.vue`, `PrinterSelector.vue`, `ResultsPanel.vue` — UI. ResultsPanel computes the displayed weight and the print cost; PrinterSelector drives the selected printer (brand → model).
- `data/materials.js` — filament density table (PLA 1.24, PETG 1.27, ABS 1.04, TPU 1.21 g/cm³) plus default `pricePerKg` in €.
- `data/printers.json` — printer database with build volume and `energy` (rated/idle/average draw, optional per-material draws, note). Currently Bambu Lab A1 and Anycubic Kobra X.
- Print-cost model: `energy_kWh = averageDrawW/1000 × durationH`, `cost = energy × €/kWh + FilamentWeightKg × €/kg`; user inputs are €/kWh, €/kg (defaults from material), and an optional manual print-duration override that otherwise picks up the slicer's `durationH`.

## Gotchas

- `nuxt.config.js` sets `compatibilityVersion: 4` with `srcDir: '.'` so `components/`, `composables/`, `pages/`, `app.vue` live at the project root (Nuxt 3-style layout) instead of `app/`. Keep new files in the root dirs.
- `@nuxtjs/tailwindcss@6` bundles its own `tailwindcss ~3.4.x`; do not add tailwind as a separate dependency. Config is `tailwind.config.js`.
- `three@0.186` `3MFLoader`: import `{ ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'`. `parse()` takes the **whole archive** bytes (fpass `file.arrayBuffer()`), not an individual `.model` part — it unzips internally via fflate and resolves the primary model through the package relationships. It no longer converts units — coordinates are treated as raw mm — and it bakes 3MF build/component transforms onto each object's local matrix. Always `group.updateMatrixWorld(true)` before measuring.
- Two analysis modes:
  - `raw`: mesh only → weight from the geometric **shell-and-infill model**: shell of `wallThickness` (default 0.5 mm) = surface area × thickness, printed solid; remaining interior volume filled at `infill%`. Clamps shell to total volume and ignores it if there's no surface area. For thin-wall parts (e.g. fan ducts) this matches the slicer far better than flat `volume × infill%`; validated on `kobrax-fan.3mf` (V 1.109 cm³, A 1946.6 mm² → 1.24 g @ 0.5 mm/20% vs slicer 1.23 g).
  - `sliced`: slicer-reported data wins. Bambu Studio/OrcaSlicer put weight in `Metadata/slice_info.config` (`<metadata key="weight" value="…"/>`, per-filament `used_g`/`used_m`) and `; total_weight = …` / `; filament used [g] = …` in per-plate `.gcode`; PrusaSlicer exposes only the G-code comments.
- The slicer scan (`scanSlicerData`) is deliberately heuristic and guesses field names; it picks one best source file per metric so the same value isn't double-counted across `slice_info.config` + gcode. If a real slicer's field name stops being detected, extend `classifyPair`/`TEXT_PATTERNS`.
- Print duration (`slicer.durationH`, hours) is read from slice_info `key="time"` and G-code headings ("estimated printing time", "total_duration", Cura ";TIME:…"). `toSeconds` treats bare numbers as seconds (Bambu/Orca convention), drops anything under a minute (ignores Orca's zeroed `first_layer_time`), and `pickBestDuration` prefers slice_info (whole-project total) over summing per-plate G-code totals.
- Bambu `.gcode.3mf` has geometry in `3D/3dmodel.model` plus the gcode; `3MFLoader` only needs the primary model part (chosen via `_rels/.rels`), not the sub-`Objects/*.model` parts.
- Parser throws `ThreeMfError` with codes `invalid-archive` / `empty` / `no-data`; the UI shows the message verbatim.
- Parsing functions run only on client file-upload events, so SSR/prerender never touches JSZip/three runtime paths.