"""
FURNITURE LIBRARY EXPORTER  ·  Grasshopper Python 3 Component (Rhino 8+)
═══════════════════════════════════════════════════════════════════════════

HOW TO WIRE  — 6 inputs total:

  GH input name    │ Access mode │ Type    │ What to connect
  ─────────────────┼─────────────┼─────────┼──────────────────────────────────
  i_data           │ Tree        │ Generic │ the Merge (or Entwine) output R
  i_apartment_type │ Item        │ Integer │ number of rooms: 1 / 2 / 3 / 4
  i_room_tag       │ Item        │ Text    │ e.g. "Bathroom" / "Livingroom"
  i_furn_name      │ Item        │ Text    │ e.g. "Sofa" / "Dining" / "Bath"
  i_out_folder     │ Item        │ Text    │ path to your furn_library/jsons folder
  i_run            │ Item        │ Boolean │ toggle True to export

  Output filename:  {apt_type}_{Room}_{FurnName}.json
  Examples:         3_Livingroom_Sofa.json
                    3_Livingroom_Dining.json
                    1_Bathroom_Bath.json

  Output:
  o_log            │ Item        │ Text    │ status / debug messages

──────────────────────────────────────────────────────────────────────────
EXPECTED DATA PER BRANCH  (what your Merge packs into each R output)

  index 0   name             str
  index 1   line placement   curve (line-like)
  index 2   importance       int
  index 3   score            int
  index 4   bbox big         curve (rectangle)
  index 5   bbox small       curve (rectangle)
  index 6+  geometry         one or more curves, or a GH Group of curves

BRANCH / PATH STRUCTURE

  Depth 1  {i}      → each branch is one furniture piece (no variants)
  Depth 2  {i ; j}  → i = piece index,  j = variant index
                       branches with the same i are grouped as variants

  The script detects depth automatically.
"""

import Rhino.Geometry as rg
import Rhino
import System
import rhinoscriptsyntax as rs
import Grasshopper.Kernel.Types as gkt
import json
import os
import math


# ─────────────────────────────────────────────────────────────────────────────
#  GEOMETRY HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def pt2(pt):
    """Rhino Point3d → [x, y]  (Z dropped — 2-D library)."""
    return [round(pt.X, 4), round(pt.Y, 4)]


def to_curve(item):
    """
    Extract a Rhino Curve from whatever GH hands us.

    Resolution order:
      1. Already a Curve                      → return directly
      2. GH wrapper (.Value)                  → unwrap
      3. rg.Line struct                       → wrap in LineCurve
      4. rhinoscriptsyntax.coercecurve()      → resolves GH volatile GUIDs
      5. GH_Curve.CastFrom()                  → GH type-system cast
      6. ghenv GH-doc lookup                  → last resort for GH internals
    """
    if item is None:
        return None

    # 1. Already a Rhino curve
    if isinstance(item, rg.Curve):
        return item

    # 2. GH wrapper (GH_Curve, GH_Line…) — unwrap via .Value
    if hasattr(item, "Value"):
        val = item.Value
        if isinstance(val, rg.Curve):
            return val
        if isinstance(val, rg.Line):
            return rg.LineCurve(val)

    # 3. rg.Line struct passed directly
    if isinstance(item, rg.Line):
        return rg.LineCurve(item)

    # 4. rhinoscriptsyntax — designed to resolve GH volatile GUIDs
    try:
        crv = rs.coercecurve(item)
        if crv is not None:
            return crv
    except Exception:
        pass

    # 5. GH type-system cast (GH_Curve.CastFrom handles GH-internal refs)
    try:
        gh_crv = gkt.GH_Curve()
        if gh_crv.CastFrom(item):
            return gh_crv.Value
    except Exception:
        pass

    # 6. ghenv GH-document lookup
    try:
        doc  = ghenv.Component.OnPingDocument()
        obj  = doc.FindObject(item, True)
        if obj is not None and hasattr(obj, "VolatileData"):
            for path in obj.VolatileData.Paths:
                for goo in obj.VolatileData.Branch(path):
                    c = to_curve(goo)   # recurse once with the unwrapped goo
                    if c is not None:
                        return c
    except Exception:
        pass

    return None


def extract_curves(items):
    """
    Pull all Rhino Curves from a list of items.
    Handles: plain curves, GH-wrapped curves, GH Groups containing curves.
    """
    curves = []
    for item in items:
        if item is None:
            continue

        c = to_curve(item)
        if c is not None:
            curves.append(c)
            continue

        # Try iterating (List[Object], GH Group, or any other container)
        try:
            for sub in item:
                c = to_curve(sub)   # to_curve handles GUIDs internally
                if c is not None:
                    curves.append(c)
        except TypeError:
            pass  # not iterable — skip

    return curves


def serialize_line(curve):
    """
    Placement curve → { "points": [[x,y], ...] }

    Works for both simple lines (2 pts) and polyline corners (3+ pts).
    Always stores all vertices — downstream code can treat 2-pt result as a
    simple line and 3+-pt result as a placement corner / L-shape.
    """
    if curve is None:
        return None

    ok, pl = curve.TryGetPolyline()
    if ok and pl.Count >= 2:
        pts = [pt2(p) for p in pl]
        # drop duplicate closing point if curve is accidentally closed
        if curve.IsClosed and len(pts) > 1 and pts[0] == pts[-1]:
            pts = pts[:-1]
        return {"points": pts}

    # Fallback for non-polyline curves: just keep start + end
    return {"points": [pt2(curve.PointAtStart), pt2(curve.PointAtEnd)]}


def serialize_rect(curve):
    """
    Rectangle curve → { "origin":[x,y], "width":f, "height":f, "rotation":f }
    Falls back to axis-aligned bbox if the curve is not a clean 4-point polyline;
    adds "_note":"fallback-bbox" so you can spot it in the output.
    """
    if curve is None:
        return None

    ok, pl = curve.TryGetPolyline()
    if ok and pl.Count in (4, 5):
        pts = list(pl)[:4]
        dx  = pts[1].X - pts[0].X
        dy  = pts[1].Y - pts[0].Y
        dx2 = pts[2].X - pts[1].X
        dy2 = pts[2].Y - pts[1].Y
        return {
            "origin":   pt2(pts[0]),
            "width":    round(math.hypot(dx, dy),   4),
            "height":   round(math.hypot(dx2, dy2), 4),
            "rotation": round(math.degrees(math.atan2(dy, dx)), 4),
            "points":   [pt2(p) for p in pts]   # exact corners — used by viewer
        }

    bb = curve.GetBoundingBox(True)
    mn, mx = bb.Min, bb.Max
    return {
        "origin":   pt2(mn),
        "width":    round(mx.X - mn.X, 4),
        "height":   round(mx.Y - mn.Y, 4),
        "rotation": 0.0,
        "points":   [pt2(mn), [round(mx.X,4), round(mn.Y,4)],
                     pt2(mx), [round(mn.X,4), round(mx.Y,4)]],
        "_note":    "fallback-bbox"
    }


def serialize_curves(curves):
    """
    List of Rhino Curves → [ { "closed":bool, "points":[[x,y],...] }, ... ]
    Non-polyline curves are discretised to 32 points and flagged.
    """
    result = []
    for crv in curves:
        ok, pl = crv.TryGetPolyline()
        if ok:
            pts = [pt2(p) for p in pl]
            if crv.IsClosed and len(pts) > 1 and pts[0] == pts[-1]:
                pts = pts[:-1]   # drop duplicate closing point
            result.append({"closed": crv.IsClosed, "points": pts})
        else:
            n   = 32
            dom = crv.Domain
            cnt = n + (0 if crv.IsClosed else 1)
            pts = [pt2(crv.PointAt(dom.ParameterAt(i / n))) for i in range(cnt)]
            result.append({"closed": crv.IsClosed, "points": pts, "_discretised": True})
    return result


# ─────────────────────────────────────────────────────────────────────────────
#  BRANCH PARSER
# ─────────────────────────────────────────────────────────────────────────────

def parse_branch(items):
    """
    Read one Merge-R branch and return a variant dict.

    Expected layout:
      items[0]  name          (read upstream, not used here)
      items[1]  line placement
      items[2]  importance    (read upstream)
      items[3]  score         (read upstream)
      items[4]  bbox big
      items[5]  bbox small
      items[6+] geometry curves / group
    """
    lp_curve  = to_curve(items[1]) if len(items) > 1 else None
    bb_curve  = to_curve(items[4]) if len(items) > 4 else None
    bs_curve  = to_curve(items[5]) if len(items) > 5 else None
    geo_items = items[6:]          if len(items) > 6 else []

    return {
        "linePlacement": serialize_line(lp_curve),
        "bboxBig":       serialize_rect(bb_curve),
        "bboxSmall":     serialize_rect(bs_curve),
        "geometry":      serialize_curves(extract_curves(geo_items))
    }


# ─────────────────────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────────────────────

log_lines = []

# ── guard: catch wrong access mode early ─────────────────────────────────────
if isinstance(i_data, list):
    o_log = (
        "✗  i_data is a plain list — access mode is wrong.\n\n"
        "Fix:  right-click the  i_data  input on this component\n"
        "      → select  'Tree Access'\n"
        "      → reconnect the wire and run again."
    )
    raise SystemExit  # stop execution cleanly

if not i_run:
    # ── debug mode: print types + values for every item in every branch ───────
    log_lines.append("DEBUG — set  i_run = True  to export.")
    log_lines.append("")
    for path in i_data.Paths:
        branch = list(i_data.Branch(path))
        log_lines.append("Path {}  ({} items):".format(path, len(branch)))
        for i, item in enumerate(branch):
            t    = type(item)
            tmod = t.__module__ or ""
            tnm  = t.__name__
            full = "{}.{}".format(tmod, tnm) if tmod else tnm
            val  = str(item)[:60]
            # also try .Value if it exists
            inner = ""
            if hasattr(item, "Value"):
                iv = item.Value
                inner = "  .Value → {}.{}  {}".format(
                    type(iv).__module__ or "", type(iv).__name__, str(iv)[:40])
            # if it's a GUID, try resolving it and report the result
            resolve_note = ""
            if isinstance(item, System.Guid):
                crv = to_curve(item)
                resolve_note = "  → resolved: {}".format(
                    type(crv).__name__ if crv else "FAILED")
            log_lines.append("  [{}]  {}  |  {}{}{}".format(
                i, full, val, inner, resolve_note))
        log_lines.append("")
else:
    try:
        paths = list(i_data.Paths)

        # ── detect tree depth ─────────────────────────────────────────────────
        #   depth 1  {n}     → one branch = one piece
        #   depth 2  {n;m}   → outer index = piece,  inner = variant
        depth = max(len(list(p.Indices)) for p in paths) if paths else 1

        # ── group branches by piece index ─────────────────────────────────────
        from collections import defaultdict
        piece_branches = defaultdict(list)  # piece_i → [ (variant_i, [items]) ]

        for path in paths:
            indices  = list(path.Indices)
            piece_i  = indices[0]
            variant_i = indices[1] if depth >= 2 else 0
            piece_branches[piece_i].append((variant_i, list(i_data.Branch(path))))

        # sort pieces and variants
        pieces = []

        for piece_i in sorted(piece_branches.keys()):
            variants_raw = sorted(piece_branches[piece_i], key=lambda x: x[0])

            # scalar fields come from the first variant's branch
            first_items = variants_raw[0][1]
            name_val       = str(first_items[0]).strip() if len(first_items) > 0 else "unnamed-{}".format(piece_i)
            importance_val = int(first_items[2])         if len(first_items) > 2 else 0
            score_val      = int(first_items[3])         if len(first_items) > 3 else 0

            variants = [parse_branch(items) for _, items in variants_raw]

            pieces.append({
                "id":            name_val.lower().replace(" ", "-"),
                "name":          name_val,
                "apartmentType": int(i_apartment_type),
                "category":      i_room_tag,
                "furnitureName": i_furn_name.strip(),
                "importance":    importance_val,
                "score":         score_val,
                "variants":      variants
            })

            log_lines.append("  piece [{}]  '{}'  →  {} variant(s)".format(
                piece_i, name_val, len(variants)))

        # ── write JSON ────────────────────────────────────────────────────────
        os.makedirs(i_out_folder, exist_ok=True)
        filename = "{}_{}_{}".format(int(i_apartment_type), i_room_tag, i_furn_name.strip()) + ".json"
        out_file = os.path.join(i_out_folder, filename)

        payload = {
            "apartmentType": int(i_apartment_type),
            "category":      i_room_tag,
            "furnitureName": i_furn_name.strip(),
            "pieces":        pieces
        }
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

        log_lines.insert(0, "✓  {} piece(s) → {}".format(len(pieces), out_file))
        log_lines.insert(1, "")

    except Exception as exc:
        import traceback
        log_lines.append("✗  ERROR: " + str(exc))
        log_lines.append("")
        log_lines.append(traceback.format_exc())

o_log = "\n".join(log_lines)
