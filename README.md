# SpatialTimber Furnisher

Monorepo for the SpatialTimber automatic furniture placement system. The repo has three parts:

| Folder | Role |
|---|---|
| `furnisher-engine/` | **The library.** All placement logic, furniture data, and scoring. |
| `furnisher-app/` | React prototype for interactive use in the browser. |
| `furnisher-for-rhino/` | Grasshopper plugin that drives the engine from Rhino geometry. |

---

## furnisher-engine — the library

`furnisher-engine/src/` is the authoritative source for all furniture placement logic. It is a pure TypeScript library with one runtime dependency (`polygon-clipping`). Everything else in this repo is a consumer of it.

### What it does

Given a room polygon, a list of door points, and a furniture library, the engine:

1. Analyses the room walls (length, inward normal, door exclusion zones).
2. Tries each furniture piece in pipeline order, placing it against the best available wall.
3. Subtracts the placed footprint from the available space before placing the next piece.
4. Returns full 2D geometry for each piece (furniture lines, clearance bbox, footprint bbox).
5. Scores the result 0–100 based on how many placement options existed.

### Source layout

```
furnisher-engine/src/
├── engine/        ← placement pipeline, wall analysis, scoring
│   ├── pipeline.ts      runRoomPipeline / runRoomPipelineAt
│   ├── placer.ts        getAllPlacements, getDoorRectangles
│   ├── scorer.ts        scoreRoom (0–100 quality score)
│   ├── subtraction.ts   polygon boolean difference
│   └── types.ts         PlacedFurniture, PipelineResult, StepOptions …
├── library/       ← furniture data and lookup
│   ├── default/
│   │   ├── furniture_library.json   geometry + bboxes per piece per apt type
│   │   └── placement_order.md       which pieces go in which rooms, in what order
│   ├── loader.ts        loads defaults; handles Vite `?raw` import
│   ├── lookup.ts        findFurnitureByName, roomNameToCategory, apartmentLabelToType
│   └── types.ts         FurnitureLibrary, FurnitureEntry, FurnitureVariant …
└── layout/        ← shared geometry types only
    └── types.ts         Point2D, Room, RoomName, Apartment, ApartmentLabel
```

### Key API

```ts
import { runRoomPipelineAt } from "./src/engine";
import { scoreRoom }         from "./src/engine";
import type { Room }         from "./src/layout/types";

const room: Room = {
  name:    "Bedroom",
  polygon: [[0,0],[4.2,0],[4.2,3.6],[0,3.6]], // CCW, metres, no repeated first vertex
  doors:   [[1.8, 0]],                          // points on the wall edge
};

// Run full pipeline — returns all options + selected placement per step
const result = runRoomPipelineAt(room, 2 /* aptType 1–4 */, [] /* selectedIndices */);

for (const step of result.steps) {
  step.furnitureName           // e.g. "Bed"
  step.allOptions.length       // total valid (variant × position) options
  step.selected.placed.transformedGeometry   // array of { closed, points } polylines
  step.selected.placed.transformedBbox       // clearance / transition zone polygon
  step.selected.placed.transformedSmallBbox  // physical footprint polygon
}

// Score the result
const { score, steps } = scoreRoom(room.name, result);
// score: 0–100  |  steps: per-piece breakdown
```

`aptType` maps roughly to apartment size: 1 = studio/1-bed, 2 = 2-bed, 3 = 3-bed, 4 = 4-bed+.

### Supported room names

`"Bedroom"`, `"Living room"`, `"Kitchen"`, `"Bathroom"`, `"WC"`, `"Children 1"` … `"Children 4"`

### Coordinate rules

- Unit: **metres**
- Winding: **counter-clockwise (CCW)**. If your source is CW, reverse the array.
- Last vertex must **not** repeat the first.
- `doors` is a list of points that lie on polygon edges (≤ 0.4 m from the boundary).
- Polygons can be rectangular or L-shaped. Avoid holes or self-intersections.
- Collinear intermediate vertices on straight walls (common from CAD discretisation) should be removed before passing to the engine — they can cause the `polygon-clipping` subtraction to produce incorrect results. See the polygon simplification note below.

---

## furnisher-app — browser prototype

`furnisher-app/` is a React + Vite single-page app. It is a **practical prototype**, not a production tool — its purpose is to let architects draw a floor plan interactively in the browser, place door points, and explore automatically generated furniture layouts with variant scrolling.

It imports the engine directly via Vite path aliases (`@engine`, `@layout`, `@library` → `../furnisher-engine/src/*`), so both folders must stay siblings.

```powershell
cd furnisher-app && npm install && npm run dev   # http://127.0.0.1:5173
```

The Storybook in `furnisher-engine/` (`npm run storybook`) is a useful companion — it lets you drive the engine room-by-room with sliders without the full app.

---

## furnisher-for-rhino — Grasshopper plugin

`furnisher-for-rhino/` is a proof-of-concept Grasshopper plugin for Rhino 8. It demonstrates that the engine can be driven from any CAD environment with no forking or reimplementation. See [`furnisher-for-rhino/README.md`](furnisher-for-rhino/README.md) for full usage.

---

## Building your own CAD plugin — step-by-step guide

This is the pattern used by `furnisher-for-rhino`. Follow these steps to integrate the engine into any CAD environment (Revit, ArchiCAD, FreeCAD, Blender, etc.).

The core principle: **the engine is TypeScript; most CAD scripting environments are not**. Rather than porting the logic, bundle the engine into a self-contained Node CLI and communicate with it over stdin/stdout JSON. Your CAD plugin stays thin — it only reads geometry and deserialises results.

```
CAD environment ──→ your plugin (any language)
                         │  JSON request on stdin
                         ▼
                    node furnisher-cli.cjs   ← bundled engine
                         │  JSON response on stdout
                         ▼
                    your plugin converts geometry back
```

### Step 1 — understand the wire contract

The CLI (`furnisher-for-rhino/engine-cli/src/cli.ts`) defines the JSON shapes. The essential parts:

**Request (stdin):**
```json
{
  "rooms": [
    {
      "name": "Bedroom",
      "polygon": [[0,0],[4.2,0],[4.2,3.6],[0,3.6]],
      "windows": []
    }
  ],
  "doors": [[1.8, 0]],
  "aptType": 2,
  "selectionMode": "flat",
  "selections": [[0, 0]]
}
```

- `rooms[].polygon` — CCW 2D ring in metres, no repeated closing vertex.
- `doors` — flat list of all door points; the CLI assigns each to the nearest room (within 0.4 m).
- `aptType` — 1–4. Omit to auto-infer from room names.
- `selections[room][step]` — flat index (0 = best) or omit for defaults.
- `selectionMode` — `"flat"` (one int per step) or `"variant-position"` (two ints per step: `[variantIndex, positionIndex]`).

**Response (stdout):**
```json
{
  "aptType": 2,
  "rooms": [
    {
      "name": "Bedroom",
      "score": 100.0,
      "steps": [
        {
          "furnitureName": "Bed",
          "optionCount": 11,
          "selectedIndex": 0,
          "variantGroups": [{"variantIndex": 0, "startFlatIndex": 0, "count": 6}],
          "selectedVariant": 0,
          "selectedPosition": 0,
          "geometry":  [{"closed": true, "points": [[x,y], ...]}],
          "bbox":      [[x,y],[x,y],[x,y],[x,y]],
          "smallBbox": [[x,y],[x,y],[x,y],[x,y]]
        }
      ],
      "doors": [
        {
          "rect": [[x,y],[x,y],[x,y],[x,y]],
          "width": 0.9,
          "hingeAtIndex": 0
        }
      ],
      "warnings": []
    }
  ]
}
```

- `geometry` — draw these polylines as the furniture symbol.
- `bbox` — the clearance / transition zone. Adjacent pieces' bboxes may overlap each other, but a piece's `smallBbox` must not sit inside another piece's `bbox`.
- `smallBbox` — the physical footprint. Never overlaps another `smallBbox`.
- `variantGroups` — how many positions each variant shape has. Use to build navigation UI.
- `doors[].rect` — `[c0, c1, c2, c3]`: c0/c1 on the wall, c2/c3 inward. `hingeAtIndex` tells you which wall point is the hinge (chosen as the one closest to a room corner so the door swings into open space). Panel = hinge → inward point. Arc = quarter circle from inward point back to far wall point.
- Options are sorted best-first: index 0 always gives the highest room score.

### Step 2 — build the CLI bundle

```powershell
cd furnisher-for-rhino/engine-cli
npm install        # installs esbuild only
npm run build      # produces dist/furnisher-cli.cjs (~590 KB, self-contained)
```

The build uses `build.mjs` which handles the Vite `?raw` markdown import that normal bundlers reject. The output is a single CommonJS file; Node.js ≥ 18 is the only runtime requirement.

**Critical:** the engine writes `[placer]` debug lines via `console.log`. The CLI redirects these to no-ops before any imports so stdout stays clean JSON. Make sure any fork of `cli.ts` preserves this.

### Step 3 — polygon preparation (important)

Before sending polygons to the engine:

1. **Remove collinear intermediate vertices.** CAD tools often discretise curves with extra points on straight segments. These cause `polygon-clipping` subtraction to silently fail, producing overlapping furniture. Remove any vertex where the cross-product of its two adjacent edges is < 0.002 m².

2. **Ensure CCW winding.** Compute signed area (shoelace formula). If negative (CW), reverse the vertex array.

3. **Remove near-duplicate vertices** (< 5 mm apart).

4. **Do not repeat the closing vertex** — the engine expects `polygon[last] ≠ polygon[0]`.

The CLI's `simplifyPolygon` function in `cli.ts` does all of this and is safe to copy.

### Step 4 — pipe the CLI from your plugin

Spawn `node furnisher-cli.cjs`, write the JSON request to stdin, close stdin, read stdout to completion. Read stderr concurrently (not sequentially) — the OS pipe buffer is ~4 KB and the engine can fill it with internal warnings, causing a deadlock if you read stdout first and block waiting for it.

```python
# Python example
import subprocess, json

req = {"rooms": [...], "doors": [...]}
proc = subprocess.run(
    ["node", "furnisher-cli.cjs"],
    input=json.dumps(req),
    capture_output=True,
    text=True,
    timeout=60,
)
response = json.loads(proc.stdout)
```

```csharp
// C# example (see EngineBridge.cs for full implementation)
var psi = new ProcessStartInfo {
    FileName = "node",
    Arguments = "\"path/to/furnisher-cli.cjs\"",
    RedirectStandardInput  = true,
    RedirectStandardOutput = true,
    RedirectStandardError  = true,
    UseShellExecute = false,
    StandardInputEncoding  = new UTF8Encoding(false),  // no BOM — Node rejects it
    StandardOutputEncoding = new UTF8Encoding(false),
};
using var proc = Process.Start(psi);
var stdoutTask = proc.StandardOutput.ReadToEndAsync();  // read both
var stderrTask = proc.StandardError.ReadToEndAsync();   //   concurrently
proc.StandardInput.Write(requestJson);
proc.StandardInput.Close();
proc.WaitForExit(60_000);
Task.WaitAll(stdoutTask, stderrTask);
var response = JsonSerializer.Deserialize<EngineResponse>(stdoutTask.Result);
```

**Important for .NET:** use `new UTF8Encoding(false)` (no BOM) for stdin encoding. `Encoding.UTF8` prepends a byte-order mark that Node's `JSON.parse` rejects with "Unexpected token".

### Step 5 — navigation (variant scrolling)

Each step in the response has `optionCount` valid placements. To implement scrolling like the app:

- Show the response at `selections = []` (all zeros → best-first default).
- For each step, read `variantGroups` to know how many shapes exist and how many positions each shape has.
- Present two controls per step: variant (0 … variantGroups.length − 1) and position (0 … group.count − 1).
- Convert to a flat `selectionMode: "variant-position"` request: interleave `[v0, p0, v1, p1, …]` per room.
- **When step i changes, re-send the full request** — the engine recomputes all downstream steps in the space left by the new choice. Options for step i+1 depend on what step i selected.

### Step 6 — display

| Output | How to draw it |
|---|---|
| `geometry` | Polylines (close the loop if `closed: true`). This is the furniture symbol. |
| `smallBbox` | Optionally show as a hatched or shaded rectangle. Physical footprint. |
| `bbox` | Optionally show lighter. Clearance / transition zone. |
| `doors[].rect` + `hingeAtIndex` | Panel line from hinge to inward corner. Quarter-circle arc from inward corner to far wall point, centred on hinge. |

The `bbox` of adjacent pieces may visually overlap — that is correct by design. Only `smallBbox` must not overlap another `smallBbox`.

### Common pitfalls encountered during the Rhino plugin development

| Problem | Cause | Fix |
|---|---|---|
| All placements return "no placement found" | Polygon winding is CW or has collinear points that break polygon-clipping | Simplify polygon + enforce CCW |
| Rhino/GH freezes on solve | `stdout` and `stderr` read sequentially — stderr fills pipe buffer and deadlocks | Read both streams with async tasks in parallel |
| `Unexpected token ',' {"rooms":...` | .NET `Encoding.UTF8` prepends a UTF-8 BOM to stdin | Use `new UTF8Encoding(false)` |
| Furniture pieces overlap | Polygon has collinear intermediate vertices from CAD discretisation | Remove collinear points before sending |
| Second furniture piece ignores first choice | Downstream options not re-fetched after step 0 change | Always re-send the full request when any step changes |
| Options not sorted by quality | Engine returns options in generation order (wall × variant × position) | Score each option greedily and sort before returning (see `sortOptionsByScore` in `cli.ts`) |

---

## Setup

```powershell
cd furnisher-engine && npm install
cd ../furnisher-app  && npm install
```

## Running

```powershell
# Browser app
cd furnisher-app && npm run dev         # http://127.0.0.1:5173

# Engine Storybook (interactive per-room demo)
cd furnisher-engine && npm run storybook  # http://localhost:7007
```
