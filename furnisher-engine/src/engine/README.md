# engine

Pure placement logic: wall analysis, ray checks, transforms, boolean subtraction, and the pipeline runner.

**Imports from:** `layout` (geometry types), `library` (furniture data, lookup, defaults).

---

## Exports

| Export | Description |
|---|---|
| `runRoomPipeline(room, aptType, opts?)` | Place all furniture for a room; returns first valid placement per step |
| `runRoomPipelineAt(room, aptType, indices, opts?)` | Same but exposes all placements per step for interactive navigation |
| `scoreRoom(roomName, pipelineResult)` | Compute 0–100 quality score from a `PipelineWithOptions` result |
| `getAllPlacements(room, entry, opts?)` | All valid (variant × position) placements for one entry |
| `getFlexibleKitchenPlacements(room, aptType, name, opts?)` | Kitchen laid out from 0.6 m modules along the room's own walls (see below) |
| `kitchenModuleCount(aptType)` | Modules a kitchen gets: 4 / 6 / 6 / 8 by apartment type |
| `placeFurniture(room, entry, opts?)` | First valid placement, or null |
| `subtractPolygon(poly, cutout)` | Boolean difference → largest remaining region |
| `subtractPlacement(room, placed)` | Returns updated `roomFull` and `roomRdc` after one piece |
| `getDoorRectangle(room)` | 4-corner door swing rectangle |
| `doorWidth(roomName)` | 0.8 m (Bathroom/WC) or 0.9 m |

---

## Flexible kitchen

`opts.flexibleKitchen` on either pipeline runner swaps the Kitchen step from the
library's rigid preset counter to `kitchenFlex.ts`, which lays 0.60 × 0.60 modules
along the room's own walls — straight, or turning one inner corner into an L that
shares its corner module. Corners need not be square (70°–110° qualifies): both
the shared corner cell and the counter's inner edge are mitred, so on a slanted
wall the run stays flush and its transition zone stays parallel to each wall. Fridge, sink and hob are then assigned to modules by
work-triangle rules (NKBA, reduced to the module grid); every other module is
plain counter. Each non-blind module keeps a 0.60 m transition zone in front;
zones may overlap each other, which is what lets the L close up.

It places kitchens in rooms the preset route gives up on (irregular outlines,
narrow galleys) and falls back one module at a time — a 5-module kitchen beats no
kitchen — before relaxing the transition-zone requirement as a last resort.
Output is an ordinary `PlacementOption`, so nothing downstream needs a special case.

---

## Inputs

```ts
// From layout block:
interface Room {
  name:    RoomName;
  polygon: Point2D[];   // CCW, no repeated first vertex
  door:    Point2D;     // centre of door opening
}

// From library block:
interface FurnitureEntry {
  apartmentType: number;
  category:      FurnitureCategory;
  furnitureName: string;
  pieces:        FurniturePiece[];   // pieces[0].variants drives placement
}
```

See [layout/README.md](../layout/README.md) and [library/README.md](../library/README.md).

---

## Outputs

```ts
interface PipelineResult {
  steps:    PipelineStep[];   // one per successful placement
  warnings: string[];         // skipped steps with reasons
}

interface PipelineStep {
  furnitureName: string;
  placed:        PlacedFurniture;
}

interface PlacedFurniture {
  transformedGeometry:  { closed: boolean; points: Point2D[] }[];
  transformedBbox:      Point2D[];   // full clearance zone
  transformedSmallBbox: Point2D[];   // physical footprint
  smallCutout:          Point2D[];   // subtract from room_full
  largeCutout:          Point2D[];   // subtract from room_rdc
  wallSegment:          [Point2D, Point2D];
}
```

---

## Runtime override

Pass custom library / pipeline via `opts`:

```ts
runRoomPipeline(room, aptType, { library: myLib, pipeline: myPipeline })
```

Defaults to whatever `library/loader.ts` resolved at startup.

---

## Scoring

`scoreRoom(roomName, pipelineResult)` converts a `PipelineWithOptions` result into a 0–100 quality score.

```ts
import { runRoomPipelineAt, scoreRoom } from "./src/engine";

const result = runRoomPipelineAt(room, aptType, indices);
const { score, steps } = scoreRoom(room.name, result);
// score: 0–100 (e.g. 84.0)
// steps: per-furniture breakdown with optionCount, nodeScore, levelWeight
```

**Output types:**

```ts
interface StepScore {
  furnitureName: string;
  optionCount:   number;  // allOptions.length
  nodeScore:     number;  // 0 | 0.75 | 1.0
  levelWeight:   number;  // weight used in the room formula
}

interface RoomScore {
  roomName: string;
  score:    number;       // 0–100, 1 decimal place
  steps:    StepScore[];
}
```

**Node scoring:** `0 variants → 0.0`, `1 variant → 0.75`, `2+ variants → 1.0`

**Level weights** (how much each furniture piece contributes):

| Room | Step 1 | Step 2 | Step 3+ |
|---|---|---|---|
| Bedroom | 0.6 | 0.4 | — |
| Children | 0.7 | 0.3 | — |
| All others | 1/N | 1/N | 1/N |

---

## Placement stages (0–3 + pipeline)

| Stage | Description |
|---|---|
| 0 | Extract wall-contact width and depth from `bboxBig` / `bboxSmall` |
| 1 | Find wall candidates: long enough, pass walls_must filter, optional extension |
| 2 | Ray-cast along each candidate: bigOk vs `collisionPolygon`, smallOk vs `edgePolygon` |
| 3 | Transform furniture geometry into target frame; containment check |
| Pipeline | Subtract previous footprint → feed updated polygons to next step |
