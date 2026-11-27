# The update of 2026-11-27: Swiss bathrooms

What changed in the Furnisher on 2026-11-27, why, what it measured, and how to take it back. Written for the repository's author and for a coding agent that opens the repository without any other context.

## Who and why

The changes were made for the Grundrisssammlung (floor plan collection) of the Konzeptstudie Zweispänner on entwurfsforschung.de (Bauhaus-Universität Weimar, Chair for Informatics in Architecture and Urbanism), by Reinhard König with an AI coding agent (Claude). The collection shows all 44,735 apartments with 1 to 6 rooms of the open dataset Swiss Dwellings v3.0.0 (Standfest et al., Zenodo, doi:10.5281/zenodo.7788422, CC BY 4.0) and furnishes every apartment with this program, through `furnisher-batch.cjs`.

In the first run the bedrooms, living rooms and kitchens were furnished in 85–95 % of the rooms, but only 44 % of the bathrooms and 19 % of the WCs. Two causes: most Swiss plans are rotated (the dataset keeps north up), and Swiss bathrooms are small (median 3.1 m² in the bathrooms under 4 m²).

## Commits

| Commit | Change |
|---|---|
| `74cd2a0` | (a) exact clearance overlap test in rotated rooms; (b) compact Swiss bathroom fallback pieces and rules |
| `567de3c` | (c) option `doorSwingArc`: the door zone is the quarter circle the leaf sweeps |

## (a) Exact overlap test in rotated rooms – changes the default behaviour

`aabbOverlap` in `furnisher-engine/src/engine/pipeline.ts` (the strict clearance rule) compared axis-aligned bounding boxes. In a rotated room the bounding box of a rotated clearance zone is far larger than the zone, valid options were rejected ("all placements interfere with clearance zones – using best available"), the step fell back to the unfiltered list and the room ended with overlapping pieces. The function now uses the separating axis test, which is exact for the convex rectangles it gets; the name is kept. For axis-aligned rectangles the result is the same as before, so axis-aligned rooms are unchanged.

Measured on the same 4,000 Swiss bathrooms and WCs: bathrooms of 4–6 m² rotated by more than 2°, furnished 59 % → 71 % (axis-aligned: 87 %). The rest of the gap closes when the caller rotates the apartment to its main axis before furnishing (82 %); other parts of the placer apparently still prefer axis-aligned walls. That is left as it is here; the collection rotates each apartment by the length-weighted main direction of its walls and rotates the furniture back.

## (b) Compact Swiss bathroom – only when the regular pieces fail

New pieces made by `furn_library/make_fallback_pieces.py` (section "Compact Swiss bathroom"), measured on the fixtures of 5,150 bathrooms under 4 m² in Swiss Dwellings:

| Piece | Instead of | Measured in Swiss bathrooms |
|---|---|---|
| `BathtubeCH` 1.50 × 0.70 m | 1.70 × 0.75 m | length median 1.64, p10 1.50; depth median 0.70 |
| `ShowerCH` 0.80 × 0.80 m | 0.90 × 0.90 m | median 0.84 × 0.81, p10 0.74 |
| `ToiletCH`, free area 0.70 m wide (0.15 m beside the WC) | 0.90 m (0.25 m) | free space beside the WC p25 0.10 and 0.18 m |
| `SincCH`, free area 0.66 × 1.12 m (0.08 m beside, 0.68 m in front) | 0.90 × 1.15 m | beside the basin p25 0.03 and 0.15 m; in front p10 0.73 m |

The depth in front of WC and basin is kept (Swiss p10: 0.62 and 0.73 m). Rules in `fallbacks.json`, after `bathtub-160`: `bath-compact-ch` (all four), `bath-compact-ch-shower` (shower instead of bathtub, apartment types 3–4) and `wc-compact-ch`. `make_fallback_pieces.py` can now take a source piece of another apartment type (`(destination, source)` in the type list) because the library has showers only for types 1–2. A room that the regular pieces furnish is furnished exactly as before.

## (c) Option `doorSwingArc` – off by default

Request flag `doorSwingArc` → `Room.doorArc` (`layout/types.ts`, `engine/apartment.ts`, CLI `batch.ts`). With it, the door zone subtracted from the footprint space (`initialChain` in `pipeline.ts`, new `getDoorZones` in `placer.ts`) and the door obstacles of the ray checks (`getDoorObstacleSegments`) are the quarter circle around the hinge instead of the full dw × dw square; the hinge is the jamb nearer a room corner, as `pickHingeIndex` in `apartment.ts`. Pieces still keep out of the sweep, the corner opposite the hinge becomes usable. The clearance zones could already reach over the door zone before (they are checked against the room minus the footprints only). `getDoorRectangles` and the `doors` of the response are unchanged.

## Measured

4,000 bathrooms and WCs drawn at random from the Swiss apartments (`Grundrisse/sammlung/werkzeuge/baeder_test.py` in the Planungsgrundlagen repository), rotated to their main axis, all three changes:

| Rooms | Before | After |
|---|---|---|
| Bathrooms ≥ 6 m² | 90–100 % | 100 % |
| Bathrooms 4–6 m² | 59–87 % | 97 % |
| Bathrooms < 4 m² | 9–19 % | 61–65 % |
| WCs | 18–33 % | 36–49 % |
| All 4,000 | 39 % | 72 % |

`npm test` in `furnisher-for-rhino/engine-cli`: 16 of 16 cases unchanged.

## How to take it back

Revert `567de3c` (option, inactive unless a caller sets it), `74cd2a0` (overlap test and compact pieces), then run `python furn_library/make_fallback_pieces.py`, `python furn_library/build_library.py`, copy `furniture_library.json` to `furnisher-engine/src/library/default/` and rebuild the CLI.
