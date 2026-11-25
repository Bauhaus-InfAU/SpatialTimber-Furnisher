# library

Furniture data, pipeline definition, lookup helpers, and the default-library loader.

**Imports from:** `layout` (for `RoomName`, `ApartmentLabel`, `Point2D`).

---

## Exports

| Export | Description |
|---|---|
| `defaultLibrary` | Parsed `default/furniture_library.json` |
| `defaultPipeline` | Parsed `default/placement_order.md` |
| `defaultFallbacks` | Parsed `default/fallbacks.json` (fallback pieces, optional pieces) |
| `parsePipelineMd(md)` | Parse a pipeline markdown string into a `Pipeline` object |
| `findFurniture(lib, aptType, category)` | First entry matching apt type + category |
| `findFurnitureByName(lib, aptType, category, name)` | Entry matching all three fields |
| `resolveStep(lib, aptType, category, alternatives)` | The entry of a pipeline step: the first alternative the library has for exactly this apartment type, else `resolveStepNearestType` |
| `resolveStepNearestType(lib, aptType, category, alternatives)` | The first alternative found for any apartment type (the rule before 2026-11-24; now the "next alternative") |
| `resolvePipelineStep(lib, aptType, category, alternatives, pieces?)` | A fallback piece standing in for one of the alternatives, else `resolveStep`; what the pipeline uses |
| `roomNameToCategory(name)` | `RoomName` → `FurnitureCategory` |
| `apartmentLabelToType(label)` | `ApartmentLabel` → `number` (1–4) |
| `getAllCategories(lib)` | All categories present in a library |
| `ALL_CATEGORIES` | Derived from `defaultLibrary` at startup |

---

## FurnitureEntry schema

```ts
interface FurnitureEntry {
  id:            string;
  apartmentType: number;          // 1–4
  category:      FurnitureCategory;
  furnitureName: string;          // e.g. "Bed", "Wardrobe"
  pieces:        FurniturePiece[];
}

interface FurniturePiece {
  variants: FurnitureVariant[];   // geometry variants (size/orientation)
}

interface FurnitureVariant {
  linePlacement: { points: Point2D[] };    // wall-contact edge
  bboxBig:       BboxDef;                  // full clearance zone
  bboxSmall:     BboxDef;                  // physical footprint only
  geometry:      { closed: boolean; points: Point2D[] }[];
}
```

---

## Pipeline format (`placement_order.md`)

```markdown
## Bedroom
1. Bed
2. Wardrobe

## Bathroom
1. Bathtube | Shower
2. Toilet
3. Sink
```

Section heading = room name (or "Children" for all Children N rooms).
Each numbered item is a placement step; `|` separates alternatives: the one the library has for the apartment type is used (see `resolveStep`).

---

## Fallbacks (`fallbacks.json`)

```json
{
  "penaltyPoints": 2,
  "optionalPenaltyPoints": 10,
  "optional": [ { "id": "no-dining-table", "room": "Living room", "aptTypes": [1], "furniture": "Dining", "label": "no dining table" } ],
  "rules": [ { "id": "bathtub-160", "room": "Bathroom", "aptTypes": [1, 2, 3, 4],
               "replace": { "Bathtube": "Bathtube160", "Sinc": "Sinc112" }, "label": "…" } ]
}
```

`rules` are tried in order for a room its regular pieces leave incomplete; `replace` maps a regular furniture name to the piece used instead (a name, or `{ "name", "aptType" }` to take the piece of another apartment type). `optional` lists pieces a room may do without. See [`../../../docs/2026-11-24-update.md`](../../../docs/2026-11-24-update.md).

---

## Custom overrides (`custom/`)

Copy `default/furniture_library.json` or `default/placement_order.md` into `custom/`, edit, and rebuild. The engine's `opts.library` / `opts.pipeline` params let you inject any `FurnitureLibrary` / `Pipeline` object at call time — no file system access needed at runtime.

See [custom/README.md](custom/README.md) for the copy-edit workflow.
