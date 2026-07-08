"""Convert the Neufert 4.0 dataset (geometries_w_outlines.csv) into
furnisher-engine batch requests.

Reads the raw per-entity WKT CSV, groups entities per apartment, maps dataset
room subtypes onto the engine's RoomName vocabulary, assigns doors/windows,
detects geometric duplicates, and writes:

  out/requests.jsonl        one engine request per UNIQUE apartment (dedup representatives)
  out/apartments_index.csv  one row per apartment (all 20k), with dup-group mapping
  out/convert_report.txt    summary statistics

Engine room mapping
  KITCHEN, KITCHEN_DINING          -> Kitchen
  LIVING_ROOM, LIVING_DINING,
  DINING, STUDIO                   -> Living room
  BATHROOM (has bathtub/shower)    -> Bathroom
  BATHROOM (no bathtub/shower)     -> WC
  BEDROOM + generic ROOM           -> sleeping pool: largest -> Bedroom,
                                      rest -> Children 1..4, overflow -> Bedroom
  If the apartment has no living area, the largest generic ROOM is promoted
  to Living room before the sleeping assignment.
  CORRIDOR and all outdoor/service areas are skipped (not furnishable).

Usage:
  python convert.py [--limit N] [--geoms PATH] [--out DIR]
"""

import argparse
import csv
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_GEOMS = os.path.join(HERE, "..", "neufert swiss dataset", "geometries_w_outlines.csv")
DEFAULT_OUT = os.path.join(HERE, "out")

KITCHEN_SUBTYPES = {"KITCHEN", "KITCHEN_DINING"}
LIVING_SUBTYPES = {"LIVING_ROOM", "LIVING_DINING", "DINING", "STUDIO"}
SLEEPING_SUBTYPES = {"BEDROOM", "ROOM"}
BATH_SUBTYPES = {"BATHROOM"}
FURNISHABLE = KITCHEN_SUBTYPES | LIVING_SUBTYPES | SLEEPING_SUBTYPES | BATH_SUBTYPES
BATH_FEATURES = {"BATHTUB", "SHOWER"}
DOOR_SUBTYPES = {"DOOR", "ENTRANCE_DOOR"}
# Not furnishable, but carried through as display-only context so apartments
# don't render as floating rooms in the app.
CONTEXT_SUBTYPES = {"CORRIDOR"}

DOOR_ASSIGN_DIST = 0.4   # must match engine-cli ADJACENT_DOOR_THRESHOLD
WINDOW_ASSIGN_DIST = 0.5 # exterior walls are thicker

# ---------------------------------------------------------------- geometry --

def parse_wkt_polygon(wkt):
    """Return (outer_ring, has_hole). Outer ring without closing duplicate."""
    rings = re.findall(r"\(([^()]+)\)", wkt)
    if not rings:
        return None, False
    pts = []
    for pair in rings[0].strip().split(","):
        xy = pair.split()
        pts.append((float(xy[0]), float(xy[1])))
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts, len(rings) > 1


def dedupe_vertices(pts, tol=0.005):
    out = []
    for p in pts:
        if not out or math.dist(p, out[-1]) >= tol:
            out.append(p)
    while len(out) > 3 and math.dist(out[0], out[-1]) < tol:
        out.pop()
    return out


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


def signed_area(pts):
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def clean_polygon(pts):
    """Dedupe, remove collinear, force CCW. Returns None if degenerate."""
    pts = remove_collinear(dedupe_vertices(pts))
    if len(pts) < 3 or abs(signed_area(pts)) < 0.05:
        return None
    if signed_area(pts) < 0:
        pts = pts[::-1]
    return pts


def centroid(pts):
    x = sum(p[0] for p in pts) / len(pts)
    y = sum(p[1] for p in pts) / len(pts)
    return (x, y)


def point_in_polygon(p, poly):
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xin:
                inside = not inside
    return inside


def dist_point_to_polygon(p, poly):
    px, py = p
    best = float("inf")
    n = len(poly)
    for i in range(n):
        ax, ay = poly[i]
        bx, by = poly[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy
        t = 0.0 if len2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
        d = math.hypot(px - ax - t * dx, py - ay - t * dy)
        if d < best:
            best = d
    return best


def edge_lengths(pts):
    return sorted(
        round(math.dist(pts[i], pts[(i + 1) % len(pts)]), 2) for i in range(len(pts))
    )


def dominant_angle_deg(polygons):
    """Dominant wall direction mod 90deg, weighted by edge length (0.5deg bins).

    Apartments in the dataset are stored in arbitrary rotation. Canonicalizing
    to the dominant axis makes scores comparable across apartments and avoids
    many polygon-clipping robustness failures on rotated coordinates."""
    bins = defaultdict(float)
    for poly in polygons:
        n = len(poly)
        for i in range(n):
            ax, ay = poly[i]
            bx, by = poly[(i + 1) % n]
            length = math.hypot(bx - ax, by - ay)
            ang = math.degrees(math.atan2(by - ay, bx - ax)) % 90.0
            bins[round(ang * 2) / 2 % 90.0] += length
    if not bins:
        return 0.0
    return max(bins.items(), key=lambda kv: kv[1])[0]


def make_rotator(angle_deg):
    a = math.radians(angle_deg)
    c, s = math.cos(-a), math.sin(-a)

    def rot(p):
        return (p[0] * c - p[1] * s, p[0] * s + p[1] * c)

    return rot

# ------------------------------------------------------------ room mapping --

def classify_rooms(areas, bath_feature_centroids):
    """areas: list of dicts {subtype, polygon, area}. Returns list of
    (engine_name, area_dict) and a list of mapping notes."""
    notes = []
    living, kitchens, baths, sleeping = [], [], [], []
    for a in areas:
        st = a["subtype"]
        if st in KITCHEN_SUBTYPES:
            kitchens.append(a)
        elif st in LIVING_SUBTYPES:
            living.append(a)
        elif st in BATH_SUBTYPES:
            baths.append(a)
        elif st in SLEEPING_SUBTYPES:
            sleeping.append(a)

    # Promote largest generic ROOM to Living room when none exists.
    if not living and sleeping:
        generic = [a for a in sleeping if a["subtype"] == "ROOM"]
        pool = generic if generic else sleeping
        promoted = max(pool, key=lambda a: a["area"])
        sleeping.remove(promoted)
        living.append(promoted)
        notes.append("promoted_room_to_living")

    named = []
    for a in living:
        named.append(("Living room", a))
    for a in kitchens:
        named.append(("Kitchen", a))
    for a in baths:
        has_tub = any(point_in_polygon(c, a["polygon"]) for c in bath_feature_centroids)
        named.append(("Bathroom" if has_tub else "WC", a))

    sleeping.sort(key=lambda a: -a["area"])
    for i, a in enumerate(sleeping):
        if i == 0:
            named.append(("Bedroom", a))
        elif i <= 4:
            named.append((f"Children {i}", a))
        else:
            named.append(("Bedroom", a))
            notes.append("children_overflow_as_bedroom")
    return named, notes

# ----------------------------------------------------------------- convert --

def process_apartment(bfa, ent, stats):
    """ent: {'areas': [...], 'bath_features': [...], 'doors': [...],
    'windows': [...], 'meta': {...}, 'skipped': Counter}"""
    areas = []
    for subtype, wkt in ent["areas"]:
        pts, has_hole = parse_wkt_polygon(wkt)
        if has_hole:
            stats["rooms_with_holes"] += 1
        poly = clean_polygon(pts) if pts else None
        if poly is None:
            stats["rooms_degenerate"] += 1
            continue
        areas.append({"subtype": subtype, "polygon": poly, "area": abs(signed_area(poly))})

    if not areas:
        stats["apartments_no_rooms"] += 1
        return None

    named, notes = classify_rooms(areas, ent["bath_features"])

    # Canonical frame: rotate the whole apartment so the dominant wall
    # direction is axis-aligned, then snap to millimetres. Done before any
    # coordinate output so all apartments are scored in a comparable frame.
    rotation = dominant_angle_deg([a["polygon"] for _, a in named])
    rot = make_rotator(rotation)

    rooms = []
    for name, a in named:
        poly = a["polygon"]
        windows = [w for w in ent["windows"]
                   if dist_point_to_polygon(w, poly) <= WINDOW_ASSIGN_DIST]
        rooms.append({
            "name": name,
            "polygon": [[round(x, 3), round(y, 3)] for x, y in map(rot, poly)],
            "windows": [[round(x, 3), round(y, 3)] for x, y in map(rot, windows)],
            "subtype": a["subtype"],
            "area": round(a["area"], 3),
        })

    # Doors: keep any door centroid that is close to at least one kept room.
    doors = [
        [round(x, 3), round(y, 3)]
        for x, y in (rot(d) for d in ent["doors"]
                     if any(dist_point_to_polygon(d, a["polygon"]) <= DOOR_ASSIGN_DIST
                            for a in areas))
    ]

    rooms_with_door = sum(
        1 for _, a in named
        if any(dist_point_to_polygon(d, a["polygon"]) <= DOOR_ASSIGN_DIST for d in ent["doors"])
    )

    # Display-only context areas (corridors): same frame, never sent to the engine.
    context = []
    for subtype, wkt in ent["context"]:
        pts, _ = parse_wkt_polygon(wkt)
        poly = clean_polygon(pts) if pts else None
        if poly is None:
            continue
        context.append({
            "subtype": subtype,
            "polygon": [[round(x, 3), round(y, 3)] for x, y in map(rot, poly)],
        })

    # Rotation/translation-invariant duplicate signature.
    sig_src = json.dumps(
        sorted((r["name"], edge_lengths(
            [(p[0], p[1]) for p in r["polygon"]]),
            sum(1 for d in ent["doors"]
                if dist_point_to_polygon(d, [(p[0], p[1]) for p in r["polygon"]]) <= DOOR_ASSIGN_DIST))
              for r in rooms),
        separators=(",", ":"))
    sig = hashlib.sha1(sig_src.encode()).hexdigest()[:16]

    return {
        "id": bfa,
        "apartment_id": ent["meta"].get("apartment_id", ""),
        "rooms": rooms,
        "doors": doors,
        "context": context,
        "rotation": rotation,
        "signature": sig,
        "notes": notes,
        "rooms_with_door": rooms_with_door,
        "meta": ent["meta"],
        "skipped": dict(ent["skipped"]),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--geoms", default=DEFAULT_GEOMS)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--limit", type=int, default=0, help="stop after N apartments (pilot)")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    csv.field_size_limit(10_000_000)

    apartments = defaultdict(lambda: {
        "areas": [], "context": [], "bath_features": [], "doors": [], "windows": [],
        "meta": {}, "skipped": Counter(),
    })
    stats = Counter()

    print("[1/3] reading geometries CSV ...", flush=True)
    with open(args.geoms, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            bfa = row["bfa"]
            et, st = row["entity_type"], row["entity_subtype"]
            if st == "APARTMENT":
                continue  # outline; total area comes from simulations CSV
            ent = apartments[bfa]
            if not ent["meta"]:
                ent["meta"] = {
                    "apartment_id": row["apartment_id"],
                    "site_id": row["site_id"],
                    "building_id": row["building_id"],
                    "floor_id": row["floor_id"],
                }
            if et == "area":
                if st in FURNISHABLE:
                    ent["areas"].append((st, row["geometry"]))
                else:
                    if st in CONTEXT_SUBTYPES:
                        ent["context"].append((st, row["geometry"]))
                    ent["skipped"][st] += 1
            elif et == "feature" and st in BATH_FEATURES:
                pts, _ = parse_wkt_polygon(row["geometry"])
                if pts:
                    ent["bath_features"].append(centroid(pts))
            elif et == "opening" and st in DOOR_SUBTYPES:
                pts, _ = parse_wkt_polygon(row["geometry"])
                if pts:
                    ent["doors"].append(centroid(pts))
            elif et == "opening" and st == "WINDOW":
                pts, _ = parse_wkt_polygon(row["geometry"])
                if pts:
                    ent["windows"].append(centroid(pts))

    print(f"    {len(apartments)} apartments with entities", flush=True)

    print("[2/3] converting apartments ...", flush=True)
    converted = []
    for i, (bfa, ent) in enumerate(sorted(apartments.items())):
        if args.limit and len(converted) >= args.limit:
            break
        rec = process_apartment(bfa, ent, stats)
        if rec:
            converted.append(rec)
        if (i + 1) % 2000 == 0:
            print(f"    {i + 1} processed", flush=True)

    # Duplicate grouping: first apartment per signature is the representative.
    print("[3/3] dedup + writing outputs ...", flush=True)
    groups = defaultdict(list)
    for rec in converted:
        groups[rec["signature"]].append(rec["id"])
    representative = {sig: ids[0] for sig, ids in groups.items()}

    req_path = os.path.join(args.out, "requests.jsonl")
    with open(req_path, "w", encoding="utf-8") as f:
        for rec in converted:
            if representative[rec["signature"]] != rec["id"]:
                continue
            f.write(json.dumps({
                "id": rec["id"],
                "apartment_id": rec["apartment_id"],
                "rooms": rec["rooms"],
                "doors": rec["doors"],
                "context": rec["context"],
            }, separators=(",", ":")) + "\n")

    idx_path = os.path.join(args.out, "apartments_index.csv")
    name_keys = ["Living room", "Kitchen", "Bathroom", "WC", "Bedroom", "Children"]
    with open(idx_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["bfa", "apartment_id", "site_id", "building_id", "floor_id",
                    "n_rooms", "n_doors", "rooms_with_door",
                    *[f"n_{k.lower().replace(' ', '_')}" for k in name_keys],
                    "skipped_corridor", "skipped_other", "rotation_deg",
                    "signature", "representative_bfa", "is_representative", "notes"])
        for rec in converted:
            counts = Counter(
                "Children" if r["name"].startswith("Children") else r["name"]
                for r in rec["rooms"])
            skipped = rec["skipped"]
            rep = representative[rec["signature"]]
            w.writerow([
                rec["id"], rec["apartment_id"],
                rec["meta"]["site_id"], rec["meta"]["building_id"], rec["meta"]["floor_id"],
                len(rec["rooms"]), len(rec["doors"]), rec["rooms_with_door"],
                *[counts.get(k, 0) for k in name_keys],
                skipped.get("CORRIDOR", 0),
                sum(v for k, v in skipped.items() if k != "CORRIDOR"),
                rec["rotation"],
                rec["signature"], rep, int(rep == rec["id"]),
                ";".join(rec["notes"]),
            ])

    n_unique = len(groups)
    dup_sizes = sorted((len(v) for v in groups.values()), reverse=True)
    report = [
        f"apartments with entities: {len(apartments)}",
        f"apartments converted:     {len(converted)}",
        f"apartments skipped (no furnishable rooms): {stats['apartments_no_rooms']}",
        f"rooms degenerate/dropped: {stats['rooms_degenerate']}",
        f"rooms with WKT holes (outer ring used): {stats['rooms_with_holes']}",
        f"unique layouts (dedup groups): {n_unique} "
        f"({len(converted) - n_unique} duplicates, {100 * (len(converted) - n_unique) / max(1, len(converted)):.1f}%)",
        f"largest dup groups: {dup_sizes[:10]}",
        f"requests written: {sum(1 for v in groups.values() if v)} -> {req_path}",
    ]
    text = "\n".join(report)
    with open(os.path.join(args.out, "convert_report.txt"), "w", encoding="utf-8") as f:
        f.write(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
