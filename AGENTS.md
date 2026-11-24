# AGENTS.md: SpatialTimber Furnisher

Orientation for a coding agent (and a person) opening this repository. Read this first, then [docs/2026-11-24-update.md](docs/2026-11-24-update.md) for what changed on 2026-11-24 and why.

## The parts

| Folder | What it is for |
|---|---|
| `furnisher-engine/` | The shared library: placement, search, fallbacks, scoring, the furniture data. Everything else uses it. |
| `furnisher-app/` | The browser app (React + Vite): draw a plan, furnish it, scroll through layouts, edit by hand. Imports the engine source through the aliases `@engine`, `@library`, `@layout`. |
| `furnisher-for-rhino/engine-cli/` | The command-line program: the engine bundled into `dist/furnisher-cli.cjs` (one JSON request on stdin, one JSON answer on stdout) and `dist/furnisher-batch.cjs` (the same for a JSONL file of requests). Used by the Rhino plugin and by other programs. |
| `furnisher-for-rhino/plugin/` | The Grasshopper component for Rhino 8; it runs the CLI. |
| `neufert-benchmark/` | Scripts that run the batch CLI over a public dataset of apartments and summarise the scores. |
| `furn_library/` | The source of the furniture library: one JSON file per piece (`jsons/`), `build_library.py` merges them into `furniture_library.json`, `make_fallback_pieces.py` makes the smaller fallback pieces. |

## The one rule

**All placement and scoring logic lives in the engine.** The app and the CLI call it and add no logic of their own: no own search, no own lookup of pieces, no own score. If the app and the CLI should behave differently, the difference is an option of the engine, not a copy of its code.

## Where a room's furnishing is decided

- `furnisher-engine/src/engine/furnish.ts`, `furnishRoom(room, aptType, opts)`: the regular pieces first; only for a room they leave incomplete, the same pieces at other positions, the step's other alternative, then the smaller fallback pieces. Also the room's score (`scoreFurnishedRoom`), "counts as furnished" (`roomFurnished`, `pieceOverlaps`) and the apartment summary (`summarizeApartment`).
- `furnisher-engine/src/engine/pipeline.ts`, `runRoomPipelineAt`: places one layout, step by step; each step's piece comes from `library/lookup.ts`, `resolvePipelineStep`.
- `furnisher-engine/src/engine/scorer.ts`, `scoreRoom`: the 0 to 100 score from the number of positions per piece.

## The data files that steer it

| File | What a person changes there |
|---|---|
| `furnisher-engine/src/library/default/placement_order.md` | Which pieces a room gets and in which order; `A \| B` alternatives (the one the library has for the apartment type is used). |
| `furnisher-engine/src/library/default/fallbacks.json` | The smaller pieces tried when a room cannot be furnished (rules in order, `penaltyPoints`), and the pieces a room may do without (`optional`, `optionalPenaltyPoints`). |
| `furnisher-engine/src/library/default/furniture_library.json` | The pieces' geometry per apartment type. Edit the files in `furn_library/jsons/` and run `furn_library/build_library.py`, then copy the result here (the two files are identical). |

The CLI bundle embeds these files: after a change, rebuild the CLI.

## Build and test (state on 2026-11-24)

```powershell
cd furnisher-for-rhino/engine-cli
npm install          # esbuild only
npm run build        # dist/furnisher-cli.cjs, dist/furnisher-batch.cjs
npm test             # app-and-cli check, needs dist/ built first

cd ../../furnisher-app
npm install
npm run build        # tsc -b, then vite build
npm run dev          # http://127.0.0.1:5173

cd ../furnisher-engine
npm install
npx vite build       # passes
npm run build        # FAILS: 9 type errors, all in demo/ (storybook components still use room.door and getDoorRectangle); older than 2026-11-24, src/ itself type-checks clean
```

- `npm test` furnishes 16 real rooms (`engine-cli/test/cases.json`) twice, the app's way through the engine and through the built CLI, and checks that both give the same pieces, option counts, geometry, fallback, score and "furnished", and what each case expects.
- `npm run build` in `engine-cli` writes the absolute path of `placement_order.md` into the bundle as a comment, so the same commit built in two folders differs by that one line.

## Read next

- [docs/2026-11-24-update.md](docs/2026-11-24-update.md): the changes of 2026-11-24 (shower, fallback pieces, one logic for app and CLI, the search for other positions, the apartment summary, the 1-room living room without its table), the new answer fields, what did not change, the parameters, how to undo a change.
- [furnisher-engine/src/engine/README.md](furnisher-engine/src/engine/README.md) and [furnisher-engine/src/library/README.md](furnisher-engine/src/library/README.md): the engine's exports and data formats.
- [furnisher-for-rhino/README.md](furnisher-for-rhino/README.md): the CLI and the plugin.
