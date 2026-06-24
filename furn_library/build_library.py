"""
FURNITURE LIBRARY BUILDER
=========================
Merges all individual *.json exports from ./jsons/ into a single
furniture_library.json that serves as the canonical collection.

Schema of output file:
{
  "version":   "1.0",
  "generated": "<ISO timestamp>",
  "count":     { "files": N, "pieces": N, "variants": N },
  "furniture": [
    {
      "id":            "3_Livingroom_Sofa",   // unique key
      "apartmentType": 3,
      "category":      "Livingroom",
      "furnitureName": "Sofa",
      "pieces": [ ... ]                       // verbatim from source JSON
    },
    ...
  ]
}

Usage:
    python build_library.py

Output:
    furniture_library.json  (same folder as this script)

To add new pieces later:
  - Drop a new *.json into ./jsons/ and re-run this script, OR
  - Append an entry directly to furniture_library.json following the schema above.
"""

import glob
import json
import os
from datetime import datetime, timezone

HERE        = os.path.dirname(os.path.abspath(__file__))
JSONS_DIR   = os.path.join(HERE, "jsons")
OUTPUT      = os.path.join(HERE, "furniture_library.json")


def source_id(data: dict, filename: str) -> str:
    """Build a stable string ID from apartmentType + category + furnitureName."""
    apt   = data.get("apartmentType", "?")
    cat   = data.get("category",      "Unknown").replace(" ", "")
    fname = data.get("furnitureName", os.path.splitext(filename)[0]).replace(" ", "")
    return f"{apt}_{cat}_{fname}"


def main():
    files = sorted(glob.glob(os.path.join(JSONS_DIR, "*.json")))
    if not files:
        print(f"No JSON files found in {JSONS_DIR}")
        return

    furniture = []
    seen_ids   = {}   # id -> source filename (duplicate detection)
    n_pieces   = 0
    n_variants = 0

    for path in files:
        filename = os.path.basename(path)
        with open(path, encoding="utf-8") as f:
            data = json.load(f)

        fid = source_id(data, filename)

        # warn on duplicates (keep both, flag clearly)
        if fid in seen_ids:
            print(f"  ⚠  Duplicate ID '{fid}'  ({filename} vs {seen_ids[fid]})")
        seen_ids[fid] = filename

        entry = {
            "id":            fid,
            "apartmentType": data.get("apartmentType"),
            "category":      data.get("category"),
            "furnitureName": data.get("furnitureName"),
            "pieces":        data.get("pieces", []),
        }
        furniture.append(entry)

        for piece in entry["pieces"]:
            n_pieces   += 1
            n_variants += len(piece.get("variants", []))

    library = {
        "version":   "1.0",
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": {
            "files":    len(files),
            "pieces":   n_pieces,
            "variants": n_variants,
        },
        "furniture": furniture,
    }

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(library, f, indent=2, ensure_ascii=False)

    print(f"✓  furniture_library.json written")
    print(f"   {len(files)} source files")
    print(f"   {len(furniture)} furniture entries")
    print(f"   {n_pieces} pieces  ·  {n_variants} variants")
    print(f"   → {OUTPUT}")


if __name__ == "__main__":
    main()
