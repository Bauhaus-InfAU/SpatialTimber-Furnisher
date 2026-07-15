"""Merge batch chunk outputs into analysis-ready tables.

Inputs
  out/results_chunk*.jsonl   raw batch runner output (unique apartments only)
  out/apartments_index.csv   all apartments -> dup group representative
  ../neufert swiss dataset/apartment_simulations.csv  (total_area, number_of_rooms, floor)

Outputs
  out/results.jsonl             merged raw results (one line per unique apartment)
  out/scores.csv                one row per apartment (duplicates expanded), flat
                                columns for the dashboard / correlation analysis
  out/neufert_apartments.jsonl  app bundle: geometry + metadata per unique
                                apartment, loadable in furnisher-app's dataset
                                browser via a local file picker
"""

import csv
import glob
import json
import os
import statistics
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
SIMS = os.path.join(HERE, "..", "neufert swiss dataset", "apartment_simulations.csv")

CATEGORIES = ["Living room", "Kitchen", "Bathroom", "WC", "Bedroom", "Children"]


def cat_of(name):
    return "Children" if name.startswith("Children") else name


def main():
    # 1. Merge chunks.
    results = {}
    for path in sorted(glob.glob(os.path.join(OUT, "results_chunk*.jsonl"))):
        with open(path, encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                results[r["id"]] = r
    print(f"merged {len(results)} unique apartment results")

    with open(os.path.join(OUT, "results.jsonl"), "w", encoding="utf-8") as f:
        for rid in sorted(results):
            f.write(json.dumps(results[rid], separators=(",", ":")) + "\n")

    # 2. Simulations metadata.
    sims = {}
    with open(SIMS, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            sims[row["bfa"]] = {
                "total_area": row["total_area"],
                "number_of_rooms": row["number_of_rooms"],
                "floor": row["No_floor"],
            }
    print(f"simulations metadata: {len(sims)} apartments")

    # 3. Index: every apartment -> representative.
    index_rows = []
    with open(os.path.join(OUT, "apartments_index.csv"), newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            index_rows.append(row)

    # 4. Flat scores per apartment (duplicates inherit their representative's result).
    out_path = os.path.join(OUT, "scores.csv")
    stats = Counter()
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        header = ["bfa", "apartment_id", "is_representative", "representative_bfa",
                  "total_area", "number_of_rooms_dataset", "floor",
                  "n_furnishable_rooms", "n_failed_rooms", "n_recovered_rooms",
                  "apt_type", "apt_score_area_weighted", "apt_score_mean", "apt_score_min",
                  "furnished_room_ratio"]
        for c in CATEGORIES:
            key = c.lower().replace(" ", "_")
            header += [f"{key}_score_mean", f"{key}_zero_count", f"{key}_count"]
        w.writerow(header)

        for row in index_rows:
            bfa = row["bfa"]
            rep = row["representative_bfa"]
            r = results.get(rep)
            if r is None:
                stats["missing_result"] += 1
                continue
            if "error" in r and "rooms" not in r:
                stats["fatal_result"] += 1
                continue

            rooms = r["rooms"]
            ok = [rm for rm in rooms if not rm.get("error") and rm.get("score") is not None]
            failed = len(rooms) - len(ok)
            recovered = sum(1 for rm in rooms if rm.get("recovered"))

            if ok:
                wsum = sum(rm["area"] for rm in ok)
                apt_w = sum(rm["score"] * rm["area"] for rm in ok) / wsum if wsum else ""
                apt_mean = statistics.mean(rm["score"] for rm in ok)
                apt_min = min(rm["score"] for rm in ok)
                furnished_ratio = sum(1 for rm in ok if rm["score"] > 0) / len(rooms)
            else:
                apt_w = apt_mean = apt_min = ""
                furnished_ratio = 0.0

            cells = [bfa, row["apartment_id"], row["is_representative"], rep]
            meta = sims.get(bfa, {})
            cells += [meta.get("total_area", ""), meta.get("number_of_rooms", ""), meta.get("floor", "")]
            cells += [len(rooms), failed, recovered, r.get("aptType", "")]
            cells += [round(apt_w, 1) if apt_w != "" else "",
                      round(apt_mean, 1) if apt_mean != "" else "",
                      apt_min if apt_min != "" else "",
                      round(furnished_ratio, 3)]

            by_cat = defaultdict(list)
            for rm in ok:
                by_cat[cat_of(rm["name"])].append(rm["score"])
            n_by_cat = Counter(cat_of(rm["name"]) for rm in rooms)
            for c in CATEGORIES:
                ss = by_cat.get(c, [])
                cells += [round(statistics.mean(ss), 1) if ss else "",
                          sum(1 for s in ss if s == 0), n_by_cat.get(c, 0)]
            w.writerow(cells)
            stats["written"] += 1

    print(f"scores.csv: {stats['written']} rows "
          f"({stats['missing_result']} missing, {stats['fatal_result']} fatal) -> {out_path}")

    # 5. App bundle: one line per unique apartment, geometry + metadata.
    group_size = Counter(row["representative_bfa"] for row in index_rows)

    # Optional wall geometry (display-only), keyed by bfa.
    walls_by_id = {}
    walls_file = os.path.join(OUT, "walls.jsonl")
    if os.path.exists(walls_file):
        with open(walls_file, encoding="utf-8") as wf:
            for line in wf:
                w = json.loads(line)
                walls_by_id[w["id"]] = w.get("walls", [])
    print(f"walls loaded for {len(walls_by_id)} apartments")

    bundle_path = os.path.join(OUT, "neufert_apartments.jsonl")
    n_bundle = 0
    with open(os.path.join(OUT, "requests.jsonl"), encoding="utf-8") as fin, \
         open(bundle_path, "w", encoding="utf-8") as fout:
        fout.write(json.dumps({
            "type": "neufert-bundle", "version": 1,
            "source": "Neufert 4.0 (zenodo.org/records/14223942), unique layouts",
        }) + "\n")
        for line in fin:
            req = json.loads(line)
            bfa = req["id"]
            r = results.get(bfa)
            meta = sims.get(bfa, {})
            rooms_res = (r or {}).get("rooms", [])
            ok = [rm for rm in rooms_res if not rm.get("error") and rm.get("score") is not None]
            wsum = sum(rm["area"] for rm in ok)
            score = round(sum(rm["score"] * rm["area"] for rm in ok) / wsum, 1) if wsum else None
            try:
                nrooms = round(float(meta.get("number_of_rooms", "")))
            except ValueError:
                nrooms = None
            try:
                total_area = round(float(meta.get("total_area", "")), 1)
            except ValueError:
                total_area = None
            fout.write(json.dumps({
                "id": bfa,
                "apartment_id": req.get("apartment_id", ""),
                "rooms": req["rooms"],
                "doors": req["doors"],
                "context": req.get("context", []),
                "walls": walls_by_id.get(bfa, []),
                "meta": {
                    "score": score,
                    "aptType": (r or {}).get("aptType"),
                    "nrooms": nrooms,
                    "totalArea": total_area,
                    "nDuplicates": group_size.get(bfa, 1),
                    "nFailedRooms": len(rooms_res) - len(ok),
                },
            }, separators=(",", ":")) + "\n")
            n_bundle += 1
    print(f"app bundle: {n_bundle} apartments -> {bundle_path}")


if __name__ == "__main__":
    main()
