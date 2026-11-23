"""
FALLBACK PIECES
===============
Writes the smaller fallback pieces into ./jsons/ as ordinary library files, derived from the
exported pieces by a stretch along the piece's own axes (u along the wall line, v into the room).
build_library.py then merges them into furniture_library.json like every other piece.

A fallback piece is only used when the room cannot be furnished completely with the regular
pieces; which piece replaces which, and the reduction of points for using one, are set in
furnisher-engine/src/library/default/fallbacks.json.

Each fallback is a piecewise-linear remap through knots (metres in the piece frame): the knots
name the edges that move, everything between them is stretched with them. Example: the bathtub
1.70 -> 1.60 m maps u = [0, 1.70] to [0, 1.60].

Usage:
    python make_fallback_pieces.py      # writes jsons/<type>_<Category>_<Name>.json
    python build_library.py             # merges jsons/ into furniture_library.json
    copy furniture_library.json to furnisher-engine/src/library/default/

Source of the numbers: archive study of the SpatialTimber Building Composer (H203, 2026-11-23):
3 x 4 bathrooms, 5 x 5 children's rooms, 4-square bedrooms and 4 x 4 kitchens fail by 2.5 to 55 cm.
"""

import copy
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
JSONS_DIR = os.path.join(HERE, "jsons")


# ---- the piece frame ------------------------------------------------------------------------------

def frame(v):
    """Origin = first point of the placement line, x along its first segment, y into the room
    (towards the centre of bboxBig)."""
    lp = v["linePlacement"]["points"]
    o = lp[0]
    x = (lp[1][0] - o[0], lp[1][1] - o[1])
    n = math.hypot(*x)
    x = (x[0] / n, x[1] / n)
    bb = v["bboxBig"]["points"]
    c = (sum(p[0] for p in bb) / len(bb) - o[0], sum(p[1] for p in bb) / len(bb) - o[1])
    y = (-x[1], x[0])
    if y[0] * c[0] + y[1] * c[1] < 0:
        y = (-y[0], -y[1])
    return o, x, y


def to_uv(p, f):
    o, x, y = f
    d = (p[0] - o[0], p[1] - o[1])
    return (d[0] * x[0] + d[1] * x[1], d[0] * y[0] + d[1] * y[1])


def from_uv(q, f):
    o, x, y = f
    return [round(o[0] + q[0] * x[0] + q[1] * y[0], 6), round(o[1] + q[0] * x[1] + q[1] * y[1], 6)]


def pw(knots_old, knots_new):
    """Piecewise-linear map through the knots (linear beyond the ends)."""
    ko, kn = list(knots_old), list(knots_new)

    def f(t):
        for i in range(len(ko) - 1):
            if t <= ko[i + 1] + 1e-9 or i == len(ko) - 2:
                a, b, A, B = ko[i], ko[i + 1], kn[i], kn[i + 1]
                return A + (t - a) * (B - A) / (b - a) if b != a else A
        return t
    return f


def ident(t):
    return t


def remap(v, fu, fv):
    f = frame(v)
    v = copy.deepcopy(v)

    def m(p):
        u, w = to_uv(p, f)
        return from_uv((fu(u), fv(w)), f)

    v["linePlacement"]["points"] = [m(p) for p in v["linePlacement"]["points"]]
    for k in ("bboxSmall", "bboxBig"):
        v[k]["points"] = [m(p) for p in v[k]["points"]]
        if "origin" in v[k]:
            v[k]["origin"] = m(v[k]["origin"])
        xs = [p[0] for p in v[k]["points"]]
        ys = [p[1] for p in v[k]["points"]]
        if v[k].get("rotation", 0) % 180 == 0:
            v[k]["width"] = round(max(xs) - min(xs), 6)
            v[k]["height"] = round(max(ys) - min(ys), 6)
    for g in v["geometry"]:
        g["points"] = [m(p) for p in g["points"]]
    return v


def u(old, new):
    return lambda v: remap(v, pw(old, new), ident)


def w(old, new):
    return lambda v: remap(v, ident, pw(old, new))


# ---- the fallback pieces --------------------------------------------------------------------------
# (apartment types, category, source name, new name, {variant index or "all": edit}, description)

FALLBACKS = [
    ([3, 4], "Bathroom", "Bathtube", "Bathtube160",
     {"all": u([0, 1.7], [0, 1.6])},
     "bathtub 1.60 m long instead of 1.70 m"),
    ([1, 2, 3, 4], "Bathroom", "Sinc", "Sinc112",
     {"all": w([0, 0.44, 1.15], [0, 0.44, 1.12])},
     "washbasin with a free area 1.12 m deep instead of 1.15 m (0.68 m in front of the basin)"),
    ([3, 4], "Children", "Bed", "Bed295",
     {"all": u([0, 0.85, 2.95, 3.0], [0, 0.8, 2.9, 2.95])},
     "children's bed with a free strip of 0.80 m at its end instead of 0.85 m"),
    ([1], "Kitchen", "Kitchen", "Kitchen220",
     {"all": w([-0.05, 0, 2.4, 2.45], [-0.05, 0, 2.2, 2.25])},
     "kitchen counter 2.20 m instead of 2.40 m"),
    ([2, 3], "Kitchen", "Kitchen", "Kitchen230",
     {0: u([0, 2.4], [0, 2.3]), 1: w([0, 2.4], [0, 2.3])},
     "L kitchen with a long leg of 2.30 m instead of 2.40 m"),
    ([2, 3, 4], "Bedroom", "Bed", "Bed160",
     {0: u([0, 0.85, 2.85, 3.7], [0, 0.6, 2.2, 2.8]), 1: u([0, 0.8, 2.8, 2.9], [0, 0.6, 2.2, 2.3])},
     "double bed 1.60 m wide with 0.60 m beside it instead of 2.00 m with 0.80 m"),
]


def main():
    written = []
    for types, cat, src, new, edits, desc in FALLBACKS:
        for t in types:
            path = os.path.join(JSONS_DIR, f"{t}_{cat}_{src}.json")
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            assert data["furnitureName"] == src and data["category"] == cat and data["apartmentType"] == t, path
            out = copy.deepcopy(data)
            out["furnitureName"] = new
            out["fallbackOf"] = src
            out["description"] = desc
            for piece in out["pieces"]:
                piece["furnitureName"] = new
                vs = piece["variants"]
                for i in range(len(vs)):
                    ed = edits.get("all") or edits.get(i)
                    if ed is not None:
                        vs[i] = ed(vs[i])
            dst = os.path.join(JSONS_DIR, f"{t}_{cat}_{new}.json")
            with open(dst, "w", encoding="utf-8") as f:
                json.dump(out, f, indent=2, ensure_ascii=False)
                f.write("\n")
            written.append(os.path.basename(dst))
    print(f"{len(written)} fallback pieces written to {JSONS_DIR}:")
    for n in written:
        print("  " + n)


if __name__ == "__main__":
    main()
