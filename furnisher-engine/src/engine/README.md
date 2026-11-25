# engine

Pure placement logic: wall analysis, ray checks, transforms, boolean subtraction, and the pipeline runner.

**Imports from:** `layout` (geometry types), `library` (furniture data, lookup, defaults).

---

## Exports

| Export | Description |
|---|---|
| `furnishApartment(request, opts?)` | Furnish a whole apartment (`apartment.ts`): room names, polygons, doors per room, open kitchens and passages, every room through `furnishRoom`, the worktop extension and the bar, the apartment summary. The CLI and the app call this |
| `apartmentSummaryOf(rooms, roomAnswers)` | The apartment's score and "every room furnished" for a request's rooms (`summarizeApartment` with each room's `area` or polygon area) |
| `detectOpenKitchens(rooms)`, `openKitchenHint`, `splitPassages` | Which kitchens are open and where (`openKitchen.ts`); door points on an opening are passages |
| `planKitchenBars(kitchen, counter, livingRooms, gap)` | Bars that fit beside an open kitchen's counter, best first (`kitchenBar.ts`) |
| `furnishRoom(room, aptType, opts?)` | Furnish a room the way the app and the CLI do: regular pieces at their ranked positions, then at other positions, then the step's other alternative, then the fallback pieces of `fallbacks.json` (`furnish.ts`) |
| `scoreFurnishedRoom(roomName, result, fallback, aptType?, fallbacks?)` | The room's score less the fallback's and an optional piece's points, and whether it counts as furnished |
| `summarizeApartment(rooms)` | Area-weighted apartment score (2 decimals) and whether every room counts as furnished |
| `sortOptionsByScore`, `searchOtherPositions`, `roomFurnished`, `pieceOverlaps` | The parts of `furnishRoom` (see `furnish.ts`) |
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

## Open kitchens

`furnishApartment` decides once per apartment which kitchens are open (`openKitchen.ts`): the room's `open` flag, else its `subtype` ("Open kitchen" open, "Kitchen" closed), else geometry (kitchen and living room closer than 1 cm along parallel, overlapping edges, at least 0.6 m in total). The open stretches go on both rooms as `Room.openSegments`; the kitchen also gets `openKitchen: true` and `extendInto` (the living rooms across the opening).

- The kitchen step of an open kitchen always uses the modular placer: I, L or II (two facing strips), no module backing onto an opening, 0.9 m of the opening free. Runs are ranked toward a worktop target (`kitchenUsableTarget`: 3 appliance modules plus 3 worktop modules, at least the module count of the apartment type).
- Short of the target inside its own walls, one leg may run on past the opening along a living-room wall (`EXT_MAX`, 2 modules, no appliances). The placement carries `extension` (zones to reserve in the living room). `furnishApartment` keeps it only if the living room, furnished around it, loses no piece, no score and stays furnished.
- The bar (`kitchenBar.ts`) stands in the kitchen on the opening; its stool zone is reserved in the living room (`Room.reserved`) under the same rule.
- In the living room, wall-backed pieces do not back onto the opening and a freestanding table keeps 0.6 m off it.
- No preset kitchen comes back: `furnishRoom` gives a modular kitchen step (open kitchen or `flexibleKitchen`) no other alternative and no fallback piece.

With `roomsInsideWalls: true` in the request, door and window points up to 0.16 m off a room's outline are moved onto it (rooms drawn inside their walls, openings on the wall centre lines).

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

Further options: `openSegments`, `openKitchen`, `reserved`, `extendInto` on the room (set by `furnishApartment`, see Open kitchens), `pieces` (fallback pieces that stand in for regular ones, as `furnishRoom` sets them), `polygonSimplified` (the caller has already simplified the polygon, as the CLI does), and for `furnishRoom` `fallbacks` (default `fallbacks.json` only when no custom library or pipeline is given) and `searchRuns` (bound of the search for other positions, default 300, 0 = off).

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
