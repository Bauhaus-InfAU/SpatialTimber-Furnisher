# furnisher-app

React frontend for the Spatial Timber furnisher system. Provides an interactive SVG canvas where users draw apartment floor plans, place doors, and trigger automatic furniture placement via the `furnisher-engine`.

## What it does

The app walks users through a three-step pipeline:

1. **Floor plan** — upload a reference image (PNG/JPEG), calibrate its scale, draw room polygons on top, and mark door positions.
2. **Furniture set** — currently fixed to "Scandi".
3. **Palette** — currently fixed to "Paper".

Once rooms and doors are defined, clicking **Furnish apartment** calls the engine for each room and renders the placed furniture on the canvas, along with any placement warnings.

## Directory structure

```
furnisher-app/
├── src/
│   ├── main.tsx          # React entry point
│   ├── App.tsx           # Main component — all canvas logic and state
│   ├── Sidebar.tsx       # Left sidebar: pipeline steps and furnish button
│   ├── types.ts          # Shared TypeScript types
│   ├── styles.css        # Global styles and design tokens
│   └── vite-env.d.ts     # Vite environment declarations
├── index.html
├── package.json
├── vite.config.ts        # Defines @engine / @layout / @library path aliases
├── tsconfig.json
└── tsconfig.app.json
```

## Tech stack

| Package | Version | Role |
|---|---|---|
| React | 19.2 | UI framework |
| Vite | 6.0 | Dev server and bundler |
| TypeScript | 5.9 | Type checking (strict mode) |
| polygon-clipping | 0.15 | Polygon geometry for collision detection |

## Path aliases

`vite.config.ts` maps three aliases into the sibling `furnisher-engine` package:

| Alias | Resolves to |
|---|---|
| `@engine` | `../furnisher-engine/src/engine` |
| `@layout` | `../furnisher-engine/src/layout` |
| `@library` | `../furnisher-engine/src/library` |

## Key source files

### `App.tsx`

The entire application lives in one component (~1 200 lines). Responsibilities:

- **Canvas transform** — pan by dragging the background image, zoom with the mouse wheel. Uses `svg.getScreenCTM()` to convert pointer coordinates to world space.
- **Tool selection** — `ToolId` union type covering `upload`, `scale2d`, the six room types, `doors`, and `furnish`.
- **Background image** — load, reposition, scale, rotate, adjust opacity. An "Image controls" panel appears on the right when the image is selected.
- **Scale calibration** — `scale2d` tool: click two points on the image, enter a real-world distance; the image is rescaled so those two points are exactly that far apart.
- **Room drawing** — click vertices to build a polygon; Shift+click constrains the new segment to horizontal/vertical; click near the first point to close. Rooms are stored as `DrawnRoom[]` with a type (e.g. `"Bedroom"`), vertex array, color, and optional door position.
- **Edge editing** — click a room to select it, then drag the midpoint handle on any edge to reshape it.
- **Door placement** — click within 0.75 m of a room wall to place a door on that edge.
- **Furnishing** — converts `DrawnRoom[]` to engine `Room[]`, infers apartment type from the bedroom count, calls `runRoomPipeline()` per room, and renders the returned furniture steps on the canvas.

Exported geometry utilities: `distance`, `nearestPointOnSegment`, `pointInPolygon`, `polygonCentroid`, `constrainToOrthogonal`.

SVG sub-components rendered inline: `EdgeLabels`, `RoomLabel`, `EdgeEditor`, `ScaleCalibrationLayer`, `FurniturePreview`, `DoorSwing`, `RoomLayer`, `ViewerLayer`.

### `Sidebar.tsx`

Fixed 340 px left panel. Shows room count, total area in m², and a collapsible pipeline step for each stage. The **Furnish apartment** button sits at the bottom and is wired to the furnish callback from `App`.

### `types.ts`

Core types used across the app:

```typescript
type ToolId = "upload" | "scale2d" | "Bedroom" | "Living room" |
              "Kitchen" | "Bathroom" | "WC" | "Children" | "doors" | "furnish"

type Point2D = { x: number; y: number }

type DrawnRoom = {
  id: string
  type: RoomToolId
  points: Point2D[]
  color: string
  door: Point2D | null
}

type FurnishedRoomResult = {
  roomId: string
  roomName: string
  steps: PipelineResult["steps"]
  warnings: string[]
}
```

`ROOM_TOOLS` constant defines the label, chip label, and hex color for each drawable room type.

## Engine integration

```
App draws rooms
  └─> normalizePolygonForEngine()   ensure CCW winding order
  └─> toEngineRooms()               DrawnRoom[] → engine Room[]
  └─> inferApartmentType()          count bedrooms → "1BR" | "2BR" | …
  └─> runRoomPipeline(room, type)   returns { steps[], warnings[] }
        └─> FurniturePreview        renders each step on canvas
```

Placed furniture is drawn as SVG outlines. Warnings appear in a messages panel at the bottom-left of the canvas.

## Development

```bash
npm install
npm run dev      # Vite dev server on 127.0.0.1
npm run build    # tsc then vite build
npm run preview  # preview production build
```

The dev server must be started from this directory. The engine package does not need a separate build step — the aliases resolve its source files directly.

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  SIDEBAR (340px)          │  VIEWER SURFACE (flex)      │
│  ├─ Brand + room count    │                             │
│  ├─ 01 Floor plan         │  [Background image]         │
│  │  ├─ Upload             │  [Room polygons + labels]   │
│  │  ├─ Scale 2D           │  [Door arcs]                │
│  │  └─ Room type chips    │  [Furniture outlines]       │
│  ├─ 02 Furniture set      │  [Grid]                     │
│  ├─ 03 Palette            │                             │
│  └─ Furnish button        │  [Image controls panel]     │
│                           │  [Error / warning messages] │
└─────────────────────────────────────────────────────────┘
```

## Error handling

| Situation | Behaviour |
|---|---|
| Furnish with no rooms | Error message: "Draw at least one room before furnishing" |
| Engine throws | Per-room error captured and displayed in messages panel |
| Door too far from wall | Placement silently ignored (threshold: 0.75 m) |
| Image upload wrong format | Only PNG/JPEG accepted |
| Scale points too close | Calibration rejected if distance < 0.001 m |
