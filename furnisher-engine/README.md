# furnisher-engine

Automatic furniture placement engine for residential rooms.

Given a room polygon, a door point, and a furniture library, the engine places furniture pieces wall by wall — subtracting each footprint from the available space before placing the next piece. After running the pipeline, `scoreRoom()` converts the placement result into a 0–100 quality score based on how many valid placement options each furniture piece had.

---

## Requirements

- Node.js 20 or later
- npm 9 or later

---

## Run the interactive demo

```bash
cd furnisher-engine
npm install
npm run storybook
```

Storybook is served at **http://localhost:7007** — open that URL in your browser once the terminal shows:

```
info => Storybook X.X.X started
info => Serving storybook on http://localhost:7007/
```

**Start here:** open **Engine / Room Pipeline**, pick a room name and seed, then click through placement steps. If furniture appears in the room and the positions shift when you change the seed, the engine is working.

---

## Project structure

```
furnisher-engine/
├── src/
│   ├── engine/        ← placement logic (wall analysis, ray checks, subtraction, pipeline runner)
│   ├── library/       ← furniture data, pipeline definition, lookup helpers
│   │   ├── default/   ← furniture_library.json + placement_order.md (the shipped defaults)
│   │   └── custom/    ← your local overrides (gitignored, never committed)
│   └── layout/        ← types only: Point2D, Room, RoomName, Apartment
│
│   (src/App.tsx, src/main.tsx, src/*.css — Vite boilerplate, unused by the engine)
│
└── demo/
    ├── generator/     ← example room generator (seed → Room polygons)
    └── storybook/     ← canvas components + Storybook stories
```

`src/engine/`, `src/library/`, and `src/layout/` are the engine. The demo has no effect on how the engine works — it only shows it.

---

## Using the engine from another project

This package is not published to npm (`"private": true`, no `exports` field). You have three options:

**Option A — Copy the engine modules (simplest)**

Copy these three folders into your project:
```
src/engine/
src/library/
src/layout/
```
Then install the one runtime dependency:
```bash
npm install polygon-clipping
```
If your bundler does not support `import ... from "file.md?raw"` (Vite syntax used in `library/loader.ts`), replace `loader.ts` with a version that reads the markdown string however your environment prefers, or hard-code the parsed pipeline object.

**Option B — npm workspace (monorepo)**

Add this repo as a workspace package and reference it by name. The engine modules import only from each other and from `polygon-clipping`.

**Option C — Git submodule**

```bash
git submodule add <repo-url> furnisher-engine
```
Then import directly from the submodule path.

---

## Integration walkthrough

### 1. Provide a room

```ts
import type { Room } from "./src/layout/types";

const room: Room = {
  name:    "Bedroom",
  polygon: [[0,0], [4.5,0], [4.5,3.8], [0,3.8]],
  door:    [2.1, 0],
};
```

**Coordinate rules:**
- Unit: metres
- Winding: counter-clockwise (CCW)
- The last vertex does **not** repeat the first
- `door` is a point that lies on one of the polygon edges
- Polygons can be rectangular or L-shaped; avoid holes or self-intersections

**Supported room names:** `"Bedroom"`, `"Living room"`, `"Kitchen"`, `"Bathroom"`, `"WC"`, `"Children 1"` through `"Children 4"`

If you are coming from Grasshopper / Rhino or another CAD tool, convert your room boundary to this format. `demo/generator/roomGenerator.ts` is a complete example of how `Room` objects are constructed.

### 2. Choose an apartment type

`apartmentType` is an integer from 1 to 4. It selects which furniture size tier the library uses — roughly: 1 = compact/studio, 4 = large family apartment. It determines which library entries are matched, not which rooms exist.

### 3. Run the pipeline

```ts
import { runRoomPipeline } from "./src/engine";

const result = runRoomPipeline(room, apartmentType);
```

`result.steps` contains one entry per successfully placed piece. `result.warnings` lists any steps that were skipped (no library entry found, or no valid placement in the remaining space).

```ts
for (const step of result.steps) {
  console.log(step.furnitureName);
  for (const geo of step.placed.transformedGeometry) {
    // geo.points — array of Point2D in world coordinates
    // geo.closed — whether to close the path when drawing
  }
}

if (result.warnings.length) {
  console.warn("Skipped:", result.warnings);
}
```

### 4. Minimal working example (TypeScript)

```ts
import type { Room }       from "./src/layout/types";
import { runRoomPipeline } from "./src/engine";

const room: Room = {
  name:    "Bedroom",
  polygon: [[0,0],[4.2,0],[4.2,3.6],[0,3.6]],
  door:    [1.8, 0],
};

const { steps, warnings } = runRoomPipeline(room, 2);

steps.forEach(s => console.log(s.furnitureName, s.placed.transformedGeometry));
warnings.forEach(w => console.warn(w));
```

---

## Customising furniture and placement order

### Placement order

`src/library/default/placement_order.md` defines what gets placed in each room and in what order:

```markdown
## Bedroom
1. Bed
2. Wardrobe

## Bathroom
1. Bathtube | Shower
2. Toilet
3. Sink
```

Each numbered line is one placement step. `|` lists fallback alternatives — the first one found in the library is used. The section heading is the room name (use `"Children"` to cover all Children N rooms).

### Furniture library

`src/library/default/furniture_library.json` defines furniture geometry: wall-contact edge, clearance bounding box, physical footprint, and drawable geometry — one entry per furniture name per apartment type.

See `src/library/README.md` for the full schema.

### How to edit without touching the defaults

Copy the file(s) you want to change into `src/library/custom/` and load them yourself:

```ts
import myLibraryJson  from "./src/library/custom/furniture_library.json";
import myPipelineMd   from "./src/library/custom/placement_order.md?raw";
import { parsePipelineMd }        from "./src/library";
import type { FurnitureLibrary }  from "./src/library";
import { runRoomPipeline }        from "./src/engine";

const result = runRoomPipeline(room, aptType, {
  library:  myLibraryJson as FurnitureLibrary,
  pipeline: parsePipelineMd(myPipelineMd),
});
```

Files in `custom/` are gitignored — they stay local and never appear in the shared repo. The defaults in `default/` are the reference; treat them as read-only.

You can also construct the library or pipeline objects in code without any files, and pass them the same way.
