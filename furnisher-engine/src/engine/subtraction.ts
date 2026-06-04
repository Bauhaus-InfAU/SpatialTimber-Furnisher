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

const { difference } = polygonClipping;
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
