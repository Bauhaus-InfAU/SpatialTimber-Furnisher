# furnisher-for-rhino

A **Grasshopper plugin** (proof of concept) that runs the exact same
[`furnisher-engine`](../furnisher-engine) used by the React app — but driven from
Rhino geometry instead of an SVG canvas.

It reads room boundaries and door points from your Rhino **layers**, runs the
placement pipeline, and outputs the furniture line geometry and the
transition/footprint bounding boxes — and lets you **scroll through layout
variants** the same way the app and the engine Storybook do.

---

## How it reuses the engine (no fork)

The engine is TypeScript; Grasshopper is .NET. Rather than re-implement the
placement logic in C#, this PoC keeps a single source of truth:

```
Rhino layers ─▶ FurnishComponent (C#/.gha)
                      │  request JSON (rooms, doors) on stdin
                      ▼
                node furnisher-cli.cjs   ← esbuild bundle of furnisher-engine/src
                      │  response JSON (geometry, bboxes, options) on stdout
                      ▼
              Curves back into Grasshopper
```

- [`engine-cli/`](engine-cli) bundles `furnisher-engine/src` into one
  self-contained Node file (`dist/furnisher-cli.cjs`) and exposes a stdin→stdout
  JSON contract. The CLI mirrors the app's door-assignment, apartment-type
  inference, and polygon-winding normalisation so layouts match the app.
- [`plugin/`](plugin) is the Rhino 8 Grasshopper component. It shells out to the
  CLI, so the placement math is literally the same code the app runs.

---

## Prerequisites

- **Rhino 8** (the plugin targets .NET 7).
- **Node.js** on `PATH` (used at runtime by the component). `node --version`.
- **.NET SDK 7+** and **Node/npm** to build.

---

## Build & install

```powershell
cd furnisher-for-rhino
pwsh -ExecutionPolicy Bypass -File .\install.ps1
```

This builds the CLI bundle, builds `FurnisherForRhino.gha`, copies it into
`%APPDATA%\Grasshopper\Libraries`, and sets the `FURNISHER_CLI` user env var to
the built CLI. **Restart Rhino/Grasshopper** afterwards.

To build the pieces manually:

```powershell
cd engine-cli; npm install; npm run build      # -> dist/furnisher-cli.cjs
cd ../plugin;  dotnet build -c Release          # -> bin/Release/net7.0-windows/FurnisherForRhino.gha
```

---

## Layer naming convention (units = metres)

Set your Rhino document units to **Meters**. Organise geometry by layer:

| Layer name              | Contents                                              |
|-------------------------|-------------------------------------------------------|
| `01 Bedroom`            | one **closed curve** = the room boundary              |
| `02 Living room`        | one closed curve                                      |
| `03 Kitchen`            | one closed curve                                      |
| `04 Bathroom`           | one closed curve                                      |
| `05 WC`                 | one closed curve                                      |
| `06 Children 1`         | one closed curve                                      |
| `07 Children 2` …`4`    | one closed curve each                                 |
| `Doors`                 | **Point** objects, one per door, on the wall it cuts  |

Notes:
- The leading **`NN ` number is optional** — it just orders/disambiguates layers.
  A bare `Bedroom` layer works too. Everything after the number is matched to a
  room name (case-insensitive).
- Supported room names: **Bedroom, Living room, Kitchen, Bathroom, WC,
  Children 1–4**.
- Door points are assigned to whichever room boundary they lie on (within
  0.4 m), matching the app's behaviour — so a door between two rooms is shared.
- Room curves can be rectangular or L-shaped; avoid holes/self-intersections.

---

## Using the `ST Furnish` component

Find it under the **SpatialTimber ▸ Furnisher** tab. Drop it on the canvas.

**Inputs**

| Input              | What it does                                                                 |
|--------------------|------------------------------------------------------------------------------|
| `On` (Furnish)     | Connect a **Boolean Toggle** set to `true`. Reads the doc and furnishes.     |
| `Apt` (Apartment Type) | `1`–`4` size tier. Leave `0` to auto-infer from the rooms.               |
| `Var` (Variants)   | Variant index per step. A **tree**: branch `{roomIndex}`, one int per step.  |
| `CLI`              | Optional path to `furnisher-cli.cjs` (else env var / default).               |
| `Node`             | Optional Node executable (default `node`).                                   |

**Outputs**

| Output             | What you get                                                                 |
|--------------------|------------------------------------------------------------------------------|
| `R` Rooms          | The room boundary curves that were read.                                     |
| `N` Room Names     | Resolved room names (aligned with `R`).                                      |
| `Apt` Apt Type     | The apartment type actually used.                                            |
| `F` Furniture      | Furniture **line geometry**. Tree path `{room, step}`.                       |
| `T` Transitions    | **Transition / clearance** bounding boxes. Tree path `{room, step}`.         |
| `Fp` Footprints    | Physical footprint bounding boxes. Tree path `{room, step}`.                 |
| `S` Step Names     | Furniture name per step. Tree path `{room}`.                                 |
| `O` Options        | **Number of layout options per step** — your scroll range. Path `{room}`.    |
| `Sel` Selected     | Currently selected option index per step. Path `{room}`.                     |
| `W` Warnings       | Pieces that couldn't be placed, etc.                                         |

### Scrolling through variants

This is the Rhino equivalent of clicking through options in the app/Storybook:

1. Look at **`O` Options** — e.g. room 0 returns `{0;0}` = `[11, 2]`, meaning the
   Bed has 11 options and the Wardrobe has 2.
2. Feed **`Var`** a tree whose branch `{0}` holds one integer per step, e.g.
   `[5, 1]` to show Bed option #5 and Wardrobe option #1. Drive each integer with
   a slider (`0 … Options-1`) and scrub to explore layouts live. Out-of-range
   values are clamped.

Because the geometry is read from the document, the component recomputes when you
move the `Var` sliders while `On` is `true` — exactly the variant scrolling you
have in the app.

---

## Quick smoke test (no Rhino needed)

You can exercise the engine bridge directly:

```powershell
'{"rooms":[{"name":"Bedroom","polygon":[[0,0],[4.2,0],[4.2,3.6],[0,3.6]]}],"doors":[[1.8,0]],"aptType":2}' |
  node engine-cli/dist/furnisher-cli.cjs
```

You should get JSON with a `Bed` step (`optionCount` ~11) and a `Wardrobe` step,
each carrying `geometry` and `bbox` point arrays.
