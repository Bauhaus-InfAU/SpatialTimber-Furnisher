# Room Furnishing Pipelines

Defines the order in which furniture is placed per room type.

## Editing rules
- Section headings (`##`) must match the `RoomName` values in `types.ts`.
  Children rooms (`Children 1` through `Children 4`) all share the `## Children` section below.
- Each numbered list item is one placement step. Order matters — earlier pieces are placed first and their footprint is subtracted before the next step runs.
- Furniture names must match the `furnitureName` field in the furniture library exactly (case-sensitive).
  Valid names: `Bed`, `Wardrobe`, `Sofa`, `Dining`, `Kitchen`, `Sinc`, `Toilet`, `Bathtube`, `Shower`
- Use ` | ` to list alternatives for steps where the furniture type depends on apartment size
  (e.g. `Bathtube | Shower`). The pipeline picks whichever name the library has for the current apartment type, in left-to-right order.
- The pipeline validates all names against the library before running. Missing names log a warning and the step is skipped — they do not crash the run.
- To reorder: change the numbering. To add a piece: insert a new numbered line. No code changes needed.

---

## Bedroom
1. Bed
2. Wardrobe

## Children
1. Bed
2. Wardrobe

## Living room
1. Sofa
2. Dining

## Kitchen
1. Kitchen

## Bathroom
1. Bathtube | Shower
2. Toilet
3. Sinc

## WC
1. Toilet
2. Sinc
