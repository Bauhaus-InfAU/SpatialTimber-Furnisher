# Neufert 4.0 benchmark

Runs the furnisher engine over the [Neufert 4.0 dataset](https://zenodo.org/records/14223942)
(20,419 Swiss apartments derived from the Swiss Dwellings dataset) and scores
every apartment. Dataset CSVs live in `../neufert swiss dataset/` (gitignored,
443 MB — download from Zenodo).

## Pipeline

```
neufert swiss dataset/geometries_w_outlines.csv
        │  python convert.py
        ▼
out/requests.jsonl            one engine request per UNIQUE apartment layout
out/apartments_index.csv      all apartments + duplicate-group mapping
        │  node ../furnisher-for-rhino/engine-cli/dist/furnisher-batch.cjs
        ▼
out/results_chunk*.jsonl      per-room scores, option counts, warnings
        │  python merge_results.py
        ▼
out/results.jsonl             merged raw results
out/scores.csv                one row per apartment (dups expanded), analysis-ready
```

## Steps

```powershell
# 1. Convert (about 2 min)
python convert.py

# 2. Build the batch runner once
cd ..\furnisher-for-rhino\engine-cli; npm install; npm run build; cd ..\..\neufert-benchmark

# 3. Run (single process ~100 min, or chunked in parallel with --offset/--limit)
node ..\furnisher-for-rhino\engine-cli\dist\furnisher-batch.cjs out\requests.jsonl out\results_chunk0.jsonl

# 4. Merge + flat score table
python merge_results.py
```

## What convert.py does

- Parses WKT room polygons, cleans them (dedupe, collinear removal, CCW).
- Maps dataset subtypes to engine room names: KITCHEN→Kitchen; LIVING_* / DINING /
  STUDIO→Living room; BATHROOM→Bathroom when a bathtub/shower feature is inside,
  else WC; BEDROOM + generic ROOM→sleeping pool (largest→Bedroom, rest→Children 1..4;
  largest generic ROOM promoted to Living room when the apartment has none).
  CORRIDOR and outdoor/service areas are skipped.
- Doors/windows: opening-polygon centroids, assigned to rooms by proximity
  (0.4 m / 0.5 m) — same threshold the engine CLI uses.
- **Canonical frame**: each apartment is rotated so its dominant wall direction
  (edge-length weighted, mod 90°) is axis-aligned, and coordinates are snapped
  to millimetres. This makes scores comparable across apartments and avoids most
  polygon-clipping robustness failures on the dataset's arbitrary rotations.
  The applied angle is stored in `apartments_index.csv` (`rotation_deg`).
- **Duplicate detection**: apartments are grouped by a rotation/translation-invariant
  signature (per-room name + sorted edge lengths + door count). Only one
  representative per group is run (~26% of the dataset are duplicates);
  `merge_results.py` copies results back onto all members.

## Batch runner behavior

- One bad room cannot kill an apartment (per-room error isolation in engine-cli
  `core.ts`).
- Rooms that hit polygon-clipping's "Unable to complete output ring" are retried
  with tiny input perturbations (+0.7° rotation, then ±0.7 mm jitter) and merged
  per room; `recovered: 1|2` marks rescued rooms. Residual failure rate ~2% of rooms.

## scores.csv columns

`apt_score_area_weighted` is the headline apartment score (per-room engine scores,
0–100, weighted by room area; failed rooms excluded, see `n_failed_rooms`).
Per-category columns give mean score / zero-score count / room count for
Living room, Kitchen, Bathroom, WC, Bedroom, Children.
`number_of_rooms_dataset`, `total_area`, `floor` are joined from
`apartment_simulations.csv` for correlation analysis.
