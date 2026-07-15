/**
 * subtraction.ts
 * ──────────────
 * Boolean polygon subtraction for Stage-4 room updates.
 *
 * Uses the `polygon-clipping` library (Clipper-based, floating-point native)
 * for correct multi-polygon difference operations.
 *
 * The custom hand-rolled `notchPolygon` implementation is kept below but
 * disabled — see the DISABLED IMPLEMENTATION section at the bottom.
 */

import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";

const { difference: _rawDifference } = polygonClipping;

// ─── Robust boolean difference ─────────────────────────────────────────────
//
// `polygon-clipping` (0.15.x) has a well-known floating-point robustness bug:
// on many perfectly valid inputs it throws "Unable to complete output ring".
// In this engine it fired on essentially ANY non-axis-aligned room — a plain
// rectangle rotated by 0.5° was enough to kill placement — because the cutout
// polygons the placer generates against slanted walls carry irrational
// coordinates the sweep-line can't stitch.
//
// The fix: snap every operand to a fine grid before clipping. Grid-aligned
// coordinates avoid the degenerate comparisons that trip the library, and a
// 1e-5 m grid (0.01 mm) is far below any meaningful furniture tolerance.
// We try progressively coarser grids as a fallback ladder; if all fail we
// throw the original error so callers (per-room isolation, app furnishError)
// still see it — but in practice the first grid resolves it.

type Nested = number | Nested[];

function snapGeom(g: any, grid: number): any {
  // Bottoms out at a [x, y] coordinate pair; snaps every coordinate to `grid`.
  if (typeof g[0] === "number") {
    return [Math.round(g[0] / grid) * grid, Math.round(g[1] / grid) * grid];
  }
  return g.map((child: Nested) => snapGeom(child, grid));
}

function rotateGeom(g: any, cos: number, sin: number): any {
  if (typeof g[0] === "number") {
    return [g[0] * cos - g[1] * sin, g[0] * sin + g[1] * cos];
  }
  return g.map((child: Nested) => rotateGeom(child, cos, sin));
}

const SNAP_LADDER = [1e-5, 1e-4, 1e-6, 1e-3];
// Tiny rotations to break exact-symmetry degeneracies (e.g. a rectangle at 45°)
// that grid-snapping alone cannot resolve. Operands are rotated in, clipped,
// and the result is rotated back into the original frame.
const ROT_LADDER = [0.013, -0.019, 0.037];

function difference(subject: any, ...clips: any[]): any {
  let lastErr: unknown;
  for (const grid of SNAP_LADDER) {
    try {
      return _rawDifference(
        snapGeom(subject, grid),
        ...clips.map((c) => snapGeom(c, grid)),
      );
    } catch (e) {
      lastErr = e;
    }
  }
  for (const deg of ROT_LADDER) {
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    try {
      const res = _rawDifference(
        snapGeom(rotateGeom(subject, cos, sin), 1e-6),
        ...clips.map((c) => snapGeom(rotateGeom(c, cos, sin), 1e-6)),
      );
      return rotateGeom(res, cos, -sin); // rotate result back into original frame
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
import type { Point2D, Room } from "../layout/types";
import type { PlacedFurniture } from "./types";
import { getDoorRectangles } from "./placer";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ringSignedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function pickLargest(mp: MultiPolygon): Point2D[] {
  if (mp.length === 0) return [];
  let best = mp[0];
  let bestArea = Math.abs(ringSignedArea(best[0]));
  for (const poly of mp.slice(1)) {
    const a = Math.abs(ringSignedArea(poly[0]));
    if (a > bestArea) { bestArea = a; best = poly; }
  }
  return best[0] as Point2D[];
}

function toClipPoly(pts: Point2D[]): Ring[] {
  return [pts as Ring];
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Subtract `cutout` from `poly` and return the outer ring of the largest
 * resulting polygon. Returns an empty array if the subtraction leaves nothing.
 */
export function subtractPolygon(poly: Point2D[], cutout: Point2D[]): Point2D[] {
  const result = difference(toClipPoly(poly), toClipPoly(cutout));
  return pickLargest(result);
}

/**
 * Computes updated room polygons after subtracting one placed furniture piece.
 *
 *   roomFull — room_polygon − smallCutout
 *   roomRdc  — room_polygon − doorRect − largeCutout
 */
export function subtractPlacement(
  room: Room,
  placed: PlacedFurniture,
): { roomFull: Point2D[]; roomRdc: Point2D[] } {
  const doorRects = getDoorRectangles(room);

  const fullResult = difference(
    toClipPoly(room.polygon),
    toClipPoly(placed.smallCutout),
  );

  const rdcResult = difference(
    toClipPoly(room.polygon),
    ...doorRects.map(toClipPoly),
    toClipPoly(placed.largeCutout),
  );

  return {
    roomFull: pickLargest(fullResult),
    roomRdc:  pickLargest(rdcResult),
  };
}
