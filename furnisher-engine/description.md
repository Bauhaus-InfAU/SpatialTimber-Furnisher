# Furnisher Engine

TypeScript port of a Grasshopper/Python furniture auto-placement pipeline. Given a room shape and a furniture library, it finds all valid positions for a piece of furniture and outputs the transformed geometry + updated room polygons for iterative placement.

Runs entirely in the browser (no server). Visualised via Storybook + HTML Canvas.

---

## Stack

- **TypeScript + Vite** — pure logic, no external runtime deps except `polygon-clipping`
- **React** — canvas wrapper component only
- **Storybook** — interactive playground for every stage
- **polygon-clipping** — boolean polygon subtraction (Stage 4)

---

## Data Model

### Room (`types.ts`)
```
Room {
  name:    RoomName          // "Bedroom" | "Kitchen" | "Bathroom" | ...
  polygon: Point2D[]         // closed 2-D outline, metres, no repeated first point
  door:    Point2D           // point on a wall where the door sits
}
```
Rooms can be rectangular or L-shaped. All coordinates are in **metres**.

### Furniture Library (`furnitureTypes.ts`)
Each `FurnitureEntry` has one or more `FurniturePiece`s, each with multiple `FurnitureVariant`s (rotations / mirror variants). Every variant carries:

| Field | Meaning |
|---|---|
| `linePlacement` | 1-3 points defining the wall-contact edge (2 pts = line, 3 pts = L-corner) |
| `bboxBig` | Full clearance zone (furniture + pathway in front) |
| `bboxSmall` | Physical footprint only |
| `geometry` | Actual drawable curves |

---

## Room Generator (`roomGenerator.ts`)

`generateSingleRoom(name, seed)` — deterministic seeded generator.

- Picks apartment type (Studio → 5-Bedroom) from weighted random
- Draws room dimensions from per-room size ranges (e.g. Bedroom: 3.2–5.5 × 3.5–5.0 m)
- Randomly applies an L-shaped notch (per-room probability, e.g. Living room 65%)
- Places a door on a random wall, avoiding corners

---

## Placement Logic (`furniturePlacer.ts`)

### Stage 0 — Extract furniture dimensions
From the source variant's `linePlacement` and `bboxBig`/`bboxSmall`, compute:
- `linePlacementLength` — wall-contact width
- `depthBig` / `depthSmall` — inward depths via projection onto source frame's Y-axis

### Stage 1 — Wall candidates
For every polygon edge, compute an **extended wall length**:
- Shoot rays from both endpoints along the wall direction to the nearest opposite room wall
- Each extension is capped at `physLen` per side (max 1× the edge length)
- Guard: only extend if the direction from the endpoint immediately enters the room interior (prevents shooting through L-notch exteriors)
- Discard walls shorter than `linePlacementLength`

### Stage 2 — Usable segment (ray casting)
For each wall candidate, subdivide into 40 samples and cast two perpendicular rays per sample:

| Ray | Checks against | Purpose |
|---|---|---|
| `bigOk` | Full room polygon | Clearance zone fits inside room walls |
| `smallOk` | Room + door obstacle rectangle | Physical footprint avoids door swing area |

Door obstacle = 3-segment rectangle of width `dw` (0.9 m standard, 0.8 m bathroom) swept inward from the door point.

A contiguous run of valid samples defines the **usable segment**. Binary refinement on the start boundary recovers sub-sample precision.

### Stage 3 — Target frame & transform
Build a 2-D affine frame at the placement position:
- `origin` = wall start + offset along wall
- `xAxis` = wall direction (flipped for mirrored variants)
- `yAxis` = inward normal

Apply `transformPoint(src, tgt)` to all geometry, `bboxBig`, and `bboxSmall`.

**Placement offsets** (mirroring GH Stage 3):
- Always: centered
- If wall ≥ 1.4× furniture width: also flush-start and flush-end

**Post-placement check**: all `bboxSmall` corners must be inside the room polygon (1% inset toward centroid to avoid boundary false-rejections).

### Kitchen — Special L-corner algorithm (`getKitchenPlacements`)
Kitchen variants use a **3-point `linePlacement`** encoding an L-shape:
`lp[0]` = arm-1 end, `lp[1]` = L-corner, `lp[2]` = arm-2 end.

For each 90° room corner:
1. **Wall length check** — extended wall ≥ arm length for both arms
2. **Reduced length check** — distance from corner to door gap ≥ arm length (no arm crosses door opening)
3. **70 cm depth raycast** — 20 midpoint-sampled rays along each arm, against room + door obstacles

Single fixed assignment: arm-1 → next wall, arm-2 → prev wall (avoids mirror duplicates).

---

## Stage 4 — Room Subtraction (`roomSubtraction.ts`)

After a placement, two updated room polygons are computed using **`polygon-clipping`** (Clipper-based boolean ops):

| Polygon | Formula | Meaning |
|---|---|---|
| `roomFull` | `room − smallCutout` | Walkable area after furniture footprint removed |
| `roomRdc` | `room − doorRect − largeCutout` | Clearance budget after door zone + pathway removed |

**Cutout polygons** stored on `PlacedFurniture`:
- Regular furniture: `smallCutout = bboxSmall` (4-corner rect), `largeCutout = bboxBig` (4-corner rect)
- Kitchen: `smallCutout` = **6-corner L-polygon** (arm2End → corner → arm1End → 3 inward points at 70 cm depth), `largeCutout = bboxBig` rect

If the subtraction splits the room into disconnected regions, the **largest region** is selected.

These polygons are the input for the next furniture placement pass.

---

## Visualisation (`RoomWithFurnitureCanvas.tsx`)

HTML Canvas component. Coordinate system: metres → pixels via linear transform with 5% padding.

| Layer | Colour | Toggle |
|---|---|---|
| Grid | dark lines | `showGrid` |
| Room polygon | light fill + stroke | always |
| Door symbol | arc + line | `showDoors` |
| Furniture geometry | light fill | always |
| `bboxBig` | dashed red | `showBbox` |
| `bboxSmall` | solid amber | `showBbox` |
| Wall segment | green | `showBbox` |
| `roomFull` after subtraction | teal semi-transparent | `showStage4` |
| `roomRdc` after subtraction | amber semi-transparent | `showStage4` |

---

## File Map

```
src/
  core/
    types.ts              — Room, Point2D, Apartment
    furnitureTypes.ts     — FurnitureEntry, FurnitureVariant, library schema
    furniturePlacer.ts    — all placement logic (Stages 0–3 + Kitchen)
    roomSubtraction.ts    — Stage 4 boolean subtraction
    roomGenerator.ts      — seeded procedural room generator
    furnitureLookup.ts    — query furniture library by category/apartment type
    seededRandom.ts       — deterministic PRNG
  components/
    RoomWithFurnitureCanvas.tsx — canvas renderer
  stories/
    FurniturePlacement.stories.tsx — interactive Storybook playground
    RoomGenerator.stories.tsx      — room shape explorer
```
