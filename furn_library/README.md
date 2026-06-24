# Furniture Library — Documentation

This folder contains the canonical furniture library for the **Furnisher** system, along with the tools to build and inspect it.

---

## Folder structure

```
furn_library/
├── jsons/                     ← one JSON file per furniture type per apartment type
│   ├── 1_Bathroom_Shower.json
│   ├── 3_Livingroom_Sofa.json
│   └── ...
│
├── furniture_library.json     ← THE canonical library (merged from all jsons/)
│
├── gh_export_furniture.py     ← Grasshopper Python component (paste into GH)
├── build_library.py           ← merges jsons/ → furniture_library.json
├── generate_viewer.py         ← builds viewer.html from furniture_library.json
└── viewer.html                ← interactive geometry viewer (open in browser)
```

---

## What is `furniture_library.json`?

It is the single source of truth for all furniture the system knows about. Every downstream tool (the TypeScript placement pipeline, the viewer, etc.) reads from this file.

Top-level structure:

```json
{
  "version":   "1.0",
  "generated": "2026-03-25T14:07:43Z",
  "count":     { "files": 36, "pieces": 36, "variants": 61 },
  "furniture": [ ... ]
}
```

Each entry in `furniture` describes one furniture type for one apartment type:

```json
{
  "id":            "3_Livingroom_Sofa",
  "apartmentType": 3,
  "category":      "Livingroom",
  "furnitureName": "Sofa",
  "pieces": [
    {
      "id":         "living",
      "name":       "Living",
      "importance": 1,
      "score":      20,
      "variants": [
        {
          "linePlacement": { "points": [[x, y], [x, y]] },
          "bboxBig":       { "origin": [x,y], "width": w, "height": h, "rotation": deg, "points": [[...],[...],[...],[...]] },
          "bboxSmall":     { "origin": [x,y], "width": w, "height": h, "rotation": deg, "points": [[...],[...],[...],[...]] },
          "geometry":      [ { "closed": true, "points": [[x,y], ...] } ]
        }
      ]
    }
  ]
}
```

**Key concepts:**

- `apartmentType` — integer room-count label (1, 2, 3, 4 …)
- `category` — room name (`Bathroom`, `Kitchen`, `Livingroom`, `Bedroom`, `Children`, `WC`)
- `importance` — how critical this piece is for the room (1 = must-have)
- `score` — weight used by the placement algorithm
- `variants` — different orientations or configurations of the same piece
- `linePlacement` — the wall edge (or corner) the piece must be placed against
- `bboxBig` / `bboxSmall` — outer and inner bounding rectangles for placement collision
- `geometry` — the actual 2-D outline curves for visualisation

---

## How to extend the library

There are two ways to add new furniture or modify existing pieces.

---

### Way 1 — Through Grasshopper (recommended for new geometry)

This is the right approach when you are adding a completely new piece, modifying geometry, or adjusting placement parameters.

#### Step 1 — Set up the data in Grasshopper

Open the Grasshopper file. Each furniture piece is modelled as a Merge component that entwines the following data in order:

| Index | Content | Type |
|-------|---------|------|
| 0 | Piece name (e.g. `"Sofa"`) | Text |
| 1 | Placement line or polyline | Curve |
| 2 | Importance (integer) | Number |
| 3 | Score (integer) | Number |
| 4 | `bboxBig` rectangle | Curve |
| 5 | `bboxSmall` rectangle | Curve |
| 6+ | Geometry curves or groups | Curves / Groups |

If a piece has multiple variants (e.g. a sofa that can face left or right), duplicate the Merge component for each variant and connect them all into an Entwine node. The exporter reads the resulting DataTree where each path `{piece; variant}` is one variant of one piece.

#### Step 2 — Connect the exporter component

Paste the contents of `gh_export_furniture.py` into a **GHPython** component. Wire up the six inputs:

| Input | Type | Description |
|-------|------|-------------|
| `i_data` | **Tree** / Generic | The Entwine output (right-click → Tree Access) |
| `i_apartment_type` | Item / Integer | Apartment type number (1–4) |
| `i_room_tag` | Item / Text | Room name, e.g. `Livingroom` |
| `i_furn_name` | Item / Text | Furniture name, e.g. `Sofa` |
| `i_out_folder` | Item / Text | Full path to the `jsons/` folder |
| `i_run` | Item / Boolean | Set to `True` to export |

> **Tip — debug mode:** Set `i_run = False` to print a detailed inspection of every item in the tree without writing any files. Use this to verify the data is wired correctly before exporting.

#### Step 3 — Export

Set `i_run = True`. The component writes a single file:

```
jsons/{apartmentType}_{Room}_{FurnName}.json
```

For example: `jsons/3_Livingroom_Sofa.json`.

Re-export every piece you have changed. Pieces you did not touch do not need to be re-exported — the old JSON files remain valid.

#### Step 4 — Rebuild the library

Open a terminal in the `furn_library/` folder and run:

```bash
python build_library.py
```

This merges all files in `jsons/` into `furniture_library.json`. It will print a warning if it finds two files with the same ID (same apartment type + room + name), so you can catch accidental duplicates.

#### Step 5 — Regenerate the viewer

```bash
python generate_viewer.py
```

Open `viewer.html` in any browser to verify the geometry looks correct.

---

### Way 2 — Directly editing `furniture_library.json`

This is the right approach for small, non-geometric changes: adjusting `importance` or `score` values, renaming a category, adding an entirely new piece whose geometry you already have as coordinate data, or removing a piece that is no longer needed.

**You do not need Grasshopper or Python for this — a text editor is enough.**

#### Adding a new furniture entry

Append a new object to the `"furniture"` array. Follow the schema exactly. The minimum valid entry looks like this:

```json
{
  "id":            "2_Bedroom_Wardrobe",
  "apartmentType": 2,
  "category":      "Bedroom",
  "furnitureName": "Wardrobe",
  "pieces": [
    {
      "id":         "wardrobe",
      "name":       "Wardrobe",
      "importance": 2,
      "score":      15,
      "variants": [
        {
          "linePlacement": { "points": [[0.0, 0.0], [2.0, 0.0]] },
          "bboxBig":  {
            "origin": [0.0, 0.0], "width": 2.0, "height": 0.6, "rotation": 0.0,
            "points": [[0.0,0.0],[2.0,0.0],[2.0,0.6],[0.0,0.6]]
          },
          "bboxSmall": {
            "origin": [0.0, 0.0], "width": 2.0, "height": 0.55, "rotation": 0.0,
            "points": [[0.0,0.0],[2.0,0.0],[2.0,0.55],[0.0,0.55]]
          },
          "geometry": [
            { "closed": true, "points": [[0.0,0.0],[2.0,0.0],[2.0,0.6],[0.0,0.6]] }
          ]
        }
      ]
    }
  ]
}
```

Rules to follow:
- `"id"` must be unique across the whole file. Use the pattern `{apartmentType}_{Category}_{FurnName}` with no spaces.
- All coordinates are in **metres**, matching the Rhino model units.
- `"points"` in `bboxBig`/`bboxSmall` must list the 4 corners in order (the viewer uses them directly to draw the rectangle).
- If a piece has multiple variants, add one object per variant to the `"variants"` array.

#### Modifying an existing entry

Search for the entry by `"id"` and edit the relevant fields in place. For example, to change the score of the sofa for 3-room apartments, find `"id": "3_Livingroom_Sofa"` and update `"score"` inside its piece.

#### Removing an entry

Delete the entire object (from `{` to the matching `}`) from the `"furniture"` array. Make sure the array remains valid JSON — no trailing comma on the last entry.

#### After any manual edit

Update the `"generated"` timestamp and `"count"` fields at the top of the file so that anyone reading the file knows it was hand-edited:

```json
"generated": "2026-03-25T15:30:00Z",
"count": { "files": 37, "pieces": 37, "variants": 63 }
```

Then regenerate the viewer to verify the changes visually:

```bash
python generate_viewer.py
```

---

## Workflow summary

```
Grasshopper model
      │
      │  gh_export_furniture.py  (one component per piece)
      ▼
  jsons/*.json
      │
      │  python build_library.py
      ▼
  furniture_library.json  ◄──── or edit directly
      │
      │  python generate_viewer.py
      ▼
  viewer.html
```

---

## Coordinate system

All geometry is stored in **Rhino world XY coordinates, in metres**. The Y axis points up in the 2-D floor plan view. The viewer flips Y when drawing on canvas (`H - y`) so the floor plan appears right-side-up in the browser.

---

## File naming convention for `jsons/`

```
{apartmentType}_{Category}_{FurnitureName}.json
```

Examples: `1_Bathroom_Shower.json`, `3_Livingroom_Sofa.json`, `4_Children_Bed.json`

The apartment type is an integer matching the room count. Category must exactly match the room name used in the rest of the system (case-sensitive). Furniture name should be short and descriptive, no spaces.
