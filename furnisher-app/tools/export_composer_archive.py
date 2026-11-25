"""Export Building Composer archive layouts for the Furnisher app's "Composer archive" browser.

Run with the composer's own Python (its venv has the `stc` package):

    C:\\Work\\SpatialTimber-Building_Composer\\.venv\\Scripts\\python.exe furnisher-app/tools/export_composer_archive.py

Every Furnisher request is built by the composer's OWN code, never re-implemented here:

- the request is the one the studio sends today for a plan: `stc.floorplan.tools.run_measure` measures a plan under
  `RULESET` (base-2026-10-21, which reads the plan model M2) through `tools.measure_model`, whose Furnisher request is
  furn2's (`furn2.furnisher_input` + `furn2.request_of`: each room's own cell outline, the wm1 windows, a door point for
  every door of the access graph plus one point per opening (open kitchen side), `subtype` "Open kitchen" for a kitchen
  plan2 counts as open). This exporter calls `tools.measure_model` on the archive plan (placed layout of the measured
  drawing) and captures the request at `furnish.furnish_one_with_geometry` (in memory, nothing runs: no node call).
- cross-checks, per layout: the archive measure path of furn2 (`furn2.prepare` on the placement, exactly as the
  composer's tests/integration/test_plan2_parity.py builds its items) and the old `furn.request_of` request, whose
  sha256 must equal the `request_sha256` stored in the archive's `furn@...` line (proves the placement is read as the
  composer read it). The stored `furn` result (the old engine) is attached for comparison: apartment score and
  per-room scores.
- the geometry to draw is the studio's own `stc.serve.studio_next.designs.drawing_m2` (rooms with rings, doors as
  opening segments, the room lines of open kitchens after the plan2 lift, free walls), placed with an identity frame so
  world metres = plan metres (x right, y up, cell (i, j) spans [i*0.625, (i+1)*0.625]); the facade sides come from the
  archive shape.

Output (default furnisher-app/public/archive/composer/): `index.json` (one light row per layout, for the browser's
filters) and `chunk-NNN.json` files of full layouts (loaded on demand).

Options:
  --open-only              only layouts whose drawing has an Open kitchen
  --others N               how many layouts WITHOUT an open kitchen to add (seeded random sample; default 300)
  --limit N                at most N layouts with an open kitchen (default: all distinct drawings)
  --verify N               also run the studio's own `tools.measure_model` (needs node; E10_FURNISHER_REPO is set to
                           this Furnisher clone) on N sample layouts and compare its request sha256 with the exported
                           one; its score (the current engine through the CLI, as the composer computes it) is written
                           to verify_measure_model.json beside the dataset
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import random
import sys
import time
from pathlib import Path

COMPOSER = Path(os.environ.get("STC_COMPOSER", r"C:\Work\SpatialTimber-Building_Composer"))
FURNISHER = Path(__file__).resolve().parents[2]
os.environ.setdefault("STC_HOME", str(COMPOSER))
# E10's config reads the Furnisher clone from this variable (only `--verify` runs the CLI)
os.environ.setdefault("E10_FURNISHER_REPO", str(FURNISHER))

from stc.archive import doors as D                                  # noqa: E402
from stc.evals.measures import furn as FN                           # noqa: E402
from stc.evals.measures import furn2 as F2                          # noqa: E402
from stc.evals.measures import geom as GM                           # noqa: E402
from stc.evals.measures import plan2 as P2                          # noqa: E402
from stc.serve.studio_next import designs as SND                    # noqa: E402
from stc.floorplan import tools as TL                               # noqa: E402

G = 0.625
ARCHIVE = COMPOSER / "archive"
CHUNK = 150
FORMAT = "furnisher-composer-archive@1"
IDENTITY_BRIEF = {"grid_m": G, "extra": {"canonical_frame": {"value": {"sx": 1, "sy": 1, "ox": 0, "oy": 0}}}}


def lines_of(folder: Path) -> dict:
    out = {}
    for p in sorted(folder.glob("*.jsonl")):
        for ln in p.read_bytes().splitlines():
            if ln.strip():
                r = json.loads(ln)
                out[r["pl_id"]] = r
    return out


def r4(v: float) -> float:
    return round(float(v), 4)


def facade_runs(shape: dict) -> list:
    """The facade sides of the shape (its own frame = the placement frame), joined into straight runs [[a, b], ...] in
    metres."""
    segs = collections.defaultdict(list)          # (axis, line) -> [(lo, hi)] in cells
    for s in shape["sides"]:
        if s["flag"] != "facade":
            continue
        x, y = s["cell"]
        side = s["side"]
        if side == "N":
            segs[("h", y + 1)].append((x, x + 1))
        elif side == "S":
            segs[("h", y)].append((x, x + 1))
        elif side == "E":
            segs[("v", x + 1)].append((y, y + 1))
        elif side == "W":
            segs[("v", x)].append((y, y + 1))
    out = []
    for (axis, line), spans in sorted(segs.items()):
        spans.sort()
        lo, hi = spans[0]
        runs = []
        for a, b in spans[1:]:
            if a <= hi:
                hi = max(hi, b)
            else:
                runs.append((lo, hi))
                lo, hi = a, b
        runs.append((lo, hi))
        for lo, hi in runs:
            if axis == "h":
                out.append([[r4(lo * G), r4(line * G)], [r4(hi * G), r4(line * G)]])
            else:
                out.append([[r4(line * G), r4(lo * G)], [r4(line * G), r4(hi * G)]])
    return out


def drawing_of(doc: dict, sym: str, shape: dict) -> dict:
    lay = D.placed_layout(doc, sym)
    plan = {"grid": lay["grid"], "legend": lay["legend"], "doors": lay["doors"]}
    d = SND.drawing_m2(IDENTITY_BRIEF, plan)
    if not d.get("placed"):
        raise RuntimeError(f"drawing_m2 did not place the plan: {d.get('why')}")
    # the shape's cells are the placed grid's cells (same frame), checked
    H = len(lay["grid"])
    cells = {(x, H - 1 - k) for k, row in enumerate(lay["grid"]) for x, ch in enumerate(row) if ch not in "#."}
    if cells != {tuple(c) for c in shape["cells"]}:
        raise RuntimeError("the placed layout's cells are not the shape's cells")
    doors = [{"room": x["room"], "from": x["from"], "entrance": x["entrance"], "a": x["a"], "b": x["b"]} for x in d["doors"]]
    if not any(x["entrance"] for x in doors):
        # a drawing without an entrance entry (e.g. a moved-door version measured on its drawn hash): the measures take
        # the shape's app door sides (geom G14), so they are drawn as the entrance, one piece per side (`doorsToDraw`
        # joins them), entering the room of the cell inside each side
        for x, y, side in shape["app_door"]["sides"]:
            if side in ("N", "S"):
                yy = (y + 1) if side == "N" else y
                a, b = [r4(x * G), r4(yy * G)], [r4((x + 1) * G), r4(yy * G)]
            else:
                xx = (x + 1) if side == "E" else x
                a, b = [r4(xx * G), r4(y * G)], [r4(xx * G), r4((y + 1) * G)]
            doors.append({"room": lay["grid"][H - 1 - y][x], "from": "entrance", "entrance": True, "a": a, "b": b, "app": True})
    return {
        "rooms": [{"key": r["key"], "type": r["type"], "name": r["name"], "area_m2": r["area_m2"], "rings": r["rings"],
                   "label": r["label"]} for r in d["rooms"]],
        "doors": doors,
        "room_lines": d.get("room_lines") or [],
        "free_walls": d.get("free_walls") or [],
        "facade": facade_runs(shape),
        "grid": lay["grid"],
        "legend": lay["legend"],
    }


def studio_request(it: dict) -> tuple[dict | None, str | None]:
    """The request `tools.measure_model` (the studio's measure path) sends for the archive plan, captured at E10's
    `furnish_one_with_geometry` without running the Furnisher; (None, why) when it sends none."""
    F = D.Toolkit.get().C.furnish
    cap = {}
    orig = F.furnish_one_with_geometry
    F.furnish_one_with_geometry = lambda req: (cap.__setitem__("req", json.loads(json.dumps(req))), {"error": "captured"})[1]
    try:
        lay = D.placed_layout(it["doc"], it["sym"])
        m = TL.measure_model(it["shape"], None, {"grid": lay["grid"], "legend": lay["legend"], "doors": lay["doors"]})
    except Exception as e:   # noqa: BLE001
        return None, f"{type(e).__name__}: {e}"
    finally:
        F.furnish_one_with_geometry = orig
    if "req" in cap:
        return cap["req"], None
    why = m.get("parse_errors") or ((m.get("frec") or {}).get("not_computable") or {}).get("apartment.furn2") or "no request"
    return None, f"not furnished by the studio: {why}"


def stored_of(f: dict | None) -> dict | None:
    if not f or not f.get("computable") or not (f.get("apartment") or {}).get("furnisher"):
        return None
    a = f["apartment"]["furnisher"]
    rooms = []
    for r in f["rooms"]:
        fr = r["furnisher"]
        rooms.append({"char": r["char"], "type": r["type"],
                      **({"score": fr["score"], "complete": fr["complete"], "area_m2": fr["area_m2"], "steps": fr["steps"],
                          "missing_steps": fr["missing_steps"]} if fr else {"score": None})})
    return {"version": f["version"], "score": a["score"], "complete": a["complete"], "error": a["error"], "rooms": rooms,
            "request_sha256": f["request_sha256"]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(FURNISHER / "furnisher-app" / "public" / "archive" / "composer"))
    ap.add_argument("--open-only", action="store_true")
    ap.add_argument("--others", type=int, default=300)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--seed", type=int, default=20261120)
    ap.add_argument("--verify", type=int, default=0)
    args = ap.parse_args()
    t0 = time.time()
    out_dir = Path(args.out)

    pls = [json.loads(ln) for ln in (ARCHIVE / "tables" / "placements.jsonl").read_bytes().splitlines() if ln.strip()]
    geom = lines_of(ARCHIVE / "measures" / GM.version())
    furn_dirs = sorted((ARCHIVE / "measures").glob("furn@*"))
    furn = lines_of(furn_dirs[-1]) if furn_dirs else {}
    links = collections.defaultdict(list)
    for ln in (ARCHIVE / "tables" / "shape_links.jsonl").read_bytes().splitlines():
        if ln.strip():
            s = json.loads(ln)
            links[s["shape_id"]].append({"brief": s["brief"], "record": s.get("record")})
    print(f"archive: {len(pls)} placements, {len(geom)} geom lines ({GM.version()}), {len(furn)} furn lines "
          f"({furn_dirs[-1].name if furn_dirs else '-'})")

    drawings, shapes = {}, {}

    def drawing(h):
        if h not in drawings:
            drawings[h] = json.loads((ARCHIVE / "drawings" / h[:2] / f"{h}.json").read_bytes())
        return drawings[h]

    def shape_of(sid):
        if sid not in shapes:
            shapes[sid] = json.loads((ARCHIVE / "shapes" / sid[:2] / f"{sid}.json").read_bytes())
        return shapes[sid]

    # one placement per distinct measured drawing: the first by pl_id whose stored furn line is computable
    by_hash = collections.defaultdict(list)
    for pl in pls:
        by_hash[pl["hash"]].append(pl)
    chosen_open, chosen_other = [], []
    for h in sorted(by_hash):
        cands = sorted(by_hash[h], key=lambda p: p["pl_id"])
        ok = [p for p in cands if (furn.get(p["pl_id"]) or {}).get("computable") and p["pl_id"] in geom]
        if not ok:
            continue
        pl = ok[0]
        is_open = "Open kitchen" in drawing(h)["layout"]["legend"].values()
        (chosen_open if is_open else chosen_other).append(pl)
    rnd = random.Random(args.seed)
    if args.limit:
        rnd.shuffle(chosen_open)
        chosen_open = sorted(chosen_open[: args.limit], key=lambda p: p["hash"])
    others = [] if args.open_only else sorted(rnd.sample(chosen_other, min(args.others, len(chosen_other))), key=lambda p: p["hash"])
    picked = chosen_open + others
    print(f"distinct computable drawings: {len(chosen_open)} with an Open kitchen, {len(chosen_other)} without; "
          f"exporting {len(chosen_open)} + {len(others)}")

    items = []
    for pl in picked:
        doc, shape, g = drawing(pl["hash"]), shape_of(pl["shape_id"]), geom[pl["pl_id"]]
        items.append({"pl_id": pl["pl_id"], "hash": pl["hash"], "drawn_hash": pl["drawn_hash"], "doc": doc, "shape": shape,
                      "sym": pl["sym"], "g": g, "p": P2.measure(doc, shape, pl["sym"], g)})
    prepared = F2.prepare(items)

    stats = collections.Counter()
    layouts, index = [], []
    for it, inp, nc, req, sha in prepared:
        if inp is None:
            stats["furn2 not computable"] += 1
            continue
        f = furn.get(it["pl_id"])
        res, _ = FN.furnisher_input(it["doc"], it["shape"], it["sym"], it["g"])
        old_sha = FN.request_sha256(FN.request_of(res, it["shape"]["type"]))
        stored = stored_of(f)
        stats["furn request sha == stored furn sha" if stored and old_sha == stored["request_sha256"] else "furn request sha != stored"] += 1
        stats["archive furn2 request == furn request" if sha == old_sha else "archive furn2 request differs from furn"] += 1
        sreq, why = studio_request(it)
        source = "studio"
        if sreq is None:
            stats[f"studio measure_model: no request ({why[:90]}); archive furn2 request used"] += 1
            sreq, source = req, f"archive furn2 (measure_model: {why[:200]})"
        studio_sha = FN.request_sha256(sreq)
        if studio_sha == sha:
            stats["studio request == archive furn2 request"] += 1
        else:
            same_but_entrance = (sreq["rooms"] == req["rooms"] and len(sreq["doors"]) == len(req["doors"])
                                 and sum(a != b for a, b in zip(sreq["doors"], req["doors"])) == 1)
            stats["studio request differs from archive furn2: " + ("one door point (the entrance)" if same_but_entrance else "other")] += 1
        chars = [c for c, r in inp["rooms"].items() if r["furnisher_name"] is not None]
        try:
            draw = drawing_of(it["doc"], it["sym"], it["shape"])
        except Exception as e:   # noqa: BLE001
            stats[f"drawing failed: {type(e).__name__}"] += 1
            continue
        types = {r["char"]: r["type"] for r in it["g"]["rooms"]}
        has_open = "Open kitchen" in types.values()
        open_sent = any(r["subtype"] == F2.OPEN_KITCHEN for r in sreq["rooms"])
        lid = it["pl_id"][:12]
        rec = {
            "id": lid,
            "pl_id": it["pl_id"], "hash": it["hash"], "drawn_hash": it["drawn_hash"], "shape_id": it["shape"]["shape_id"],
            "sym": it["sym"], "briefs": links.get(it["shape"]["shape_id"], []),
            "aptType": it["shape"]["type"], "W": it["shape"]["W"], "H": it["shape"]["H"],
            "request": sreq, "request_sha256": studio_sha, "request_path": "studio tools.measure_model (furn2)" if source == "studio" else source,
            "archive_furn2_sha256": sha, "furn_request_sha256": old_sha, "request_chars": chars,
            "door_edges": [x["edge"] for x in it["p"]["apartment"]["furnisher_doors_m"]],
            "stored": stored,
            "draw": draw,
        }
        layouts.append(rec)
        area = sum(r["area"] or 0 for r in sreq["rooms"])
        index.append({"id": lid, "aptType": rec["aptType"], "open": has_open, "openSent": open_sent,
                      "briefs": sorted({b["brief"] for b in rec["briefs"]}),
                      "storedScore": stored["score"] if stored else None, "nRooms": len(sreq["rooms"]), "area": round(area, 2),
                      "sameAsFurn": studio_sha == old_sha, "studio": source == "studio",
                      **({} if source == "studio" else {"studioWhy": why})})

    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("chunk-*.json"):
        old.unlink()
    total = 0
    for k in range(0, len(layouts), CHUNK):
        name = f"chunk-{k // CHUNK:03d}.json"
        for row in index[k:k + CHUNK]:
            row["chunk"] = name
        b = json.dumps({"format": FORMAT, "layouts": layouts[k:k + CHUNK]}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        (out_dir / name).write_bytes(b)
        total += len(b)
    meta = {
        "format": FORMAT,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "composer": str(COMPOSER),
        "request_path": "studio: stc.floorplan.tools.measure_model (run_measure under RULESET) -> furn2 request",
        "stored_path": furn_dirs[-1].name if furn_dirs else None,
        "geom": GM.version(),
        "counts": dict(stats),
        "n": len(index),
        "layouts": index,
    }
    b = json.dumps(meta, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    (out_dir / "index.json").write_bytes(b)
    total += len(b)
    print(json.dumps(dict(stats), indent=1))
    print(f"wrote {len(layouts)} layouts in {(len(layouts) + CHUNK - 1) // CHUNK} chunks + index to {out_dir} "
          f"({total / 1e6:.1f} MB) in {time.time() - t0:.0f} s")

    if args.verify:
        verify(items, prepared, layouts, args.verify, out_dir, rnd)
    return 0


def verify(items, prepared, layouts, n, out_dir: Path, rnd) -> None:
    """The studio's own measure path (`tools.measure_model`, what `run_measure` calls for a plan under RULESET) on a
    sample: its request sha256 must equal the exported one. Runs the Furnisher CLI of this clone once per layout."""
    by_pl = {it["pl_id"]: it for it in items}
    open_ = [x for x in layouts if any(r["subtype"] == "Open kitchen" for r in x["request"]["rooms"])]
    rest = [x for x in layouts if x not in open_]
    sample = rnd.sample(open_, min(len(open_), (n * 2 + 2) // 3)) + rnd.sample(rest, min(len(rest), n // 3))
    rows, ok = [], 0
    for x in sample:
        it = by_pl[x["pl_id"]]
        lay = D.placed_layout(it["doc"], it["sym"])
        m = TL.measure_model(it["shape"], None, {"grid": lay["grid"], "legend": lay["legend"], "doors": lay["doors"]})
        same = m["request_sha256"] == x["request_sha256"]
        ok += same
        rep = m.get("rep") or {}
        rows.append({"id": x["id"], "pl_id": x["pl_id"], "sha_equal": same, "measure_model_sha": m["request_sha256"],
                     "export_sha": x["request_sha256"], "measure_model_score": rep.get("score"),
                     "measure_model_rooms": [rm.get("score") for rm in rep.get("rooms") or []],
                     "stored_score": (x["stored"] or {}).get("score")})
        print(f"  verify {x['id']}: sha {'==' if same else '!='} measure_model, score now {rep.get('score')} "
              f"(stored old engine {(x['stored'] or {}).get('score')})")
    (out_dir / "verify_measure_model.json").write_text(json.dumps({"n": len(rows), "sha_equal": ok, "rows": rows}, indent=1),
                                                     encoding="utf-8")
    print(f"verify: {ok} of {len(rows)} exported requests equal the studio's measure_model request")


if __name__ == "__main__":
    sys.exit(main())
