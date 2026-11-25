// ─── Open kitchens ───────────────────────────────────────────────────────────
//
// An open kitchen is a kitchen zone with no wall (and no door) towards the
// living room it belongs to. Rooms are furnished one at a time, so the engine
// cannot see that on its own: this module works it out from the whole
// apartment and records it on each room as `Room.openSegments` — the stretches
// of the room's boundary that are open. The kitchen step then keeps every
// counter module off those stretches (kitchenFlex.ts), and the living room
// keeps its wall-backed furniture off its own side of the opening.
//
// Which kitchens are open, in priority order:
//   1. an explicit flag from the caller (`open: true | false`);
//   2. the room's subtype / name: "Open kitchen" → open, "Kitchen" → closed;
//   3. geometry: the kitchen and a living room are closer than OPEN_TOUCH_TOL
//      along parallel, overlapping edges for at least OPEN_MIN_SHARED in total.
//      Touching only at a corner does not count. (Composer polygons have zero
//      wall thickness, so in that data every neighbour touches — which is why
//      the subtype wins over geometry. Rhino data leaves a ~10 cm gap wherever
//      there is a wall.)
// A kitchen flagged open that shares no such edge with a living room stays a
// closed kitchen; the caller gets a warning.
//
// Everything is endpoint-based and tolerance-matched — never vertex indices —
// so it survives polygon simplification, CCW normalisation and small
// coordinate perturbations.

import type { Point2D, RoomName } from "../layout/types";
import type { PlacedFurniture } from "./types";

export type OpenSegment = [Point2D, Point2D];

/** Two boundaries closer than this (metres) touch — there is no wall between them. */
export const OPEN_TOUCH_TOL = 0.01;
/** Shared boundary (metres, summed) needed before a kitchen counts as open. */
export const OPEN_MIN_SHARED = 0.6;
/** Pieces of shared boundary shorter than this are dropped as noise. */
const MIN_PIECE = 0.05;
/** |sin| of the angle between two edges for them to count as parallel. */
const PARALLEL_SIN = 0.02;
/** Perpendicular tolerance when matching a segment against an open piece. */
const LINE_TOL = 0.03;

// ─── Vector helpers ──────────────────────────────────────────────────────────

const sub = (a: Point2D, b: Point2D): Point2D => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Point2D, b: Point2D): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: Point2D, b: Point2D): number => a[0] * b[1] - a[1] * b[0];
const len = (v: Point2D): number => Math.hypot(v[0], v[1]);
const along = (p: Point2D, u: Point2D, t: number): Point2D => [p[0] + u[0] * t, p[1] + u[1] * t];

export function segmentLength(s: OpenSegment): number {
  return len(sub(s[1], s[0]));
}

// ─── Shared boundary ─────────────────────────────────────────────────────────

/**
 * The stretches of polygon `a`'s boundary that lie within `tol` of polygon
 * `b`'s boundary along parallel, overlapping edges. Each edge of `a` may give
 * several pieces (only part of a wall may be shared); touching pieces on one
 * edge are merged. Corner contact (zero-length overlap) gives nothing.
 */
export function sharedBoundary(a: Point2D[], b: Point2D[], tol = OPEN_TOUCH_TOL): OpenSegment[] {
  const out: OpenSegment[] = [];
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    const L = len(sub(q, p));
    if (L < 1e-9) continue;
    const u: Point2D = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
    const n: Point2D = [-u[1], u[0]];

    const intervals: [number, number][] = [];
    for (let j = 0; j < b.length; j++) {
      const c = b[j];
      const d = b[(j + 1) % b.length];
      const fl = len(sub(d, c));
      if (fl < 1e-9) continue;
      if (Math.abs(cross(u, sub(d, c))) / fl > PARALLEL_SIN) continue;
      const tc = dot(sub(c, p), u);
      const td = dot(sub(d, p), u);
      if (Math.abs(td - tc) < 1e-9) continue;
      const lo = Math.max(0, Math.min(tc, td));
      const hi = Math.min(L, Math.max(tc, td));
      if (hi - lo <= 1e-6) continue;
      // The other edge must be within tol of this one over the whole overlap.
      const offAt = (t: number) => {
        const s = (t - tc) / (td - tc);
        const pf: Point2D = [c[0] + (d[0] - c[0]) * s, c[1] + (d[1] - c[1]) * s];
        return Math.abs(dot(sub(pf, p), n));
      };
      if (offAt(lo) > tol || offAt(hi) > tol) continue;
      intervals.push([lo, hi]);
    }

    intervals.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    for (const [lo, hi] of merged) {
      if (hi - lo < MIN_PIECE) continue;
      out.push([along(p, u, lo), along(p, u, hi)]);
    }
  }
  return out;
}

/**
 * Carry boundary pieces found on one version of a polygon over to another
 * version of the same room (e.g. raw input → simplified, axis-snapped engine
 * polygon): each piece is projected onto every edge of `poly` that runs
 * parallel to it within `tol`, clipped to that edge, and merged per edge.
 */
export function projectOntoBoundary(segs: OpenSegment[], poly: Point2D[], tol = 0.15): OpenSegment[] {
  const out: OpenSegment[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const L = len(sub(q, p));
    if (L < 1e-9) continue;
    const u: Point2D = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
    const n: Point2D = [-u[1], u[0]];
    const intervals: [number, number][] = [];
    for (const [s0, s1] of segs) {
      const sl = len(sub(s1, s0));
      if (sl < 1e-9) continue;
      if (Math.abs(cross(u, sub(s1, s0))) / sl > 0.05) continue;
      if (Math.abs(dot(sub(s0, p), n)) > tol || Math.abs(dot(sub(s1, p), n)) > tol) continue;
      const t0 = dot(sub(s0, p), u);
      const t1 = dot(sub(s1, p), u);
      const lo = Math.max(0, Math.min(t0, t1));
      const hi = Math.min(L, Math.max(t0, t1));
      if (hi - lo > 1e-6) intervals.push([lo, hi]);
    }
    intervals.sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1e-4) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    for (const [lo, hi] of merged) {
      if (hi - lo < MIN_PIECE) continue;
      out.push([along(p, u, lo), along(p, u, hi)]);
    }
  }
  return out;
}

// ─── Detection ───────────────────────────────────────────────────────────────

/** True for a room name that means "open kitchen" ("Open kitchen", "open_kitchen", "2 Open Kitchen"). */
export function isOpenKitchenName(raw: string | null | undefined): boolean {
  const name = (raw ?? "").replace(/^\s*\d+[\s._-]*/, "").trim();
  return /^open[\s_-]*kitchen$/i.test(name);
}

/**
 * What the caller said about a kitchen: true = open, false = closed,
 * undefined = nothing said (the geometric rule decides). An explicit `open`
 * flag beats the subtype, which beats the room name.
 */
export function openKitchenHint(
  rawName: string | null | undefined,
  subtype?: string | null,
  open?: boolean | null,
): boolean | undefined {
  if (typeof open === "boolean") return open;
  const st = (subtype ?? "").trim().toLowerCase();
  if (st === "open kitchen") return true;
  if (st === "kitchen") return false;
  if (isOpenKitchenName(rawName)) return true;
  return undefined;
}

export interface OpenKitchenRoom {
  /** Canonical engine room name ("Kitchen", "Living room", …). */
  name: RoomName | string;
  /** The polygon the engine will furnish; openSegments are expressed on it. */
  polygon: Point2D[];
  /**
   * The polygon as the caller drew it, before simplification. When given,
   * touching is decided on these (neighbours that share an edge share it
   * exactly here, while simplification snaps each room on its own and can
   * pull shared edges a centimetre or two apart, e.g. on a slightly rotated
   * plan) and the result is projected onto `polygon`.
   */
  sourcePolygon?: Point2D[];
  /** See openKitchenHint; only read on kitchens. */
  hint?: boolean;
}

/** Explicitly open kitchens only: how far (metres) to look across a wall-thickness gap. */
export const OPEN_GAP_TOL = 0.3;

export interface OpenKitchenResult {
  /** True for a kitchen furnished as an open kitchen (modular placer only). */
  openKitchen: boolean;
  /** This room's side of every opening it has; empty for a fully walled room
   *  (and for an explicitly open kitchen whose opening could not be found). */
  openSegments: OpenSegment[];
  /** Distance (metres) across the opening between the two rooms' boundaries:
   *  0 when they touch, up to OPEN_GAP_TOL for a wall-thickness gap. */
  gap: number;
  /** Indices of the rooms on the other side of this room's openings. */
  openRooms: number[];
  warnings: string[];
}

function distPointSeg(p: Point2D, a: Point2D, b: Point2D): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return len(sub(p, along(a, ab, t)));
}

function distPointPoly(p: Point2D, poly: Point2D[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distPointSeg(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

/**
 * Decide which kitchens of one apartment are open and where the openings are.
 * Returns one result per input room, in order. `polygon` must be in the frame
 * the engine will use (after simplification / CCW normalisation).
 *
 * The geometric rule (no hint) only accepts touching boundaries. A kitchen
 * the caller says is open is open whatever the geometry: if nothing touches,
 * living-room edges up to OPEN_GAP_TOL away (a wall drawn with thickness) are
 * accepted; if there is still nothing, it is open with no located opening.
 */
export function detectOpenKitchens(rooms: OpenKitchenRoom[]): OpenKitchenResult[] {
  const res: OpenKitchenResult[] = rooms.map(() => ({
    openKitchen: false, openSegments: [], gap: 0, openRooms: [], warnings: [],
  }));
  const livingIdx = rooms.map((r, i) => (r.name === "Living room" ? i : -1)).filter((i) => i >= 0);

  const src = (r: OpenKitchenRoom) => r.sourcePolygon ?? r.polygon;
  const toEngine = (segs: OpenSegment[], r: OpenKitchenRoom) =>
    r.sourcePolygon ? projectOntoBoundary(segs, r.polygon) : segs;

  const find = (k: OpenKitchenRoom, tol: number) => {
    const touching: { li: number; kitchenSide: OpenSegment[] }[] = [];
    let total = 0;
    for (const li of livingIdx) {
      const kitchenSide = sharedBoundary(src(k), src(rooms[li]), tol);
      if (!kitchenSide.length) continue;
      touching.push({ li, kitchenSide });
      total += kitchenSide.reduce((s, seg) => s + segmentLength(seg), 0);
    }
    return { touching, total, tol };
  };

  rooms.forEach((k, ki) => {
    if (k.name !== "Kitchen" || k.hint === false) return;
    const explicit = k.hint === true;
    const openNoSegments = (why: string) => {
      res[ki].openKitchen = true;
      res[ki].warnings.push(`Open kitchen: ${why} — modular kitchen with every wall usable`);
    };

    let found = find(k, OPEN_TOUCH_TOL);
    if (found.total < OPEN_MIN_SHARED) {
      if (!explicit) return;
      found = find(k, OPEN_GAP_TOL);
      if (found.total < OPEN_MIN_SHARED) {
        openNoSegments(`no living room edge within ${OPEN_GAP_TOL} m along ≥ ${OPEN_MIN_SHARED} m`);
        return;
      }
    }

    const kitchenSegs = found.touching.flatMap(({ kitchenSide }) => toEngine(kitchenSide, k));
    if (!kitchenSegs.length) {
      if (explicit) openNoSegments("the opening could not be located on the simplified polygon");
      return;
    }

    let gap = 0;
    if (found.tol > OPEN_TOUCH_TOL) {
      gap = Infinity;
      for (const { li, kitchenSide } of found.touching) {
        for (const [a, b] of kitchenSide) {
          gap = Math.min(gap, distPointPoly([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], src(rooms[li])));
        }
      }
      res[ki].warnings.push(`Open kitchen: opening found across a ${(gap * 100).toFixed(0)} cm gap`);
    }

    res[ki].openKitchen = true;
    res[ki].gap = gap;
    res[ki].openSegments.push(...kitchenSegs);
    for (const { li } of found.touching) {
      res[li].openSegments.push(...toEngine(sharedBoundary(src(rooms[li]), src(k), found.tol), rooms[li]));
      res[li].gap = Math.max(res[li].gap, gap);
      res[li].openRooms.push(ki);
      res[ki].openRooms.push(li);
    }
  });

  return res;
}

/**
 * A door point on an opening is the caller's passage marker (the composer
 * puts one at the middle of an open-kitchen edge), not a door: no swing.
 * Returns the doors to keep and the ones that are passages.
 */
export function splitPassages(
  doors: Point2D[], segs: OpenSegment[], gap = 0,
): { doors: Point2D[]; passages: Point2D[] } {
  const tol = 0.05 + gap / 2;
  const out = { doors: [] as Point2D[], passages: [] as Point2D[] };
  for (const d of doors) {
    if (segs.some(([a, b]) => distPointSeg(d, a, b) <= tol)) out.passages.push(d);
    else out.doors.push(d);
  }
  return out;
}

// ─── Passage through an opening ──────────────────────────────────────────────

/**
 * Longest stretch of one opening segment left free by `obstacles`: an
 * obstacle within `reach` of the segment blocks its projection onto it.
 */
export function freePassage(segs: OpenSegment[], obstacles: Point2D[][], reach = 0.6): number {
  let best = 0;
  for (const [s0, s1] of segs) {
    const L = len(sub(s1, s0));
    if (L < 1e-9) continue;
    const u: Point2D = [(s1[0] - s0[0]) / L, (s1[1] - s0[1]) / L];
    const blocked: [number, number][] = [];
    for (const poly of obstacles) {
      if (!poly.length) continue;
      if (polySegDist(poly, s0, s1) >= reach) continue;
      const ts = poly.map((p) => dot(sub(p, s0), u));
      const lo = Math.max(0, Math.min(...ts));
      const hi = Math.min(L, Math.max(...ts));
      if (hi > lo) blocked.push([lo, hi]);
    }
    blocked.sort((x, y) => x[0] - y[0]);
    let cursor = 0;
    for (const [lo, hi] of blocked) {
      best = Math.max(best, lo - cursor);
      cursor = Math.max(cursor, hi);
    }
    best = Math.max(best, L - cursor);
  }
  return best;
}

/** Gap between a polygon and a segment (0 when they touch or cross). */
export function polySegDist(poly: Point2D[], a: Point2D, b: Point2D): number {
  let d = Infinity;
  for (const p of poly) d = Math.min(d, distPointSeg(p, a, b));
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    d = Math.min(d, distPointSeg(a, p, q), distPointSeg(b, p, q));
    if (segCross(a, b, p, q)) return 0;
  }
  return d;
}

function segCross(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const o = (p: Point2D, q: Point2D, r: Point2D) => cross(sub(q, p), sub(r, p));
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Gap between two convex polygons (0 when they overlap or touch). */
export function polyPolyDist(p: Point2D[], q: Point2D[]): number {
  if (convexOverlap(p, q, 0)) return 0;
  let d = Infinity;
  for (let i = 0; i < q.length; i++) d = Math.min(d, polySegDist(p, q[i], q[(i + 1) % q.length]));
  return d;
}

/** Separating-axis test for two convex polygons; overlap must exceed `eps`. */
export function convexOverlap(p: Point2D[], q: Point2D[], eps = 1e-3): boolean {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const e = sub(poly[(i + 1) % poly.length], poly[i]);
      const l = len(e);
      if (l < 1e-9) continue;
      const ax: Point2D = [-e[1] / l, e[0] / l];
      const pp = p.map((v) => dot(v, ax));
      const qq = q.map((v) => dot(v, ax));
      if (Math.max(...pp) <= Math.min(...qq) + eps || Math.max(...qq) <= Math.min(...pp) + eps) return false;
    }
  }
  return true;
}

// ─── Overlap tests used by the placers ───────────────────────────────────────

/**
 * Length along segment p→q that the segment s0→s1 covers, when s lies on the
 * line through p and q (both its ends within `tol`). 0 when it doesn't.
 */
export function collinearOverlap(p: Point2D, q: Point2D, s0: Point2D, s1: Point2D, tol = LINE_TOL): number {
  const L = len(sub(q, p));
  if (L < 1e-9) return 0;
  const u: Point2D = [(q[0] - p[0]) / L, (q[1] - p[1]) / L];
  const n: Point2D = [-u[1], u[0]];
  if (Math.abs(dot(sub(s0, p), n)) > tol || Math.abs(dot(sub(s1, p), n)) > tol) return 0;
  const t0 = dot(sub(s0, p), u);
  const t1 = dot(sub(s1, p), u);
  return Math.max(0, Math.min(L, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)));
}

/** Total length of p→q that lies on an open segment. */
export function openOverlap(p: Point2D, q: Point2D, segs: OpenSegment[]): number {
  let s = 0;
  for (const [a, b] of segs) s += collinearOverlap(p, q, a, b);
  return s;
}

/**
 * True when a wall-placed piece backs onto an opening: the side of its
 * footprint that sits against its wall overlaps an open segment by more than
 * `minOverlap`. The backing side is read off the footprint itself (the corners
 * within 0.1 m of the wall line), not the wall candidate, which may be longer.
 */
export function backsOntoOpening(placed: PlacedFurniture, segs: OpenSegment[], minOverlap = 0.1): boolean {
  if (!segs.length) return false;
  const [w0, w1] = placed.wallSegment;
  const L = len(sub(w1, w0));
  if (L < 1e-9) return false;
  const u: Point2D = [(w1[0] - w0[0]) / L, (w1[1] - w0[1]) / L];
  const n: Point2D = [-u[1], u[0]];
  const ts = (placed.transformedSmallBbox as Point2D[])
    .filter((p) => Math.abs(dot(sub(p, w0), n)) < 0.1)
    .map((p) => dot(sub(p, w0), u));
  if (ts.length < 2) return false;
  const back0 = along(w0, u, Math.min(...ts));
  const back1 = along(w0, u, Math.max(...ts));
  return openOverlap(back0, back1, segs) > minOverlap;
}
