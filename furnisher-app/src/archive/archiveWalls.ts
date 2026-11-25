// Walls of a composer plan drawn with thickness.
//
// In the Building Composer the Furnisher runs on zero-thickness room outlines (each room's own cells on the
// 0.625 m grid); walls exist only in drawings, where the studio canvas strokes them as 1 px lines
// (`planWalls`, composerDraw.ts). Here every wall run of `planWalls` is given a body centred on its grid line:
// EXTERIOR (a side with no room on one side: the apartment outline) 0.30 m, INTERIOR 0.10 m. Open runs (open
// kitchen sides, room lines) get no body (drawn dashed by the canvas). Door openings (at their drawn width) and
// windows are cut out of the united surface.
//
// `insetRooms` gives the optional "furnish inside wall thickness" polygons: each room polygon minus the uncut wall
// surface, i.e. pulled in by half the drawn thickness on walled sides (0.05 m interior, 0.15 m on the outline) and
// left as is on open sides. That is NOT what the composer sends.

import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import { inRings, drawnDoors } from "./composerDraw";
import type { Placed, PlanWalls, Seg, XY, DoorMark } from "./composerDraw";

export const EXTERIOR_T = 0.3;
export const INTERIOR_T = 0.1;
export const WINDOW_DRAWN_M = 1.25;

const EPS = 1e-6;
const GRID = 1e-5;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const ring = (pts: XY[]): Ring => pts.map(([x, y]) => [snap(x), snap(y)] as [number, number]);

export type WallBody = { kind: "exterior" | "interior"; seg: Seg };
export type ThickWalls = {
  /** wall surface with door and window openings cut out: polygons [outer, ...holes] */
  surface: XY[][][];
  /** the uncut surface (for the inset) */
  uncut: MultiPolygon;
  bodies: WallBody[];
  doors: DoorMark[];
  windows: { a: XY; b: XY; inward: XY; t: number }[];
};

function onSeg(p: XY, s: Seg): boolean {
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const L2 = dx * dx + dy * dy;
  if (L2 < EPS) return false;
  const t = ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / L2;
  if (t < -1e-6 || t > 1 + 1e-6) return false;
  return Math.hypot(p[0] - (s.a[0] + t * dx), p[1] - (s.a[1] + t * dy)) < 1e-4;
}

function rect(a: XY, b: XY, half: number, extA: number, extB: number): XY[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const t: XY = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  const n: XY = [-t[1], t[0]];
  const A: XY = [a[0] - t[0] * extA, a[1] - t[1] * extA];
  const B: XY = [b[0] + t[0] * extB, b[1] + t[1] * extB];
  return [
    [A[0] + n[0] * half, A[1] + n[1] * half],
    [B[0] + n[0] * half, B[1] + n[1] * half],
    [B[0] - n[0] * half, B[1] - n[1] * half],
    [A[0] - n[0] * half, A[1] - n[1] * half],
  ];
}

/** Classify the pieces of every wall run (exterior where one side holds no room) and merge them back into runs. */
export function wallBodies(d: Placed, w: PlanWalls): WallBody[] {
  const G = d.grid_m || 0.625;
  const allRings = d.rooms.flatMap((r) => r.rings);
  const free = new Set((d.free_walls ?? []).map(([a, b]) => `${a}|${b}`));
  const out: WallBody[] = [];
  for (const s of w.walls) {
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    if (L < EPS) continue;
    if (free.has(`${s.a}|${s.b}`)) {
      out.push({ kind: "interior", seg: s });
      continue;
    }
    const t: XY = [(s.b[0] - s.a[0]) / L, (s.b[1] - s.a[1]) / L];
    const n: XY = [-t[1], t[0]];
    const k = Math.max(1, Math.round(L / G));
    let cur: { kind: WallBody["kind"]; lo: number } | null = null;
    const flush = (hi: number) => {
      if (!cur) return;
      out.push({ kind: cur.kind, seg: { a: [s.a[0] + t[0] * cur.lo, s.a[1] + t[1] * cur.lo], b: [s.a[0] + t[0] * hi, s.a[1] + t[1] * hi] } });
    };
    for (let i = 0; i < k; i++) {
      const lo = (L * i) / k;
      const mid = (L * (i + 0.5)) / k;
      const m: XY = [s.a[0] + t[0] * mid, s.a[1] + t[1] * mid];
      const left = inRings([m[0] + n[0] * 0.05, m[1] + n[1] * 0.05], allRings);
      const right = inRings([m[0] - n[0] * 0.05, m[1] - n[1] * 0.05], allRings);
      const kind: WallBody["kind"] = left && right ? "interior" : "exterior";
      if (!cur || cur.kind !== kind) {
        flush(lo);
        cur = { kind, lo };
      }
    }
    flush(L);
  }
  return out;
}

export function thickWalls(d: Placed, w: PlanWalls, windowPoints: XY[], facade: XY[][]): ThickWalls {
  const bodies = wallBodies(d, w);
  const segs = bodies.map((b) => b.seg);
  const polys: MultiPolygon[] = [];
  bodies.forEach((body, i) => {
    const half = (body.kind === "exterior" ? EXTERIOR_T : INTERIOR_T) / 2;
    const touches = (p: XY) => segs.some((s, j) => j !== i && onSeg(p, s));
    const ext = (p: XY) => (touches(p) ? half : 0);
    polys.push([[ring(rect(body.seg.a, body.seg.b, half, ext(body.seg.a), ext(body.seg.b)))]]);
  });
  let uncut: MultiPolygon = [];
  try {
    uncut = polys.length ? polygonClipping.union(polys[0], ...polys.slice(1)) : [];
  } catch {
    uncut = polys.flat();
  }

  const doors = drawnDoors(d);
  const cutters: MultiPolygon[] = doors.map((dr) => [[ring(rect(dr.a, dr.b, EXTERIOR_T, 0, 0))]]);
  const allRings = d.rooms.flatMap((r) => r.rings);
  const windows: ThickWalls["windows"] = [];
  for (const p of windowPoints) {
    const run = facade.find(([a, b]) => onSeg(p, { a, b }));
    const L = run ? Math.hypot(run[1][0] - run[0][0], run[1][1] - run[0][1]) : WINDOW_DRAWN_M;
    const ww = Math.min(WINDOW_DRAWN_M, L - 0.1);
    const dir: XY = run ? [(run[1][0] - run[0][0]) / L, (run[1][1] - run[0][1]) / L] : [1, 0];
    let n: XY = [-dir[1], dir[0]];
    if (!inRings([p[0] + n[0] * 0.05, p[1] + n[1] * 0.05], allRings)) n = [-n[0], -n[1]];
    const a: XY = [p[0] - (dir[0] * ww) / 2, p[1] - (dir[1] * ww) / 2];
    const b: XY = [p[0] + (dir[0] * ww) / 2, p[1] + (dir[1] * ww) / 2];
    windows.push({ a, b, inward: n, t: EXTERIOR_T });
    cutters.push([[ring(rect(a, b, EXTERIOR_T, 0, 0))]]);
  }
  let surface: MultiPolygon = uncut;
  if (cutters.length && uncut.length) {
    try {
      surface = polygonClipping.difference(uncut, ...cutters);
    } catch {
      surface = uncut;
    }
  }
  const toXY = (mp: MultiPolygon): XY[][][] => mp.map((poly) => poly.map((r) => (r as [number, number][]).map(([x, y]) => [x, y] as XY)));
  return { surface: toXY(surface), uncut, bodies, doors, windows };
}

function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** A room polygon pulled in by the drawn wall bodies (the largest piece left, its outer ring, closing vertex dropped);
 *  the polygon itself when the difference fails or leaves nothing. */
export function insetPolygon(polygon: XY[], uncut: MultiPolygon): XY[] {
  if (!uncut.length) return polygon;
  try {
    const diff = polygonClipping.difference([ring(polygon)], uncut);
    if (!diff.length) return polygon;
    let best = diff[0][0] as [number, number][];
    for (const poly of diff) if (ringArea(poly[0] as [number, number][]) > ringArea(best)) best = poly[0] as [number, number][];
    const pts = best.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as XY);
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    return pts.length >= 3 ? pts : polygon;
  } catch {
    return polygon;
  }
}
