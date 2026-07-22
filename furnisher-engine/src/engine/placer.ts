/**
 * placer.ts
 * ─────────
 * Places furniture entries onto room walls.
 *
 * Port of placement.py stages 0-3, plus collision validation:
 *   0. Extract furniture width/depth from bboxBig
 *   1. Find room walls long enough, excluding the door exclusion zone
 *   2. Compute inward normal, pick valid wall positions
 *   3. Build 2D affine transform and apply to geometry
 *   +. Collision check: bboxSmall must fit entirely inside room polygon
 */

import type { Point2D, Room } from "../layout/types";
import type { FurnitureEntry, FurnitureVariant } from "../library/types";
import type { PlacedFurniture, PlacementOption, PlacementOptions } from "./types";

export type { PlacedFurniture, PlacementOption, PlacementOptions };

// ─── Geometry helpers ────────────────────────────────────────────────────────

function sub(a: Point2D, b: Point2D): Point2D {
  return [a[0] - b[0], a[1] - b[1]];
}

function add(a: Point2D, b: Point2D): Point2D {
  return [a[0] + b[0], a[1] + b[1]];
}

function scalePt(v: Point2D, s: number): Point2D {
  return [v[0] * s, v[1] * s];
}

function dot(a: Point2D, b: Point2D): number {
  return a[0] * b[0] + a[1] * b[1];
}

function vlen(v: Point2D): number {
  return Math.hypot(v[0], v[1]);
}

function normalize(v: Point2D): Point2D {
  const l = vlen(v);
  return l > 1e-12 ? [v[0] / l, v[1] / l] : [0, 0];
}

function segmentLength(a: Point2D, b: Point2D): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function distToSeg(pt: Point2D, a: Point2D, b: Point2D): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < 1e-12) return vlen(sub(pt, a));
  const t = Math.max(0, Math.min(1, dot(sub(pt, a), ab) / len2));
  return vlen(sub(pt, add(a, scalePt(ab, t))));
}

function perpCCW(v: Point2D): Point2D {
  return [-v[1], v[0]];
}

// ─── Point-in-polygon (ray casting, works for concave L-shapes) ───────────────

function pointInPolygon(pt: Point2D, polygon: Point2D[]): boolean {
  const [px, py] = pt;
  const n = polygon.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Polygon simplification (strip CAD/model noise) ──────────────────────────
//
// Dataset (and traced) room polygons carry model noise: sub-decimetre spur
// edges and tiny notches left by wall-thickness modelling. These are 90° turns
// (so plain collinear-removal misses them) yet they fragment a wall into short
// pieces and invent fake corners with ~0.1 m arms — which defeats corner-based
// furniture placement even in a visually rectangular room. We therefore:
//   1. collapse any edge shorter than `minEdge` (merge its endpoints),
//   2. straighten walls that are within `angTolDeg` of axis-aligned so a
//      column/notch jog becomes one clean straight wall (and furniture placed
//      against it is not left slightly rotated), then
//   3. drop vertices whose perpendicular deviation from their neighbours is
//      below `collinearTol`.
// The collapse and collinear loops stop at a quad so a genuine rectangle can
// never be over-collapsed. Genuinely diagonal walls (> angTolDeg off axis) are
// left untouched, so real non-orthogonal rooms are preserved.
export function simplifyPolygon(
  poly: Point2D[],
  minEdge = 0.15,
  collinearTol = 0.02,
  angTolDeg = 6,
): Point2D[] {
  if (poly.length < 4) return poly;
  let pts: Point2D[] = poly.map((p) => [p[0], p[1]]);

  let changed = true;
  while (changed && pts.length > 4) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < minEdge) {
        pts[i] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        pts.splice((i + 1) % pts.length, 1);
        changed = true;
        break;
      }
    }
  }

  // Orthogonal snap: any edge within angTolDeg of horizontal/vertical is forced
  // exactly axis-aligned (both endpoints share the averaged coordinate). Rooms
  // arrive in a canonical frame with the dominant wall on the x-axis, so this
  // removes the residual ~1° tilt left by wall-thickness noise and midpoint
  // collapse — the cause of slightly-rotated furniture. A couple of passes
  // converge for a rectilinear ring; truly angled edges are skipped.
  const tan = Math.tan((angTolDeg * Math.PI) / 180);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const dx = pts[j][0] - pts[i][0], dy = pts[j][1] - pts[i][1];
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx > 1e-9 && ady <= adx * tan) {          // near-horizontal → level y
        const y = (pts[i][1] + pts[j][1]) / 2;
        pts[i][1] = y; pts[j][1] = y;
      } else if (ady > 1e-9 && adx <= ady * tan) {   // near-vertical → level x
        const x = (pts[i][0] + pts[j][0]) / 2;
        pts[i][0] = x; pts[j][0] = x;
      }
    }
  }

  changed = true;
  while (changed && pts.length > 4) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
      const base = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (cross / base < collinearTol) { pts.splice(i, 1); changed = true; break; }
    }
  }

  return pts.length >= 3 ? pts : poly;
}

// ─── Ray → polygon-edge intersection ─────────────────────────────────────────

/**
 * Cast a ray from `origin` in direction `dir` and return the t-distance to the
 * nearest polygon edge it hits (excluding edges listed in `skipEdges` by index).
 * Returns Infinity if nothing is hit.
 */
function rayNearestWallHit(
  origin: Point2D, dir: Point2D, polygon: Point2D[], skipEdges: number[],
): number {
  const n = polygon.length;
  let tMin = Infinity;
  for (let j = 0; j < n; j++) {
    if (skipEdges.includes(j)) continue;
    const c  = polygon[j];
    const d  = polygon[(j + 1) % n];
    const cd = sub(d, c);
    const denom = dir[0] * cd[1] - dir[1] * cd[0];
    if (Math.abs(denom) < 1e-10) continue;
    const cp = sub(c, origin);
    const t  = (cp[0] * cd[1] - cp[1] * cd[0]) / denom;
    const s  = (cp[0] * dir[1] - cp[1] * dir[0]) / denom;
    if (t > 1e-6 && s >= -1e-6 && s <= 1 + 1e-6) tMin = Math.min(tMin, t);
  }
  return tMin;
}

// ─── Segment intersection (proper, ignores endpoint touches) ─────────────────

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  function cross3(o: Point2D, u: Point2D, v: Point2D): number {
    return (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
  }
  const d1 = cross3(c, d, a), d2 = cross3(c, d, b);
  const d3 = cross3(a, b, c), d4 = cross3(a, b, d);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

// ─── Door rectangle ──────────────────────────────────────────────────────────

export function doorWidth(roomName: string): number {
  return roomName === "Bathroom" || roomName === "WC" ? 0.8 : 0.9;
}

function getDoorObstacleSegments(room: Room, dw: number): [Point2D, Point2D][] {
  const doors = room.doors ?? [];
  if (doors.length === 0) return [];
  const { polygon } = room;
  const n = polygon.length;
  const allSegments: [Point2D, Point2D][] = [];

  for (const door of doors) {
    let wallA: Point2D = polygon[0];
    let wallB: Point2D = polygon[1];
    let minDist = Infinity;
    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      const d = distToSeg(door, a, b);
      if (d < minDist) { minDist = d; wallA = a; wallB = b; }
    }

    const wallDir = normalize(sub(wallB, wallA));
    const n1      = perpCCW(wallDir);
    const mid     = add(wallA, scalePt(wallDir, dot(sub(door, wallA), wallDir)));
    const inward  = pointInPolygon(add(mid, scalePt(n1, 0.05)), polygon) ? n1 : scalePt(n1, -1);

    const c0 = add(door, scalePt(wallDir, -dw / 2));
    const c1 = add(door, scalePt(wallDir,  dw / 2));
    const c2 = add(c1, scalePt(inward, dw));
    const c3 = add(c0, scalePt(inward, dw));

    allSegments.push([c1, c2], [c2, c3], [c3, c0]);
  }

  return allSegments;
}

export function getDoorRectangles(room: Room): Point2D[][] {
  const doors = room.doors ?? [];
  if (doors.length === 0) return [];
  const dw = doorWidth(room.name);
  const { polygon } = room;
  const n = polygon.length;
  const result: Point2D[][] = [];

  for (const door of doors) {
    let wallA: Point2D = polygon[0];
    let wallB: Point2D = polygon[1];
    let minDist = Infinity;
    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      const d = distToSeg(door, a, b);
      if (d < minDist) { minDist = d; wallA = a; wallB = b; }
    }

    const wallDir = normalize(sub(wallB, wallA));
    const n1      = perpCCW(wallDir);
    const mid     = add(wallA, scalePt(wallDir, dot(sub(door, wallA), wallDir)));
    const inward  = pointInPolygon(add(mid, scalePt(n1, 0.05)), polygon) ? n1 : scalePt(n1, -1);

    const c0 = add(door, scalePt(wallDir, -dw / 2));
    const c1 = add(door, scalePt(wallDir,  dw / 2));
    const c2 = add(c1, scalePt(inward, dw));
    const c3 = add(c0, scalePt(inward, dw));

    result.push([c0, c1, c2, c3]);
  }

  return result;
}


// ─── Wall analysis ───────────────────────────────────────────────────────────

interface WallCandidate {
  start: Point2D;
  end: Point2D;
  length: number;
  inwardNormal: Point2D;
}

function getWallCandidates(
  minWidth: number,
  edgePolygon: Point2D[],
  collisionPolygon: Point2D[],
  referenceWalls?: [Point2D, Point2D][],
): WallCandidate[] {
  const n = edgePolygon.length;
  const candidates: WallCandidate[] = [];

  for (let i = 0; i < n; i++) {
    const a = edgePolygon[i];
    const b = edgePolygon[(i + 1) % n];

    const dir = normalize(sub(b, a));
    const n1  = perpCCW(dir);
    const mid: Point2D    = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const testPt: Point2D = add(mid, scalePt(n1, 0.05));
    const inwardNormal    = pointInPolygon(testPt, collisionPolygon) ? n1 : scalePt(n1, -1);

    if (referenceWalls) {
      let onWall = false;
      for (const [w0, w1] of referenceWalls) {
        if (distToSeg(mid, w0, w1) < 0.02) { onWall = true; break; }
      }
      if (!onWall) continue;
    }

    const MAX_EXT_FRAC = 0.5;
    const physLen  = segmentLength(a, b);
    const canFwd   = pointInPolygon(add(b, scalePt(dir,  0.01)), collisionPolygon);
    const canBwd   = pointInPolygon(add(a, scalePt(dir, -0.01)), collisionPolygon);
    const tFwdRaw  = canFwd ? rayNearestWallHit(b, dir,              collisionPolygon, []) : 0;
    const tBwdRaw  = canBwd ? rayNearestWallHit(a, scalePt(dir, -1), collisionPolygon, []) : 0;
    const maxFwd   = Math.min(tFwdRaw, physLen * MAX_EXT_FRAC);
    const maxBwd   = Math.min(tBwdRaw, physLen * MAX_EXT_FRAC);

    let tFwd: number;
    let tBwd: number;
    if (physLen >= minWidth) {
      tFwd = 0;
      tBwd = 0;
    } else {
      const deficit = minWidth - physLen;
      tBwd = Math.min(deficit / 2, maxBwd);
      tFwd = Math.min(deficit / 2, maxFwd);
      let shortfall = deficit - tBwd - tFwd;
      if (shortfall > 0) {
        const extraBwd = Math.min(shortfall, maxBwd - tBwd);
        tBwd += extraBwd;
        shortfall -= extraBwd;
      }
      if (shortfall > 0) {
        const extraFwd = Math.min(shortfall, maxFwd - tFwd);
        tFwd += extraFwd;
        shortfall -= extraFwd;
      }
      if (shortfall > 1e-6) continue;
    }

    const extStart = tBwd > 0 ? add(a, scalePt(dir, -tBwd)) : a;
    const extEnd   = tFwd > 0 ? add(b, scalePt(dir,  tFwd)) : b;
    const extLen   = physLen + tFwd + tBwd;

    if (extLen < minWidth) continue;

    candidates.push({ start: extStart, end: extEnd, length: extLen, inwardNormal });
  }

  candidates.sort((a, b) => b.length - a.length);
  return candidates;
}

// ─── Source frame from furniture variant ─────────────────────────────────────

interface Frame2D {
  origin: Point2D;
  xAxis: Point2D;
  yAxis: Point2D;
}

function getSourceFrame(variant: FurnitureVariant): Frame2D {
  const lp = variant.linePlacement.points;
  const origin = lp[0] as Point2D;
  const xAxis = normalize(sub(lp[1] as Point2D, origin));

  const bboxPts = variant.bboxBig.points;
  const cx = bboxPts.reduce((s, p) => s + p[0], 0) / bboxPts.length;
  const cy = bboxPts.reduce((s, p) => s + p[1], 0) / bboxPts.length;
  const bboxCenter: Point2D = [cx, cy];

  const candidateY = perpCCW(xAxis);
  const toCenter = sub(bboxCenter, origin);
  const yAxis = dot(candidateY, toCenter) > 0 ? candidateY : scalePt(candidateY, -1);

  return { origin, xAxis, yAxis };
}

// ─── Furniture depth extraction ──────────────────────────────────────────────

function getFurnitureDepths(
  variant: FurnitureVariant,
  srcFrame: Frame2D,
): { depthBig: number; depthSmall: number } {
  const localY = (p: Point2D) => dot(sub(p, srcFrame.origin), srcFrame.yAxis);
  const depthBig   = Math.max(...variant.bboxBig.points.map(p   => localY(p as Point2D)));
  const depthSmall = Math.max(...variant.bboxSmall.points.map(p => localY(p as Point2D)));
  return { depthBig, depthSmall };
}

// ─── Usable-segment ray casting ──────────────────────────────────────────────

function rayExitsRoom(
  start: Point2D, dir: Point2D, depth: number, polygon: Point2D[],
  extra: [Point2D, Point2D][] = [],
): boolean {
  const end = add(start, scalePt(dir, depth));
  const n = polygon.length;
  for (let j = 0; j < n; j++) {
    if (segmentsIntersect(start, end, polygon[j], polygon[(j + 1) % n])) return true;
  }
  for (const [c, d] of extra) {
    if (segmentsIntersect(start, end, c, d)) return true;
  }
  return !pointInPolygon(end, polygon);
}

function findUsableSegment(
  wall: WallCandidate,
  depthBig: number,
  depthSmall: number,
  scMin: number,
  scMax: number,
  lpLen: number,
  bigPolygon: Point2D[],
  smallPolygon: Point2D[],
  doorObstacles: [Point2D, Point2D][],
  doorOpeningZones: [number, number][],
  subdivs = 40,
): [Point2D, Point2D] | null {
  const wallDir = normalize(sub(wall.end, wall.start));
  const EPSILON = 0.02;
  const step    = wall.length / subdivs;

  const bigOkArr:   boolean[] = [];
  const smallOkArr: boolean[] = [];

  for (let i = 0; i <= subdivs; i++) {
    const t  = (i / subdivs) * wall.length;
    const pt = add(wall.start, scalePt(wallDir, t));
    const rs = add(pt, scalePt(wall.inwardNormal, EPSILON));
    const bigOk = !rayExitsRoom(rs, wall.inwardNormal, Math.max(0, depthBig - EPSILON), bigPolygon);
    const inDoorOpening = doorOpeningZones.some(z => t >= z[0] && t <= z[1]);
    const smallOk = !inDoorOpening &&
      !rayExitsRoom(rs, wall.inwardNormal, Math.max(0, depthSmall - EPSILON), smallPolygon, doorObstacles);
    if (!bigOk || !smallOk) {
      console.log(
        `    [ray i=${i} t=${t.toFixed(2)}]` +
        `  pt=(${pt[0].toFixed(2)},${pt[1].toFixed(2)})` +
        `  bigOk=${bigOk}  smallOk=${smallOk}` +
        (inDoorOpening ? '  [door opening]' : ''),
      );
    }
    bigOkArr.push(bigOk);
    smallOkArr.push(smallOk);
  }

  const bigPfx:   number[] = new Array(subdivs + 2).fill(0);
  const smallPfx: number[] = new Array(subdivs + 2).fill(0);
  for (let i = 0; i <= subdivs; i++) {
    bigPfx[i + 1]   = bigPfx[i]   + (bigOkArr[i]   ? 1 : 0);
    smallPfx[i + 1] = smallPfx[i] + (smallOkArr[i] ? 1 : 0);
  }
  const allBig = (l: number, r: number): boolean => {
    const lo = Math.max(l, 0), hi = Math.min(r, subdivs);
    return lo > hi || bigPfx[hi + 1] - bigPfx[lo] === hi - lo + 1;
  };
  const allSmall = (l: number, r: number): boolean => {
    const lo = Math.max(l, 0), hi = Math.min(r, subdivs);
    return lo > hi || smallPfx[hi + 1] - smallPfx[lo] === hi - lo + 1;
  };

  const N_big    = Math.round(lpLen / step);
  const N_scMin  = Math.round(scMin / step);
  const N_scMax  = Math.round(scMax / step);

  let bestStart = -1, bestLen = 0;
  let runStart  = -1, runLen  = 0;
  for (let s = 0; s + N_big <= subdivs; s++) {
    const ok = allBig(s, s + N_big) && allSmall(s + N_scMin, s + N_scMax);
    if (ok) {
      if (runStart < 0) runStart = s;
      runLen++;
      if (runLen > bestLen) { bestLen = runLen; bestStart = runStart; }
    } else {
      runStart = -1; runLen = 0;
    }
  }

  if (bestStart < 0 || bestLen < 1) return null;

  const tRaw0 = (bestStart                 / subdivs) * wall.length;
  const tRaw1 = ((bestStart + bestLen - 1) / subdivs) * wall.length + lpLen;

  let t0: number;
  if (bestStart === 0) {
    t0 = 0;
  } else {
    let lo = ((bestStart - 1) / subdivs) * wall.length;
    let hi = tRaw0;
    const probeStart = (t: number): boolean => {
      const pt = add(wall.start, scalePt(wallDir, t + scMin));
      const rs = add(pt, scalePt(wall.inwardNormal, EPSILON));
      return !rayExitsRoom(rs, wall.inwardNormal, Math.max(0, depthSmall - EPSILON), smallPolygon, doorObstacles);
    };
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (probeStart(mid)) hi = mid; else lo = mid;
    }
    t0 = hi;
  }

  const t1 = tRaw1;

  return [
    add(wall.start, scalePt(wallDir, t0)),
    add(wall.start, scalePt(wallDir, Math.min(t1, wall.length))),
  ];
}

// ─── Transform ───────────────────────────────────────────────────────────────

function transformPoint(pt: Point2D, src: Frame2D, tgt: Frame2D): Point2D {
  const rel = sub(pt, src.origin);
  const u = dot(rel, src.xAxis);
  const v = dot(rel, src.yAxis);
  return [
    tgt.origin[0] + u * tgt.xAxis[0] + v * tgt.yAxis[0],
    tgt.origin[1] + u * tgt.xAxis[1] + v * tgt.yAxis[1],
  ];
}

// ─── Corner-guideline detection & mirroring ──────────────────────────────────

/** A variant is placed at a room corner when its guiding line is a corner
 *  (3+ points: arm-end → corner → arm-end) rather than a single wall segment. */
function isCornerVariant(variant: FurnitureVariant): boolean {
  return variant.linePlacement.points.length >= 3;
}

/**
 * Return the mirror of a variant — the *same* geometry placed against a
 * reversed guiding line, so the engine lays it out left-right flipped.
 *
 *   line variant   (A → B)        →  reversed guiding line (B → A)
 *   corner variant (A → C → B)    →  arms swapped (B → C → A)
 *
 * Only the guiding line is rewritten; bbox and geometry points are untouched,
 * because the placer derives the source frame (and thus the mirror) from the
 * guiding line. Mirrors of a symmetric variant reproduce the original placement
 * and are removed later by `dedupePlacements`.
 */
function mirrorVariant(variant: FurnitureVariant): FurnitureVariant {
  const pts = variant.linePlacement.points;
  let mirrored: Point2D[];
  if (pts.length >= 3) {
    // corner: swap the two arm endpoints, keep the corner (index 1) in place
    mirrored = [pts[2], pts[1], pts[0], ...pts.slice(3)] as Point2D[];
  } else {
    mirrored = [...pts].reverse() as Point2D[];
  }
  return { ...variant, linePlacement: { points: mirrored } };
}

/**
 * Straight-wall variant of a corner (L) piece: guiding line = the longer arm,
 * so placeLineVariant runs the counter's main arm along a single wall with the
 * short return arm turning inward. Lets an L-counter place against a plain wall
 * when no room corner fits it (rigidly) — the "fits along the other wall" case.
 */
function makeStraightVariant(variant: FurnitureVariant): FurnitureVariant {
  const pts = variant.linePlacement.points;
  if (pts.length < 3) return variant;
  const corner = pts[1] as Point2D;
  const a1 = pts[0] as Point2D, a2 = pts[2] as Point2D;
  const mainEnd = segmentLength(corner, a2) >= segmentLength(corner, a1) ? a2 : a1;
  return { ...variant, linePlacement: { points: [corner, mainEnd] } };
}

/** Footprint signature for de-duplication (cm precision, order-independent). */
function placementSignature(p: PlacedFurniture): string {
  return p.transformedSmallBbox
    .map((pt) => `${pt[0].toFixed(2)},${pt[1].toFixed(2)}`)
    .sort()
    .join("|");
}

/** Drop placements with an identical footprint, keeping the first seen. */
function dedupePlacements(options: PlacementOption[]): PlacementOption[] {
  const seen = new Set<string>();
  const out: PlacementOption[] = [];
  for (const opt of options) {
    const sig = placementSignature(opt.placed);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(opt);
  }
  return out;
}

/** True if all points lie inside `poly` after a 1 % inset toward their centroid. */
/**
 * True when rectangle/footprint `pts` lies inside `poly`.
 *
 * A furniture footprint sits flush against a wall, so its wall-side edge is
 * collinear with a room edge — a naive edge-intersection test would false-
 * positive on that. We therefore pull every corner a fixed 3 cm toward the
 * footprint centroid (lifting flush edges just off the boundary) and then
 * require BOTH: every inset corner is inside, AND no inset edge crosses a room
 * edge. The corner test alone (the old 1 %-inset version) missed footprints
 * that poke a few cm past a *slanted* wall — corners looked inside while the
 * body bulged out — which is exactly what produced furniture hanging outside
 * non-orthogonal rooms.
 */
function insetInside(pts: Point2D[], poly: Point2D[]): boolean {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const MARGIN = 0.03; // metres
  const inset = pts.map((p): Point2D => {
    const dx = cx - p[0], dy = cy - p[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) return [p[0], p[1]];
    const k = Math.min(MARGIN, l * 0.5) / l;
    return [p[0] + dx * k, p[1] + dy * k];
  });
  if (!inset.every((p) => pointInPolygon(p, poly))) return false;
  const m = inset.length;
  for (let i = 0; i < m; i++) {
    const a = inset[i], b = inset[(i + 1) % m];
    for (let j = 0; j < poly.length; j++) {
      if (segmentsIntersect(a, b, poly[j], poly[(j + 1) % poly.length])) return false;
    }
  }
  return true;
}

// ─── Generic corner placement (non-kitchen corner-guideline pieces) ───────────

/**
 * Place one corner-guideline variant (e.g. a bed whose head + side sit against
 * two perpendicular walls) at the room's corners. Unlike the kitchen counter,
 * the clearance is the variant's own bbox, so the check is simple containment:
 * the footprint (bboxSmall) must fit the edge polygon and the clearance zone
 * (bboxBig) must fit the collision polygon.
 */
function placeCornerVariant(
  room: Room,
  entry: FurnitureEntry,
  variant: FurnitureVariant,
  vi: number,
  opts: PlacementOptions,
): PlacementOption[] {
  const lp = variant.linePlacement.points;
  if (lp.length < 3) return [];

  const edgePoly      = opts.edgePolygon      ?? room.polygon;
  const collisionPoly = opts.collisionPolygon ?? room.polygon;
  const { polygon } = room;
  const n = polygon.length;
  const options: PlacementOption[] = [];

  const cornerSrc  = lp[1] as Point2D;
  const arm1EndSrc = lp[0] as Point2D;
  const arm2EndSrc = lp[2] as Point2D;
  const arm1Dir_src = normalize(sub(arm1EndSrc, cornerSrc));
  const arm2Dir_src = normalize(sub(arm2EndSrc, cornerSrc));
  const arm1Len = segmentLength(cornerSrc, arm1EndSrc);
  const arm2Len = segmentLength(cornerSrc, arm2EndSrc);

  // Orthonormal source frame: x along arm2, y the true perpendicular toward arm1.
  // (Using arm1 directly as y would shear the piece whenever the variant's own
  //  guiding arms aren't exactly perpendicular.)
  const srcYperp = perpCCW(arm2Dir_src);
  const srcFrame: Frame2D = {
    origin: cornerSrc,
    xAxis: arm2Dir_src,
    yAxis: dot(srcYperp, arm1Dir_src) >= 0 ? srcYperp : scalePt(srcYperp, -1),
  };

  for (let i = 0; i < n; i++) {
    const cornerPt = polygon[i];
    const prevPt   = polygon[(i - 1 + n) % n];
    const nextPt   = polygon[(i + 1) % n];

    const prevDir = normalize(sub(prevPt, cornerPt));
    const nextDir = normalize(sub(nextPt, cornerPt));
    const prevLen = segmentLength(cornerPt, prevPt);
    const nextLen = segmentLength(cornerPt, nextPt);

    // corner must be ~90°
    if (Math.abs(dot(prevDir, nextDir)) > 0.15) continue;

    // extend each arm along collinear continuation of the wall (same as kitchen)
    const nextCanFwd = pointInPolygon(add(nextPt, scalePt(nextDir, 0.01)), polygon);
    const prevCanFwd = pointInPolygon(add(prevPt, scalePt(prevDir, 0.01)), polygon);
    const nextTFwd   = nextCanFwd
      ? Math.min(rayNearestWallHit(nextPt, nextDir, polygon, [i, (i + 1) % n]), nextLen)
      : 0;
    const prevTFwd   = prevCanFwd
      ? Math.min(
          rayNearestWallHit(prevPt, prevDir, polygon, [(i - 1 + n) % n, (i - 2 + n) % n]),
          prevLen,
        )
      : 0;
    const arm1WallLen = nextLen + (nextTFwd < Infinity ? nextTFwd : 0);
    const arm2WallLen = prevLen + (prevTFwd < Infinity ? prevTFwd : 0);

    // arm1 maps to the "next" wall, arm2 to the "prev" wall (mirror handled by mirrorVariant)
    if (arm1WallLen < arm1Len - 1e-6 || arm2WallLen < arm2Len - 1e-6) continue;

    // Orthonormal target frame keeps the piece RIGID (a rectangle stays a
    // rectangle). x runs along the prev wall; y is the true inward perpendicular.
    // Because the corner is only accepted within ~8.6° of square (dot < 0.15),
    // the piece hugs the prev wall exactly and leaves at most a thin triangular
    // gap against the next wall — correct for rigid furniture, which cannot bend.
    const tgtYperp = perpCCW(prevDir);
    const tgtFrame: Frame2D = {
      origin: cornerPt,
      xAxis: prevDir,
      yAxis: dot(tgtYperp, nextDir) >= 0 ? tgtYperp : scalePt(tgtYperp, -1),
    };
    const tp = (p: Point2D) => transformPoint(p, srcFrame, tgtFrame);

    const transformedSmallBbox = variant.bboxSmall.points.map((p) => tp(p as Point2D));
    const transformedBbox      = variant.bboxBig.points.map((p)   => tp(p as Point2D));

    // footprint must avoid the door + previous footprints; clearance must fit the room
    if (!insetInside(transformedSmallBbox, edgePoly)) continue;
    if (!insetInside(transformedBbox, collisionPoly)) continue;

    const arm1EndPt = add(cornerPt, scalePt(nextDir, arm1Len));
    const arm2EndPt = add(cornerPt, scalePt(prevDir, arm2Len));

    options.push({
      variantIndex: vi,
      placed: {
        name: `${entry.furnitureName} — V${vi + 1}`,
        transformedGeometry: variant.geometry.map((geo) => ({
          closed: geo.closed,
          points: geo.points.map((p) => tp(p as Point2D)),
        })),
        transformedBbox,
        transformedSmallBbox,
        wallSegment: [arm1EndPt, arm2EndPt],
        smallCutout: transformedSmallBbox,
        largeCutout: transformedBbox,
      },
    });
  }

  return options;
}

// ─── Kitchen L-corner placement ──────────────────────────────────────────────

function placeKitchenVariant(
  room: Room,
  entry: FurnitureEntry,
  variant: FurnitureVariant,
  vi: number,
): PlacementOption[] {
  const dw = doorWidth(room.name);
  const doorObstacles = getDoorObstacleSegments(room, dw);
  const { polygon } = room;
  const n = polygon.length;
  const options: PlacementOption[] = [];

  const reducedLen = (cornerPt: Point2D, armDir: Point2D, fullLen: number): number => {
    const doors = room.doors ?? [];
    if (doors.length === 0) return fullLen;
    let result = fullLen;
    for (const door of doors) {
      const toDoor = sub(door, cornerPt);
      // Perpendicular tolerance must exceed the wall thickness: a door on this
      // wall has its centroid offset ~half the wall (~0.16 m) from the interior
      // face, plus the 0.4 m door-assignment slack. 0.35 m catches doors on the
      // arm's own wall while staying well clear of the opposite wall, so the
      // counter arm is always cut before a doorway (never overruns it).
      if (Math.abs(dot(toDoor, perpCCW(armDir))) >= 0.35) continue;
      const proj     = dot(toDoor, armDir);
      const gapStart = proj - dw / 2;
      if (gapStart <= 0) return 0;
      result = Math.min(result, gapStart);
    }
    return result;
  };

  const inwardOf = (cornerPt: Point2D, armDir: Point2D, len: number): Point2D => {
    const cand = perpCCW(armDir);
    const mid  = add(cornerPt, scalePt(armDir, len / 2));
    return pointInPolygon(add(mid, scalePt(cand, 0.05)), polygon) ? cand : scalePt(cand, -1);
  };

  const KITCHEN_DEPTH = 0.7;
  const EPSILON       = 0.02;
  const ARM_SUBDIVS   = 20;
  const armClear = (
    cornerPt: Point2D, armDir: Point2D, armLen: number, normal: Point2D,
  ): boolean => {
    for (let k = 0; k < ARM_SUBDIVS; k++) {
      const t  = ((k + 0.5) / ARM_SUBDIVS) * armLen;
      const pt = add(cornerPt, scalePt(armDir, t));
      const rs = add(pt, scalePt(normal, EPSILON));
      if (rayExitsRoom(rs, normal, KITCHEN_DEPTH - EPSILON, polygon, doorObstacles)) return false;
    }
    return true;
  };

  const lp = variant.linePlacement.points;
  if (lp.length < 3) return [];

  {
    const cornerSrc  = lp[1] as Point2D;
    const arm1EndSrc = lp[0] as Point2D;
    const arm2EndSrc = lp[2] as Point2D;

    const arm1Dir_src = normalize(sub(arm1EndSrc, cornerSrc));
    const arm2Dir_src = normalize(sub(arm2EndSrc, cornerSrc));
    const arm1Len = segmentLength(cornerSrc, arm1EndSrc);
    const arm2Len = segmentLength(cornerSrc, arm2EndSrc);

    const srcFrame: Frame2D = {
      origin: cornerSrc,
      xAxis:  arm2Dir_src,
      yAxis:  arm1Dir_src,
    };

    console.log(`[kitchen] V${vi + 1}  arm1Len=${arm1Len.toFixed(2)}  arm2Len=${arm2Len.toFixed(2)}`);

    for (let i = 0; i < n; i++) {
      const cornerPt = polygon[i];
      const prevPt   = polygon[(i - 1 + n) % n];
      const nextPt   = polygon[(i + 1) % n];

      const prevDir = normalize(sub(prevPt, cornerPt));
      const nextDir = normalize(sub(nextPt, cornerPt));
      const prevLen = segmentLength(cornerPt, prevPt);
      const nextLen = segmentLength(cornerPt, nextPt);

      if (Math.abs(dot(prevDir, nextDir)) > 0.15) continue;

      const nextCanFwd = pointInPolygon(add(nextPt, scalePt(nextDir, 0.01)), polygon);
      const prevCanFwd = pointInPolygon(add(prevPt, scalePt(prevDir, 0.01)), polygon);
      const nextTFwd   = nextCanFwd
        ? Math.min(rayNearestWallHit(nextPt, nextDir, polygon, [i, (i + 1) % n]), nextLen)
        : 0;
      const prevTFwd   = prevCanFwd
        ? Math.min(
            rayNearestWallHit(prevPt, prevDir, polygon, [(i - 1 + n) % n, (i - 2 + n) % n]),
            prevLen,
          )
        : 0;
      const nextExtLen = nextLen + (nextTFwd < Infinity ? nextTFwd : 0);
      const prevExtLen = prevLen + (prevTFwd < Infinity ? prevTFwd : 0);

      const arm1Dir     = nextDir;
      const arm1WallLen = nextExtLen;
      const arm2Dir     = prevDir;
      const arm2WallLen = prevExtLen;

      if (arm1WallLen < arm1Len || arm2WallLen < arm2Len) continue;

      if (reducedLen(cornerPt, arm1Dir, arm1WallLen) < arm1Len) {
        console.log(`  [kitchen] corner ${i} skip: arm1 crosses door gap`);
        continue;
      }
      if (reducedLen(cornerPt, arm2Dir, arm2WallLen) < arm2Len) {
        console.log(`  [kitchen] corner ${i} skip: arm2 crosses door gap`);
        continue;
      }

      const arm1Normal = inwardOf(cornerPt, arm1Dir, arm1Len);
      const arm2Normal = inwardOf(cornerPt, arm2Dir, arm2Len);
      if (!armClear(cornerPt, arm1Dir, arm1Len, arm1Normal)) {
        console.log(`  [kitchen] corner ${i} skip: arm1 depth ray blocked`);
        continue;
      }
      if (!armClear(cornerPt, arm2Dir, arm2Len, arm2Normal)) {
        console.log(`  [kitchen] corner ${i} skip: arm2 depth ray blocked`);
        continue;
      }

      const tgtFrame: Frame2D = {
        origin: cornerPt,
        xAxis:  arm2Dir,
        yAxis:  arm1Dir,
      };
      const tp = (p: Point2D) => transformPoint(p, srcFrame, tgtFrame);

      const transformedSmallBbox = variant.bboxSmall.points.map(p => tp(p as Point2D));
      const transformedBbox      = variant.bboxBig.points.map(p   => tp(p as Point2D));

      const arm1EndPt = add(cornerPt, scalePt(arm1Dir, arm1Len));
      const arm2EndPt = add(cornerPt, scalePt(arm2Dir, arm2Len));
      console.log(
        `  [kitchen] corner ${i} PLACED` +
        `  arm1=(${arm1Dir[0].toFixed(1)},${arm1Dir[1].toFixed(1)})` +
        `  arm2=(${arm2Dir[0].toFixed(1)},${arm2Dir[1].toFixed(1)})`,
      );

      const kD = KITCHEN_DEPTH;
      const smallCutout: Point2D[] = [
        arm2EndPt,
        cornerPt,
        arm1EndPt,
        add(arm1EndPt, scalePt(arm1Normal, kD)),
        [cornerPt[0] + arm1Normal[0] * kD + arm2Normal[0] * kD,
         cornerPt[1] + arm1Normal[1] * kD + arm2Normal[1] * kD],
        add(arm2EndPt, scalePt(arm2Normal, kD)),
      ];

      options.push({
        variantIndex: vi,
        placed: {
          name: `${entry.furnitureName} — V${vi + 1}`,
          transformedGeometry: variant.geometry.map(geo => ({
            closed: geo.closed,
            points: geo.points.map(p => tp(p as Point2D)),
          })),
          transformedBbox,
          transformedSmallBbox,
          wallSegment: [arm1EndPt, arm2EndPt],
          smallCutout,
          largeCutout: transformedBbox,
        },
      });
    }
  }

  return options;
}

// ─── Window-sensitive furniture ───────────────────────────────────────────────

const WINDOW_SENSITIVE_FURNITURE = new Set<string>(["Wardrobe"]);

function windowHalfWidth(roomName: string): number {
  return roomName === "Bathroom" || roomName === "WC" || roomName === "Kitchen" ? 0.5 : 0.75;
}

// ─── Wall-line placement (single-segment guideline pieces) ────────────────────

function placeLineVariant(
  room: Room,
  entry: FurnitureEntry,
  variant: FurnitureVariant,
  vi: number,
  opts: PlacementOptions,
): PlacementOption[] {
  const dw = doorWidth(room.name);
  const doorObstacles = getDoorObstacleSegments(room, dw);
  const windowSensitive = WINDOW_SENSITIVE_FURNITURE.has(entry.furnitureName);
  const windows = room.windows ?? [];
  const options: PlacementOption[] = [];

  const edgePoly      = opts.edgePolygon      ?? room.polygon;
  const collisionPoly = opts.collisionPolygon ?? room.polygon;

  {
    const lp = variant.linePlacement.points;
    const linePlacementLength = segmentLength(lp[0] as Point2D, lp[1] as Point2D);

    const srcFrame = getSourceFrame(variant);
    const { depthBig, depthSmall } = getFurnitureDepths(variant, srcFrame);
    const walls = getWallCandidates(linePlacementLength, edgePoly, collisionPoly, opts.referenceWalls);

    const srcDet = srcFrame.xAxis[0] * srcFrame.yAxis[1] - srcFrame.xAxis[1] * srcFrame.yAxis[0];
    const isFlipped = srcDet < 0;

    const localU = (p: Point2D) => dot(sub(p, srcFrame.origin), srcFrame.xAxis);
    const smallUs = variant.bboxSmall.points.map(p => localU(p as Point2D));
    const uMin = Math.min(...smallUs);
    const uMax = Math.max(...smallUs);
    const scMin = isFlipped ? linePlacementLength - uMax : uMin;
    const scMax = isFlipped ? linePlacementLength - uMin : uMax;

    console.log(
      `[placer] V${vi + 1}  lpLen=${linePlacementLength.toFixed(2)}` +
      `  depthBig=${depthBig.toFixed(2)}  depthSmall=${depthSmall.toFixed(2)}` +
      `  flipped=${isFlipped}  wallCandidates=${walls.length}`,
    );

    for (const wall of walls) {
      const wallLabel =
        `(${wall.start[0].toFixed(2)},${wall.start[1].toFixed(2)})→` +
        `(${wall.end[0].toFixed(2)},${wall.end[1].toFixed(2)}) len=${wall.length.toFixed(2)}`;

      const wallDir0 = normalize(sub(wall.end, wall.start));

      // Wardrobes must not be placed on walls that contain a window
      if (windowSensitive && windows.length > 0) {
        const wHalf = windowHalfWidth(room.name);
        const hasWindow = windows.some((win) => {
          const toWin    = sub(win, wall.start);
          const tProj    = dot(toWin, wallDir0);
          const perpDist = Math.abs(dot(toWin, perpCCW(wallDir0)));
          return perpDist < 0.15
            && tProj > -wHalf
            && tProj < wall.length + wHalf;
        });
        if (hasWindow) {
          console.log(`  [wall] ${wallLabel}  → window present, skip for ${entry.furnitureName}`);
          continue;
        }
      }

      const doorOpeningZones: [number, number][] = [];
      for (const door of room.doors ?? []) {
        const toDoor   = sub(door, wall.start);
        const tProj    = dot(toDoor, wallDir0);
        const perpDist = Math.abs(dot(toDoor, perpCCW(wallDir0)));
        if (perpDist < 0.15 && tProj > -dw / 2 && tProj < wall.length + dw / 2) {
          doorOpeningZones.push([Math.max(0, tProj - dw / 2), Math.min(wall.length, tProj + dw / 2)]);
        }
      }

      const usable = findUsableSegment(
        wall, depthBig, depthSmall, scMin, scMax, linePlacementLength,
        collisionPoly, edgePoly, doorObstacles, doorOpeningZones,
      );
      if (!usable) {
        console.log(`  [wall] ${wallLabel}  → no usable segment`);
        continue;
      }

      const [usableStart, usableEnd] = usable;
      const usableLen = segmentLength(usableStart, usableEnd);
      if (usableLen < linePlacementLength) {
        console.log(`  [wall] ${wallLabel}  → usableLen=${usableLen.toFixed(2)} < lpLen=${linePlacementLength.toFixed(2)}  SKIP`);
        continue;
      }
      console.log(`  [wall] ${wallLabel}  → usableLen=${usableLen.toFixed(2)}  OK`);

      const wallDir = normalize(sub(wall.end, wall.start));

      const flushEnd = usableLen - linePlacementLength;
      const offsets: number[] = [];
      if (usableLen >= 1.4 * linePlacementLength) {
        offsets.push((usableLen - linePlacementLength) / 2);
        offsets.push(0);
        offsets.push(flushEnd);
      } else {
        offsets.push(0);
        if (flushEnd > 1e-6) offsets.push(flushEnd);
      }

      for (const offset of offsets) {
        const wallOffset = isFlipped ? offset + linePlacementLength : offset;
        const targetOrigin: Point2D = add(usableStart, scalePt(wallDir, wallOffset));
        const tgtXAxis: Point2D = isFlipped ? scalePt(wallDir, -1) : wallDir;
        const tgtFrame: Frame2D = {
          origin: targetOrigin,
          xAxis: tgtXAxis,
          yAxis: wall.inwardNormal,
        };

        const tp = (p: Point2D) => transformPoint(p, srcFrame, tgtFrame);

        const transformedSmallBbox = variant.bboxSmall.points.map((p) => tp(p as Point2D));
        const transformedBbox      = variant.bboxBig.points.map((p)   => tp(p as Point2D));

        // Footprint must lie inside the room — corners AND edges (catches a
        // footprint bulging past a slanted wall between its corners).
        if (!insetInside(transformedSmallBbox, edgePoly)) continue;

        options.push({
          variantIndex: vi,
          placed: {
            name: `${entry.furnitureName} — V${vi + 1}`,
            transformedGeometry: variant.geometry.map((geo) => ({
              closed: geo.closed,
              points: geo.points.map((p) => tp(p as Point2D)),
            })),
            transformedBbox,
            transformedSmallBbox,
            wallSegment: [wall.start, wall.end],
            smallCutout: transformedSmallBbox,
            largeCutout: transformedBbox,
          },
        });
      }
    }
  }

  return options;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Enumerate all valid placements across all variants of the first piece.
 *
 * Each variant is routed by the shape of its guiding line:
 *   - a corner guideline (3+ points) → corner placement (kitchen counter for
 *     Kitchen pieces, generic bbox-fit corner placement for everything else);
 *   - a single segment → wall-line placement.
 *
 * For every variant we also try its mirror (the same piece against a reversed
 * guiding line). Mirrors are emitted under the same `variantIndex` as their
 * base, and base placements are enumerated first so that `dedupePlacements`
 * keeps the base when a mirror lands on the same footprint. Symmetric variants
 * therefore add no duplicates; asymmetric ones add their flipped option.
 */
export function getAllPlacements(
  room: Room,
  entry: FurnitureEntry,
  opts: PlacementOptions = {},
): PlacementOption[] {
  const piece = entry.pieces[0];
  if (!piece) return [];

  const isKitchen = entry.category === "Kitchen";

  // Kitchen counters BEND to follow their two walls (a fitted counter is not a
  // rigid block — it runs along whatever the walls do, including non-90° corners).
  // This places ~15 pp more kitchens than the rigid corner-or-straight fallback
  // and reads as a realistic counter. The rigid path (placeCornerVariant +
  // straight-wall run) is retained below for reference / non-kitchen corner pieces.
  const KITCHEN_BEND_ON_ANGLED_CORNERS = true;

  const placeOne = (variant: FurnitureVariant, vi: number): PlacementOption[] => {
    if (isCornerVariant(variant)) {
      if (isKitchen && KITCHEN_BEND_ON_ANGLED_CORNERS) {
        return placeKitchenVariant(room, entry, variant, vi);
      }
      // Rigid corner placement first; for kitchens, also allow the counter to
      // run along a single straight wall (corner-or-straight) so an L-counter
      // still places when no room corner fits it rigidly.
      const cornerOpts = placeCornerVariant(room, entry, variant, vi, opts);
      if (isKitchen) {
        const straightOpts = placeLineVariant(room, entry, makeStraightVariant(variant), vi, opts);
        return [...cornerOpts, ...straightOpts];
      }
      return cornerOpts;
    }
    return placeLineVariant(room, entry, variant, vi, opts);
  };

  const options: PlacementOption[] = [];
  // base variants first — these own the authoritative variantIndex
  for (let vi = 0; vi < piece.variants.length; vi++) {
    options.push(...placeOne(piece.variants[vi], vi));
  }
  // then mirrors — extra options under the same variantIndex, deduped against bases
  for (let vi = 0; vi < piece.variants.length; vi++) {
    options.push(...placeOne(mirrorVariant(piece.variants[vi]), vi));
  }

  return dedupePlacements(options);
}

/**
 * Place a specific variant so that `cornerSrcPt` (a point in the variant's
 * source-frame, e.g. one corner of bboxBig.points) ends up at `snapPoint`
 * on the wall defined by wallA→wallB with the given inward normal.
 * Used for manual drag-and-drop placement.
 */
export function placeVariantAtCorner(
  variant: FurnitureVariant,
  wallA: Point2D,
  wallB: Point2D,
  inwardNormal: Point2D,
  cornerSrcPt: Point2D,
  snapPoint: Point2D,
  furnitureName: string,
): PlacedFurniture {
  const srcFrame = getSourceFrame(variant);
  const wallDir = normalize(sub(wallB, wallA));

  const rel = sub(cornerSrcPt, srcFrame.origin);
  const u = dot(rel, srcFrame.xAxis);
  const v = dot(rel, srcFrame.yAxis);

  // solve: snapPoint = targetOrigin + u*wallDir + v*inwardNormal
  const targetOrigin: Point2D = [
    snapPoint[0] - u * wallDir[0] - v * inwardNormal[0],
    snapPoint[1] - u * wallDir[1] - v * inwardNormal[1],
  ];

  const tgtFrame: Frame2D = { origin: targetOrigin, xAxis: wallDir, yAxis: inwardNormal };
  const tp = (p: Point2D) => transformPoint(p, srcFrame, tgtFrame);

  const transformedSmallBbox = variant.bboxSmall.points.map(p => tp(p as Point2D));
  const transformedBbox      = variant.bboxBig.points.map(p   => tp(p as Point2D));

  return {
    name: furnitureName,
    transformedGeometry: variant.geometry.map(geo => ({
      closed: geo.closed,
      points: geo.points.map(p => tp(p as Point2D)),
    })),
    transformedBbox,
    transformedSmallBbox,
    wallSegment: [wallA, wallB],
    smallCutout: transformedSmallBbox,
    largeCutout: transformedBbox,
  };
}

/** Convenience: return the first valid placement, or null. */
export function placeFurniture(
  room: Room,
  entry: FurnitureEntry,
  opts: PlacementOptions = {},
): PlacedFurniture | null {
  return getAllPlacements(room, entry, opts)[0]?.placed ?? null;
}
