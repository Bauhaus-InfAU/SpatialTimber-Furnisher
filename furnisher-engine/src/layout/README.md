# layout

Room polygon generation and geometry types consumed by the engine.

**No imports from other blocks.** Standalone.

---

## Exports

| Export | Description |
|---|---|
| `Point2D` | `[number, number]` tuple |
| `Segment` | `{ start, end }` |
| `Room` | `{ name, polygon, door }` |
| `RoomName` | Union of 9 room type strings |
| `Apartment` | `{ label, rooms[] }` |
| `ApartmentLabel` | Union of 7 apartment label strings |
| `generateApartment(seed)` | Full apartment from integer seed |
| `generateSingleRoom(name, seed)` | Single room, for isolated testing |
| `makePrng(seed)` | Seeded PRNG (mulberry32) |

---

## Room shape

```ts
interface Room {
  name:    RoomName;
  polygon: Point2D[];   // closed polygon, last point ≠ first
  door:    Point2D;     // centre of the door opening on a wall
}
```

`polygon` is a CCW-wound list of 2D vertices in metres. Rectangular rooms have 4 vertices; L-shaped rooms have 6. The last vertex does **not** repeat the first — edges are `polygon[i] → polygon[(i+1) % n]`.

`door` sits on the nearest polygon edge. Door width: 0.9 m for most rooms, 0.8 m for Bathroom / WC.

---

## External room sources

Any code that produces a `Room` object (e.g. a future Rhino/Grasshopper bridge) must satisfy:
- `polygon` — at least 4 vertices, CCW wound, no degenerate edges.
- `door` — a point within 0.01 m of a polygon edge that is at least as long as the door width.
