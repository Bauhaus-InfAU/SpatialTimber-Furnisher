"""Analysis pass over batch results: tests candidate findings and emits
aggregates for the dashboard (out/analysis.json) plus a console summary.

Room-level analysis joins results.jsonl (scores) with requests.jsonl
(geometry -> shape class). Apartment-level analysis uses scores.csv
(duplicates expanded, dataset metadata joined).
"""

import csv
import json
import math
import os
import statistics
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# ---------------------------------------------------------------- shapes ----

def signed_area(pts):
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def remove_collinear(pts, cross_tol=0.002):
    changed = True
    while changed and len(pts) > 3:
        changed = False
        nxt = []
        n = len(pts)
        for i in range(n):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
            cross = abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]))
            if cross > cross_tol:
                nxt.append(b)
            else:
                changed = True
        if len(nxt) >= 3:
            pts = nxt
        else:
            break
    return pts


def angles_ok(pts, tol_deg=4):
    n = len(pts)
    for i in range(n):
        a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
        v1 = (a[0] - b[0], a[1] - b[1])
        v2 = (c[0] - b[0], c[1] - b[1])
        d1 = math.hypot(*v1)
        d2 = math.hypot(*v2)
        if d1 < 1e-9 or d2 < 1e-9:
            return False
        cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (d1 * d2)
        ang = math.degrees(math.acos(max(-1, min(1, cos))))
        if abs(ang - 90) > tol_deg:
            return False
    return True


def shape_class(polygon):
    pts = remove_collinear([tuple(p) for p in polygon])
    n = len(pts)
    if n < 3:
        return "degenerate"
    ortho = angles_ok(pts)
    if n == 4 and ortho:
        return "rectangle"
    if n == 6 and ortho:
        return "L-shape"
    if ortho:
        return "ortho-complex"
    return "non-ortho"


def cat_of(name):
    return "Children" if name.startswith("Children") else name

# ------------------------------------------------------------------ load ----

print("loading requests + results ...")
geo = {}  # id -> list of (name, subtype, area, shape, nverts, nwindows)
with open(os.path.join(OUT, "requests.jsonl"), encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        geo[r["id"]] = [
            (rm["name"], rm["subtype"], rm["area"], shape_class(rm["polygon"]),
             len(rm["polygon"]), len(rm["windows"]))
            for rm in r["rooms"]
        ]

rooms = []  # flat room records
apt_results = {}
with open(os.path.join(OUT, "results.jsonl"), encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        apt_results[r["id"]] = r
        g = geo.get(r["id"], [])
        for i, rm in enumerate(r.get("rooms", [])):
            shape = g[i][3] if i < len(g) else "?"
            nwin = g[i][5] if i < len(g) else 0
            rooms.append({
                "cat": cat_of(rm["name"]),
                "area": rm.get("area") or 0,
                "score": rm.get("score"),
                "error": bool(rm.get("error")),
                "shape": shape,
                "windows": nwin,
                "steps": rm.get("steps", []),
            })

apts = []
with open(os.path.join(OUT, "scores.csv"), newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        if row["apt_score_area_weighted"] == "":
            continue
        try:
            nrooms = round(float(row["number_of_rooms_dataset"]))
        except ValueError:
            nrooms = None
        try:
            area = float(row["total_area"])
        except ValueError:
            area = None
        apts.append({
            "id": row["bfa"],
            "rep": row["representative_bfa"],
            "is_rep": row["is_representative"] == "1",
            "score": float(row["apt_score_area_weighted"]),
            "nrooms": nrooms,
            "area": area,
        })

print(f"rooms: {len(rooms)}, apartments: {len(apts)}")

# ------------------------------------------------------------- helpers ------

def summary(vals):
    vals = sorted(vals)
    if not vals:
        return None
    q = statistics.quantiles(vals, n=4) if len(vals) >= 4 else [vals[0], vals[len(vals)//2], vals[-1]]
    return {
        "n": len(vals),
        "mean": round(statistics.mean(vals), 1),
        "median": round(statistics.median(vals), 1),
        "q1": round(q[0], 1),
        "q3": round(q[2], 1),
    }

# ------------------------------------------------- A. apartment level -------

print("\n=== A. apartment score by dataset room count ===")
by_nrooms = defaultdict(list)
for a in apts:
    if a["nrooms"]:
        by_nrooms[min(a["nrooms"], 5)].append(a["score"])
A = {}
for nr in sorted(by_nrooms):
    A[nr] = summary(by_nrooms[nr])
    print(f"  {nr}r: {A[nr]}")

print("\n=== A2. score vs total area (20 m2 bins) ===")
by_area = defaultdict(list)
for a in apts:
    if a["area"]:
        by_area[int(a["area"] // 20) * 20].append(a["score"])
A2 = {}
for b in sorted(by_area):
    if len(by_area[b]) >= 50:
        A2[b] = summary(by_area[b])
        print(f"  {b}-{b+19} m2: {A2[b]}")

# ------------------------------------------------- B. room categories -------

print("\n=== B. per-category room outcomes ===")
B = {}
for cat in ["Living room", "Kitchen", "Bathroom", "WC", "Bedroom", "Children"]:
    rs = [r for r in rooms if r["cat"] == cat]
    ok = [r["score"] for r in rs if not r["error"] and r["score"] is not None]
    zero = sum(1 for s in ok if s == 0)
    B[cat] = {
        "n": len(rs),
        "err_pct": round(100 * sum(r["error"] for r in rs) / len(rs), 1),
        "zero_pct": round(100 * zero / len(ok), 1),
        "perfect_pct": round(100 * sum(1 for s in ok if s >= 99.9) / len(ok), 1),
        **{k: v for k, v in (summary(ok) or {}).items() if k != "n"},
    }
    print(f"  {cat:12s} {B[cat]}")

# ------------------------------------------------- C. shape class -----------

print("\n=== C. room score by shape class (per category) ===")
C = {}
for cat in ["Living room", "Kitchen", "Bathroom", "WC", "Bedroom", "Children"]:
    C[cat] = {}
    for sh in ["rectangle", "L-shape", "ortho-complex", "non-ortho"]:
        ok = [r["score"] for r in rooms
              if r["cat"] == cat and r["shape"] == sh and not r["error"] and r["score"] is not None]
        if len(ok) >= 30:
            C[cat][sh] = {**summary(ok), "zero_pct": round(100 * sum(1 for s in ok if s == 0) / len(ok), 1)}
    line = "  ".join(f"{sh}: m={v['mean']} z={v['zero_pct']}% n={v['n']}" for sh, v in C[cat].items())
    print(f"  {cat:12s} {line}")

# ------------------------------------------------- D. area thresholds -------

print("\n=== D. room score by room area (1 m2 bins), per category ===")
D = {}
for cat in ["Kitchen", "Bathroom", "WC", "Bedroom", "Children", "Living room"]:
    bins = defaultdict(list)
    for r in rooms:
        if r["cat"] == cat and not r["error"] and r["score"] is not None and r["area"] > 0:
            bins[min(int(r["area"]), 30)].append(r["score"])
    D[cat] = {b: {"n": len(v), "mean": round(statistics.mean(v), 1),
                  "zero_pct": round(100 * sum(1 for s in v if s == 0) / len(v), 1)}
              for b, v in sorted(bins.items()) if len(v) >= 30}
    pts = "  ".join(f"{b}m2:{v['mean']}({v['zero_pct']}%z)" for b, v in list(D[cat].items())[:14])
    print(f"  {cat:12s} {pts}")

# ------------------------------------------------- E. kitchen deep dive -----

print("\n=== E. kitchen: which step fails ===")
kitchen_fail_step = Counter()
for r in rooms:
    if r["cat"] == "Kitchen" and not r["error"] and r["score"] == 0:
        for st in r["steps"]:
            if st.get("optionCount", 0) == 0:
                kitchen_fail_step[st.get("furnitureName", "?")] += 1
print("  zero-score kitchens, failing step:", dict(kitchen_fail_step))

wc_fail_step = Counter()
for r in rooms:
    if r["cat"] == "WC" and not r["error"] and r["score"] == 0:
        for st in r["steps"]:
            if st.get("optionCount", 0) == 0:
                wc_fail_step[st.get("furnitureName", "?")] += 1
print("  zero-score WCs, failing steps:", dict(wc_fail_step))

# ------------------------------------------------- D2. shape controlled -----

print("\n=== D2. shape effect at fixed size (mean score) ===")
D2 = {}
shape_order = ["rectangle", "L-shape", "ortho-complex", "non-ortho"]
for cat, lo, hi in [("Kitchen", 5, 10), ("Kitchen", 10, 15),
                    ("Bedroom", 10, 15), ("Bedroom", 15, 20),
                    ("Living room", 15, 20), ("Living room", 20, 25)]:
    key = f"{cat}|{lo}-{hi}"
    D2[key] = {}
    for sh in shape_order:
        v = [r["score"] for r in rooms
             if r["cat"] == cat and r["shape"] == sh and not r["error"]
             and r["score"] is not None and lo <= r["area"] < hi]
        if len(v) >= 30:
            D2[key][sh] = {"n": len(v), "mean": round(statistics.mean(v), 1)}
    print(f"  {key}: " + "  ".join(f"{sh}: {v['mean']} (n={v['n']})" for sh, v in D2[key].items()))

# ------------------------------------------------- H. histogram + exemplars -

hist = Counter()
for a in apts:
    hist[min(int(a["score"] // 5) * 5, 100)] += 1
H = {str(k): hist[k] for k in sorted(hist)}

reps = [a for a in apts if a["is_rep"]]
worst = sorted(reps, key=lambda a: a["score"])[:6]
best_large = sorted((a for a in reps if (a["area"] or 0) >= 100 and a["score"] >= 99),
                    key=lambda a: -(a["area"] or 0))[:6]
EX = {
    "worst": [{"id": a["id"], "score": a["score"], "area": a["area"], "nrooms": a["nrooms"]} for a in worst],
    "best_large": [{"id": a["id"], "score": a["score"], "area": a["area"], "nrooms": a["nrooms"]} for a in best_large],
}
print("\nexemplar worst:", [a["id"][:18] for a in worst])

# ------------------------------------------------- F. window count ----------

print("\n=== F. bedroom/children score by window count (wardrobe rule) ===")
F = {}
for cat in ["Bedroom", "Children"]:
    F[cat] = {}
    for w in [0, 1, 2, 3]:
        ok = [r["score"] for r in rooms
              if r["cat"] == cat and r["windows"] == w and not r["error"] and r["score"] is not None]
        if len(ok) >= 30:
            F[cat][w] = summary(ok)
    print(f"  {cat}: " + "  ".join(f"{w}win: m={v['mean']} n={v['n']}" for w, v in F[cat].items()))

# ------------------------------------------------- persist ------------------

with open(os.path.join(OUT, "analysis.json"), "w", encoding="utf-8") as f:
    json.dump({"by_nrooms": A, "by_area": A2, "categories": B,
               "shape": C, "area_bins": D, "shape_controlled": D2,
               "histogram": H, "exemplars": EX,
               "kitchen_fail_step": dict(kitchen_fail_step),
               "wc_fail_step": dict(wc_fail_step),
               "windows": F,
               "totals": {"apartments": len(apts), "unique": len(apt_results),
                          "rooms": len(rooms)}}, f, indent=1)
print("\nwrote out/analysis.json")
