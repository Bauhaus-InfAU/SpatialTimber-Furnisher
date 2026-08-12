// ─── Wall generation ──────────────────────────────────────────────────────────
// Walls are built from wall AXES — the drawn polylines (apartment contour, room
// outlines) — not edge by edge. Each axis is offset twice, outward and inward,
// and the wall body is the region between the two offsets:
//
//   "outer"   → outward = t, inward = 0   (the axis is the inner face)
//   "inner"   → outward = 0, inward = t   (the axis is the outer face)
//   "midline" → outward = t/2, inward = t/2
//
// Offsetting the whole closed polyline (mitred at the vertices, following the
// angle bisector) is what makes corners come out clean — per-edge bands can only
// overlap or leave notches there. All bands are then UNITED, so partitions meet
// the shell and each other as one surface, and the door/window openings are cut
// out of that single surface last.

import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import type { Point2D, WallOffset } from "./types";

/** One wall body: [outer ring, ...hole rings] — render with fill-rule evenodd. */
export type WallPolygon = Point2D[][];

export type WallAxis = {
  /** Closed polyline the wall is built along (open ring — no repeated vertex). */
  polygon: Point2D[];
  thickness: number;
  offset: WallOffset;
  /** Optional region the band is clipped to (partitions kept out of the shell). */
  clip?: Point2D[];
};

// polygon-clipping (0.15.x) trips over near-degenerate float coordinates; the
// engine works around it the same way, by snapping operands to a fine grid.
const GRID = 1e-5;
const snap = (v: number) => Math.round(v / GRID) * GRID;

function toRing(points: Point2D[]): Ring {
  return points.map((p) => [snap(p.x), snap(p.y)] as [number, number]);
}

function fromRing(ring: Ring): Point2D[] {
  return (ring as [number, number][]).map(([x, y]) => ({ x, y }));
}

function pointInRing(p: Point2D, ring: Point2D[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const intersects =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

// A spike at a very sharp vertex would run away to infinity, so the mitre is
// capped — 4× the offset matches the usual CAD default.
const MAX_MITER = 4;
const PROBE = 1e-4;

/** Offset a closed polyline by `dist` — positive outward, negative inward —
 *  moving every vertex along its angle bisector (mitre join). The side is
 *  decided per vertex by probing, so winding direction doesn't matter. */
export function offsetContour(ring: Point2D[], dist: number): Point2D[] {
  const n = ring.length;
  if (n < 3 || dist === 0) return ring;
  const out: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];

    const l1 = Math.hypot(prev.x - cur.x, prev.y - cur.y);
    const l2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const v1 = { x: (prev.x - cur.x) / l1, y: (prev.y - cur.y) / l1 };
    const v2 = { x: (next.x - cur.x) / l2, y: (next.y - cur.y) / l2 };

    let dir: Point2D;
    let scale: number;
    const bx = v1.x + v2.x;
    const by = v1.y + v2.y;
    const blen = Math.hypot(bx, by);
    if (blen < 1e-9) {
      // Straight-through vertex: no bisector, offset along the edge normal.
      dir = { x: -v2.y, y: v2.x };
      scale = 1;
    } else {
      dir = { x: bx / blen, y: by / blen };
      const dot = Math.min(1, Math.max(-1, v1.x * v2.x + v1.y * v2.y));
      const sinHalf = Math.sin(Math.acos(dot) / 2);
      scale = sinHalf > 1e-6 ? Math.min(1 / sinHalf, MAX_MITER) : MAX_MITER;
    }

    const bisectorPointsInside = pointInRing(
      { x: cur.x + dir.x * PROBE, y: cur.y + dir.y * PROBE },
      ring,
    );
    const sign = bisectorPointsInside === dist < 0 ? 1 : -1;
    const d = Math.abs(dist) * scale * sign;
    out.push({ x: cur.x + dir.x * d, y: cur.y + dir.y * d });
  }
  return out.length >= 3 ? out : ring;
}

/** Outward / inward offsets an axis carries for a given offset mode. */
export function wallSpans(thickness: number, offset: WallOffset): [number, number] {
  if (offset === "outer") return [thickness, 0];
  if (offset === "inner") return [0, thickness];
  return [thickness / 2, thickness / 2];
}

/** Inner face of a wall built along `polygon` — the boundary of the space left
 *  clear inside it. */
export function wallInnerFace(polygon: Point2D[], thickness: number, offset: WallOffset): Point2D[] {
  const [, inward] = wallSpans(thickness, offset);
  return inward > 0 ? offsetContour(polygon, -inward) : polygon;
}

function bandFor(axis: WallAxis): MultiPolygon {
  const { polygon, thickness, offset, clip } = axis;
  if (polygon.length < 3 || thickness <= 0) return [];
  const [outward, inward] = wallSpans(thickness, offset);
  const outer = outward > 0 ? offsetContour(polygon, outward) : polygon;
  const inner = inward > 0 ? offsetContour(polygon, -inward) : polygon;
  try {
    let band = polygonClipping.difference([toRing(outer)], [toRing(inner)]);
    if (clip && clip.length >= 3 && band.length) {
      band = polygonClipping.intersection(band, [toRing(clip)]);
    }
    return band;
  } catch {
    return [];
  }
}

/** Build the wall surface: every axis offset into a band, all bands united, then
 *  the opening cutters (doors, windows) subtracted from the union. */
export function buildWalls(
  axes: WallAxis[],
  cutters: Array<[number, number][]> = [],
): WallPolygon[] {
  const bands = axes.map(bandFor).filter((b) => b.length);
  if (!bands.length) return [];

  let surface: MultiPolygon;
  try {
    surface = polygonClipping.union(bands[0], ...bands.slice(1));
  } catch {
    surface = bands.flat();  // union failed — keep the bands as separate bodies
  }

  if (cutters.length) {
    try {
      surface = polygonClipping.difference(
        surface,
        ...cutters.map((c) => [c.map(([x, y]) => [snap(x), snap(y)] as [number, number])] as MultiPolygon[number]),
      );
    } catch {
      // A cutting hiccup must never delete the walls — leave them uncut.
    }
  }

  return surface
    .map((poly) => poly.map(fromRing).filter((ring) => ring.length >= 3))
    .filter((poly) => poly.length > 0);
}
