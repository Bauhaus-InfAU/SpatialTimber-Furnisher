# library

Furniture data, pipeline definition, lookup helpers, and the default-library loader.

**Imports from:** `layout` (for `RoomName`, `ApartmentLabel`, `Point2D`).

---

## Exports

| Export | Description |
|---|---|
| `defaultLibrary` | Parsed `default/furniture_library.json` |
| `defaultPipeline` | Parsed `default/placement_order.md` |
| `parsePipelineMd(md)` | Parse a pipeline markdown string into a `Pipeline` object |
| `findFurniture(lib, aptType, category)` | First entry matching apt type + category |
| `findFurnitureByName(lib, aptType, category, name)` | Entry matching all three fields |
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
Each numbered item is a placement step; `|` separates fallback alternatives tried in order.

---

## Custom overrides (`custom/`)

Copy `default/furniture_library.json` or `default/placement_order.md` into `custom/`, edit, and rebuild. The engine's `opts.library` / `opts.pipeline` params let you inject any `FurnitureLibrary` / `Pipeline` object at call time — no file system access needed at runtime.

See [custom/README.md](custom/README.md) for the copy-edit workflow.
