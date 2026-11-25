// ─── Flexible kitchen placement ───────────────────────────────────────────────
//
// The library route places a kitchen as ONE rigid preset block (a 2.40 m strip,
// a 2.40 × 1.80 L, …) picked by apartment type. It fits a plain rectangular
// room and gives up on anything funkier.
//
// This module builds the same kitchen out of individual 0.60 × 0.60 modules laid
// along the room's own walls, so the counter follows whatever shape the room has.
// The module count is taken from the presets it replaces (see MODULE_COUNT), the
// run may turn one inner corner (L-shape), and fridge / sink / hob are assigned
// to modules by kitchen-ergonomics rules rather than being frozen into the
// preset geometry.
//
// Output is a normal PlacementOption, byte-compatible with the library route, so
// the pipeline, subtraction chain, scorer and app renderer need no special case.
//
// ─── Ergonomics ──────────────────────────────────────────────────────────────
// Rules encoded below follow the NKBA Kitchen Planning Guidelines (the standard
// reference for the work triangle), reduced to a 0.6 m module grid:
//
//   • Work triangle fridge→sink→hob: each leg 1.2–2.7 m, perimeter ≤ 7.9 m.
//     In a single-wall kitchen the triangle degenerates to a line — that is
//     expected, so short legs are penalised, never rejected.
//   • Workflow order along the run is fridge → sink → hob (unload, wash, cook),
//     i.e. the sink sits between the other two.
//   • Landing space: counter next to the sink (≥ 1 module each side is ideal)
//     and on BOTH sides of the hob. The hob therefore never sits at the end of a
//     run, and never in the blind corner.
//   • The hob is kept away from the fridge (heat) — at least two modules apart —
//     and away from windows (curtains over a flame).
//   • The sink prefers a window; the fridge prefers a run end near the door.
//
// The one deliberate departure from NKBA: the work aisle in front of the counter
// is 0.60 m (CLEARANCE below) because that is the transition zone this engine
// works with everywhere. NKBA asks for 1.07 m in a one-cook kitchen — with 0.60
// a layout that passes here is not automatically NKBA-compliant.

import type { Point2D, Room } from "../layout/types";
import type { PlacementOption, PlacementOptions } from "./types";
import { pointInPolygon, insetInside, doorWidth } from "./placer";
import { openOverlap, freePassage, type OpenSegment } from "./openKitchen";

// ─── Dimensions ──────────────────────────────────────────────────────────────

/** Side of one kitchen module — also the counter depth. */
export const MODULE = 0.6;
/** Transition zone kept clear in front of every (non-blind) module. */
export const CLEARANCE = 0.6;
/** A kitchen below this many modules is not worth calling a kitchen. */
const MIN_MODULES = 4;

/**
 * Modules per apartment type, read off the presets this replaces:
 *   type 1 → 0.60 × 2.40 strip                     = 4
 *   type 2 → 0.60 × 3.60 strip / 2.40 × 1.80 L     = 6
 *   type 3 → same as type 2                        = 6
 *   type 4 → 0.60 × 4.80 strip / 2.40 × 3.00 L     = 8
 */
export function kitchenModuleCount(aptType: number): number {
  if (aptType <= 1) return 4;
  if (aptType <= 3) return 6;
  return 8;
}

/** Plain counter wanted beside fridge, sink and hob: 1.8 m of worktop to
 *  prepare food on. The 4-module studio preset left 0.6 m (or nothing usable
 *  once an L's blind corner took a module). */
export const WORKTOP_MODULES = 3;

/**
 * Usable (non-blind) modules a kitchen aims for: the preset count of its
 * apartment type, but never fewer than the three appliances plus
 * WORKTOP_MODULES. A blind corner module comes on top. Smaller kitchens are
 * still made when this does not fit (down to MIN_MODULES).
 */
export function kitchenUsableTarget(aptType: number): number {
  return Math.max(kitchenModuleCount(aptType), 3 + WORKTOP_MODULES);
}

const usableModules = (run: { modules: { blind: boolean }[] }): number =>
  run.modules.reduce((k, m) => k + (m.blind ? 0 : 1), 0);

// ─── Vector helpers ──────────────────────────────────────────────────────────

const sub = (a: Point2D, b: Point2D): Point2D => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point2D, b: Point2D): Point2D => [a[0] + b[0], a[1] + b[1]];
const mul = (v: Point2D, s: number): Point2D => [v[0] * s, v[1] * s];
const dot = (a: Point2D, b: Point2D): number => a[0] * b[0] + a[1] * b[1];
const len = (v: Point2D): number => Math.hypot(v[0], v[1]);
const dist = (a: Point2D, b: Point2D): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const norm = (v: Point2D): Point2D => { const l = len(v); return l < 1e-12 ? [0, 0] : [v[0] / l, v[1] / l]; };
const perp = (v: Point2D): Point2D => [-v[1], v[0]];

/** p + u·along + v·into — the local frame every module is drawn in. */
function at(base: Point2D, along: Point2D, into: Point2D, u: number, v: number): Point2D {
  return [base[0] + along[0] * u + into[0] * v, base[1] + along[1] * u + into[1] * v];
}

/**
 * Where the two legs' offset lines meet, `depth` in from both walls — the mitre
 * of the counter's inner edge as it turns the corner.
 *
 * Offsetting each leg by `depth·normal` and intersecting gives
 * `depth·(nA + nB) / (1 + nA·nB)`; the naive `depth·nA + depth·nB` is only that
 * point at exactly 90°, and on a slanted wall it lands too far into the room —
 * which tilts the whole inner edge instead of keeping it parallel to the wall.
 */
function mitre(corner: Point2D, nA: Point2D, nB: Point2D, depth: number): Point2D {
  const k = 1 + dot(nA, nB);
  if (k < 0.2) return add(corner, mul(nA, depth)); // near-fold: no usable mitre
  return add(corner, mul(add(nA, nB), depth / k));
}

/** Drop points that repeat their predecessor — a right-angle corner cell collapses. */
function dedupe(pts: Point2D[]): Point2D[] {
  return pts.filter((p, i) => {
    const q = pts[(i - 1 + pts.length) % pts.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6;
  });
}

// ─── Modules ─────────────────────────────────────────────────────────────────

type Appliance = "fridge" | "sink" | "hob" | "counter";

export interface Module {
  /** Wall-side corner the module is measured from. */
  base: Point2D;
  along: Point2D;
  into: Point2D;
  center: Point2D;
  footprint: Point2D[];
  /** Free floor in front. Empty for the blind corner module. */
  clearance: Point2D[];
  /** True for the module in an L's inner corner: its front is covered by the
   *  other leg, so it gets no transition zone and no appliance. */
  blind: boolean;
  atWindow: boolean;
  doorDist: number;
}

function makeModule(base: Point2D, along: Point2D, into: Point2D, blind: boolean, room: Room): Module {
  const footprint = [
    base,
    at(base, along, into, MODULE, 0),
    at(base, along, into, MODULE, MODULE),
    at(base, along, into, 0, MODULE),
  ];
  const clearance = blind ? [] : [
    at(base, along, into, 0, MODULE),
    at(base, along, into, MODULE, MODULE),
    at(base, along, into, MODULE, MODULE + CLEARANCE),
    at(base, along, into, 0, MODULE + CLEARANCE),
  ];
  const center = at(base, along, into, MODULE / 2, MODULE / 2);
  // A window "belongs" to the module when it sits on the module's own wall
  // (within the counter depth) and within half a module of its centre.
  const wallPt = at(base, along, into, MODULE / 2, 0);
  const atWindow = (room.windows ?? []).some((w) => {
    const rel = sub(w, wallPt);
    return Math.abs(dot(rel, into)) < MODULE && Math.abs(dot(rel, along)) < MODULE * 0.75;
  });
  const doorDist = (room.doors ?? []).reduce((m, d) => Math.min(m, dist(center, d)), Infinity);
  return { base, along, into, center, footprint, clearance, blind, atWindow, doorDist };
}

// ─── Run geometry ────────────────────────────────────────────────────────────

export interface Run {
  /** Modules in path order — walking the counter from one open end to the other. */
  modules: Module[];
  /** L-shaped runs carry their corner; straight runs don't. */
  corner: {
    point: Point2D;
    /** Leg directions out of the corner, with each leg's inward normal. */
    aDir: Point2D; aNormal: Point2D; aLen: number;
    bDir: Point2D; bNormal: Point2D; bLen: number;
  } | null;
  /** Straight runs carry their end points instead. A galley carries its first
   *  strip here and its second strip in `galley`. */
  straight: { start: Point2D; end: Point2D; into: Point2D } | null;
  /** Galley (open kitchens only): the second strip, facing the first across
   *  the aisle. modules[0…split) are strip one, modules[split…) strip two. */
  galley?: { start: Point2D; end: Point2D; into: Point2D; split: number } | null;
  /** 0…1 — how much of the required transition zone is actually free floor. */
  clearanceRatio: number;
  /** The wall(s) the run stands on, with the stretch it covers (t0…t1 from a,
   *  in metres). Straight runs: one; L runs: leg A then leg B, each measured
   *  from the corner. Used to rank open kitchens (slivers at run ends). */
  walls: { a: Point2D; b: Point2D; t0: number; t1: number }[];
}

/** Modules of one leg running out of `origin` along `dir`, module 0 at the origin. */
function legModules(
  origin: Point2D, dir: Point2D, into: Point2D, count: number, blindFirst: boolean, room: Room,
): Module[] {
  const mods: Module[] = [];
  for (let k = 0; k < count; k++) {
    mods.push(makeModule(add(origin, mul(dir, k * MODULE)), dir, into, blindFirst && k === 0, room));
  }
  return mods;
}

// ─── Validity ────────────────────────────────────────────────────────────────

/** Fraction of the clearance rectangle that is real floor, sampled on a 3 × 3 grid. */
function clearanceCoverage(m: Module, poly: Point2D[]): number {
  if (m.blind) return 1;
  let inside = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const u = ((i + 0.5) / 3) * MODULE;
      const v = MODULE + ((j + 0.5) / 3) * CLEARANCE;
      if (pointInPolygon(at(m.base, m.along, m.into, u, v), poly)) inside++;
    }
  }
  return inside / 9;
}

/**
 * Reject the run unless every footprint sits on real floor, then report how much
 * of the transition zone survives. `edgePoly` is the room minus door swings, so
 * the footprint test also keeps the counter out of the doorway.
 */
function validateRun(modules: Module[], edgePoly: Point2D[], collisionPoly: Point2D[]): number | null {
  let total = 0;
  for (const m of modules) {
    if (!insetInside(m.footprint, edgePoly)) return null;
    if (collisionPoly !== edgePoly && !insetInside(m.footprint, collisionPoly)) return null;
    total += clearanceCoverage(m, collisionPoly);
  }
  return total / modules.length;
}

/** Backing overlap (metres) above which a module counts as standing on an opening. */
const OPEN_BACKING_TOL = 0.02;
/** Free width (metres) of the opening that must stay a passage. */
export const OPEN_PASSAGE = 0.9;
/** Minimum aisle between the two counter fronts of a galley. */
const GALLEY_AISLE = 1.2;

/**
 * Open-kitchen rules for one run (see getFlexibleKitchenPlacements):
 *   • no module's back — the full 0.6 m backing side, and both walls of an L's
 *     blind corner — may lie on an open segment;
 *   • every transition zone lies wholly on the kitchen's own floor.
 */
function openRunOk(
  modules: Module[],
  corner: { c: Point2D; aDir: Point2D; bDir: Point2D } | null,
  collisionPoly: Point2D[],
  openSegs: OpenSegment[],
): boolean {
  const backs: [Point2D, Point2D][] = modules.map((m) => [m.base, add(m.base, mul(m.along, MODULE))]);
  if (corner) {
    backs.push([corner.c, add(corner.c, mul(corner.aDir, MODULE))]);
    backs.push([corner.c, add(corner.c, mul(corner.bDir, MODULE))]);
  }
  for (const [p, q] of backs) {
    if (openOverlap(p, q, openSegs) > OPEN_BACKING_TOL) return false;
  }
  for (const m of modules) {
    if (!m.blind && !insetInside(m.clearance, collisionPoly)) return false;
  }
  return true;
}

/** The opening keeps a free passage of OPEN_PASSAGE (or all of it, if shorter). */
export function passageOk(openSegs: OpenSegment[], footprints: Point2D[][]): boolean {
  if (!openSegs.length) return true;
  const longest = Math.max(...openSegs.map(([a, b]) => dist(a, b)));
  return freePassage(openSegs, footprints) >= Math.min(OPEN_PASSAGE, longest) - 1e-6;
}

// ─── Run enumeration ─────────────────────────────────────────────────────────

/** Inward normal of the wall segment a→b. */
function inwardNormal(a: Point2D, b: Point2D, poly: Point2D[]): Point2D {
  const d = norm(sub(b, a));
  const n = perp(d);
  const mid: Point2D = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return pointInPolygon(add(mid, mul(n, 0.05)), poly) ? n : mul(n, -1);
}

/** Distances along the wall where a run may start, so runs also butt up to doorways. */
function runAnchors(room: Room, a: Point2D, b: Point2D, wallLen: number, runLen: number): number[] {
  const slack = wallLen - runLen;
  if (slack < -1e-9) return [];
  const dir = norm(sub(b, a));
  const dw = doorWidth(room.name);
  const raw = [0, slack, slack / 2];
  for (const door of room.doors ?? []) {
    const rel = sub(door, a);
    if (Math.abs(dot(rel, perp(dir))) > 0.35) continue;
    const t = dot(rel, dir);
    raw.push(t + dw / 2);          // run starts just past the doorway
    raw.push(t - dw / 2 - runLen); // run ends just before it
  }
  // Open kitchens: a wall may be open in part — let runs butt up to the
  // opening from either side, so its closed stretch is usable.
  for (const [s0, s1] of room.openSegments ?? []) {
    if (Math.abs(dot(sub(s0, a), perp(dir))) > 0.03 || Math.abs(dot(sub(s1, a), perp(dir))) > 0.03) continue;
    const t0 = Math.min(dot(sub(s0, a), dir), dot(sub(s1, a), dir));
    const t1 = Math.max(dot(sub(s0, a), dir), dot(sub(s1, a), dir));
    raw.push(t1);          // run starts just past the opening
    raw.push(t0 - runLen); // run ends just before it
  }
  const out: number[] = [];
  for (const v of raw) {
    const c = Math.min(Math.max(v, 0), slack);
    if (!out.some((o) => Math.abs(o - c) < 0.05)) out.push(c);
  }
  return out;
}

/**
 * One L run out of its two legs (module 0 of each at the corner). legB[0]
 * covers the same corner as legA[0] — keep one module for the two, shaped as
 * the cell both legs actually leave free: bounded by the two walls, the two
 * legs' first cut lines, and the mitre between them. At 90° that hexagon
 * collapses to the plain 0.6 × 0.6 square; on a slanted wall it fills the
 * wedge instead of leaving a notch between the legs. Path order: out along
 * leg A, through the corner, out along leg B.
 */
function joinLegs(
  legA: Module[], legB: Module[], c: Point2D,
  aDir: Point2D, aNormal: Point2D, bDir: Point2D, bNormal: Point2D,
): Module[] {
  legA[0].footprint = dedupe([
    at(c, aDir, aNormal, MODULE, 0),
    c,
    at(c, bDir, bNormal, MODULE, 0),
    at(c, bDir, bNormal, MODULE, MODULE),
    mitre(c, aNormal, bNormal, MODULE),
    at(c, aDir, aNormal, MODULE, MODULE),
  ]);
  legA[0].center = [
    legA[0].footprint.reduce((s, p) => s + p[0], 0) / legA[0].footprint.length,
    legA[0].footprint.reduce((s, p) => s + p[1], 0) / legA[0].footprint.length,
  ];
  return [...legA.slice(1).reverse(), legA[0], ...legB.slice(1)];
}

/** Exported for tests. */
export function enumerateRuns(room: Room, count: number, opts: PlacementOptions): Run[] {
  const poly = room.polygon;
  const n = poly.length;
  const edgePoly = opts.edgePolygon ?? poly;
  const collisionPoly = opts.collisionPolygon ?? poly;
  const runs: Run[] = [];
  const runLen = count * MODULE;
  const openSegs = room.openSegments ?? [];
  const open = !!room.openKitchen || openSegs.length > 0;
  const openOk = (mods: Module[], corner: { c: Point2D; aDir: Point2D; bDir: Point2D } | null) =>
    openRunOk(mods, corner, collisionPoly, openSegs) && passageOk(openSegs, mods.map((m) => m.footprint));

  // ── Straight runs: one wall, anchored flush / centred / beside a doorway ──
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const wallLen = dist(a, b);
    if (wallLen < runLen - 1e-9) continue;
    const dir = norm(sub(b, a));
    const into = inwardNormal(a, b, poly);
    for (const anchor of runAnchors(room, a, b, wallLen, runLen)) {
      const start = add(a, mul(dir, anchor));
      const modules = legModules(start, dir, into, count, false, room);
      const ratio = validateRun(modules, edgePoly, collisionPoly);
      if (ratio === null) continue;
      if (open && !openOk(modules, null)) continue;
      runs.push({
        modules,
        corner: null,
        straight: { start, end: add(start, mul(dir, runLen)), into },
        clearanceRatio: ratio,
        walls: [{ a, b, t0: anchor, t1: anchor + runLen }],
      });
    }
  }

  // ── L runs: two legs meeting in an inner corner, sharing the corner module ──
  for (let i = 0; i < n; i++) {
    const c = poly[i];
    const prev = poly[(i - 1 + n) % n];
    const next = poly[(i + 1) % n];
    const aDir = norm(sub(prev, c));
    const bDir = norm(sub(next, c));
    // Roughly square: 70°–110°. Now that the corner cell and the inner edge are
    // both mitred, an off-square corner is exact rather than approximate, so a
    // slanted wall is a usable corner instead of a rejected one.
    if (Math.abs(dot(aDir, bDir)) > 0.34) continue;
    if (!pointInPolygon(at(c, aDir, bDir, 0.3, 0.3), poly)) continue; // not an inner corner

    const aNormal = inwardNormal(c, prev, poly);
    const bNormal = inwardNormal(c, next, poly);
    // Each leg's counter must lean into the other leg — true for a square inner
    // corner, false for the reflex/odd cases the tests above let slip through.
    if (dot(aNormal, bDir) < 0.9 || dot(bNormal, aDir) < 0.9) continue;

    const aWall = dist(c, prev);
    const bWall = dist(c, next);
    for (let aCount = 2; aCount <= count - 1; aCount++) {
      const bCount = count + 1 - aCount;
      if (bCount < 2) continue;
      if (aCount * MODULE > aWall + 1e-9 || bCount * MODULE > bWall + 1e-9) continue;

      const legA = legModules(c, aDir, aNormal, aCount, true, room);
      const legB = legModules(c, bDir, bNormal, bCount, true, room);
      const modules = joinLegs(legA, legB, c, aDir, aNormal, bDir, bNormal);
      const ratio = validateRun(modules, edgePoly, collisionPoly);
      if (ratio === null) continue;
      if (open && !openOk(modules, { c, aDir, bDir })) continue;
      runs.push({
        modules,
        corner: {
          point: c,
          aDir, aNormal, aLen: aCount * MODULE,
          bDir, bNormal, bLen: bCount * MODULE,
        },
        straight: null,
        clearanceRatio: ratio,
        walls: [
          { a: c, b: prev, t0: 0, t1: aCount * MODULE },
          { a: c, b: next, t0: 0, t1: bCount * MODULE },
        ],
      });
    }
  }

  if (open) runs.push(...enumerateGalleys(room, count, edgePoly, collisionPoly, openSegs));

  return runs;
}

/**
 * Galley (open kitchens only): two straight strips on two opposite, parallel
 * walls whose counters face each other across an aisle ≥ GALLEY_AISLE. The
 * module count is split over the strips, each ≥ 2 modules.
 */
function enumerateGalleys(
  room: Room, count: number, edgePoly: Point2D[], collisionPoly: Point2D[], openSegs: OpenSegment[],
): Run[] {
  const poly = room.polygon;
  const n = poly.length;
  const runs: Run[] = [];
  type Strip = { modules: Module[]; start: Point2D; end: Point2D; into: Point2D; t0: number; ratio: number };
  const cache = new Map<string, Strip[]>();
  const strips = (i: number, c: number): Strip[] => {
    const key = `${i}:${c}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const a = poly[i], b = poly[(i + 1) % n];
    const wallLen = dist(a, b), len = c * MODULE;
    const dir = norm(sub(b, a));
    const into = inwardNormal(a, b, poly);
    const out: Strip[] = [];
    if (wallLen >= len - 1e-9) {
      for (const t0 of runAnchors(room, a, b, wallLen, len)) {
        const start = add(a, mul(dir, t0));
        const modules = legModules(start, dir, into, c, false, room);
        const ratio = validateRun(modules, edgePoly, collisionPoly);
        if (ratio === null || !openRunOk(modules, null, collisionPoly, openSegs)) continue;
        out.push({ modules, start, end: add(start, mul(dir, len)), into, t0, ratio });
      }
    }
    cache.set(key, out);
    return out;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const c = poly[j], d = poly[(j + 1) % n];
      const intoA = inwardNormal(a, b, poly);
      const intoB = inwardNormal(c, d, poly);
      if (dot(intoA, intoB) > -0.95) continue;
      const gap = dot(sub(c, a), intoA);
      if (gap < 2 * MODULE + GALLEY_AISLE - 1e-6) continue;
      const dirA = norm(sub(b, a));
      for (let cA = 2; cA <= count - 2; cA++) {
        const cB = count - cA;
        for (const sa of strips(i, cA)) {
          for (const sb of strips(j, cB)) {
            // Facing: the strips overlap by at least a module along the aisle.
            const tb0 = dot(sub(sb.start, a), dirA), tb1 = dot(sub(sb.end, a), dirA);
            const ov = Math.min(sa.t0 + cA * MODULE, Math.max(tb0, tb1)) - Math.max(sa.t0, Math.min(tb0, tb1));
            if (ov < MODULE - 1e-6) continue;
            // A galley reads as one kitchen when its strips line up at one end.
            const aligned = Math.abs(sa.t0 - Math.min(tb0, tb1)) < 0.05
              || Math.abs(sa.t0 + cA * MODULE - Math.max(tb0, tb1)) < 0.05;
            if (!aligned) continue;
            // Nothing (a wall jog) between them.
            const mid: Point2D = [
              (sa.modules[0].center[0] + sb.modules[0].center[0]) / 2,
              (sa.modules[0].center[1] + sb.modules[0].center[1]) / 2,
            ];
            if (!pointInPolygon(mid, collisionPoly)) continue;
            const modules = [...sa.modules, ...sb.modules];
            if (!passageOk(openSegs, modules.map((m) => m.footprint))) continue;
            runs.push({
              modules,
              corner: null,
              straight: { start: sa.start, end: sa.end, into: sa.into },
              galley: { start: sb.start, end: sb.end, into: sb.into, split: cA },
              clearanceRatio: Math.min(sa.ratio, sb.ratio),
              walls: [
                { a, b, t0: sa.t0, t1: sa.t0 + cA * MODULE },
                { a: c, b: d, t0: dot(sub(sb.start, c), norm(sub(d, c))), t1: dot(sub(sb.start, c), norm(sub(d, c))) + cB * MODULE },
              ],
            });
          }
        }
      }
    }
  }
  return runs;
}

// ─── Appliance assignment ────────────────────────────────────────────────────

export interface Assignment {
  fridge: number;
  sink: number;
  hob: number;
  score: number;
}

/** NKBA work-triangle leg: full marks inside 1.2–2.7 m, tapering off outside. */
function legScore(d: number): number {
  if (d >= 1.2 && d <= 2.7) return 1;
  if (d < 1.2) return d / 1.2;             // single-wall kitchens live here
  return Math.max(0, 1 - (d - 2.7) / 2.0);
}

/**
 * Pick the fridge / sink / hob modules for one run. Returns the best-scoring
 * legal assignment, or null when the run cannot hold all three appliances.
 */
export function assignAppliances(modules: Module[]): Assignment | null {
  const n = modules.length;
  const usable: number[] = [];
  for (let i = 0; i < n; i++) if (!modules[i].blind) usable.push(i);
  if (usable.length < 3) return null;

  let best: Assignment | null = null;

  for (const fridge of usable) {
    for (const sink of usable) {
      if (sink === fridge) continue;
      for (const hob of usable) {
        if (hob === fridge || hob === sink) continue;
        // The hob needs landing space on both sides, so never at a run end.
        if (hob === 0 || hob === n - 1) continue;
        // Heat: keep the fridge at least one module clear of the hob.
        if (Math.abs(hob - fridge) < 2) continue;

        let s = 0;
        // Workflow: fridge → sink → hob along the counter.
        if ((sink > fridge && sink < hob) || (sink < fridge && sink > hob)) s += 3;

        const dFS = dist(modules[fridge].center, modules[sink].center);
        const dSH = dist(modules[sink].center, modules[hob].center);
        const dHF = dist(modules[hob].center, modules[fridge].center);
        s += 1.5 * (legScore(dFS) + legScore(dSH) + legScore(dHF));
        if (dFS + dSH + dHF > 7.9) s -= 2;

        if (modules[sink].atWindow) s += 1.2;
        if (modules[hob].atWindow) s -= 2;
        // Fridge: at a run end, near the door, so groceries don't cross the room.
        if (fridge === 0 || fridge === n - 1) s += 0.8;
        if (Number.isFinite(modules[fridge].doorDist)) {
          s += 0.6 * Math.max(0, 1 - modules[fridge].doorDist / 4);
        }
        // Landing space: plain counter next to the sink and either side of the hob.
        const isCounter = (i: number) => i >= 0 && i < n && i !== fridge && i !== sink && i !== hob;
        if (isCounter(sink - 1)) s += 0.3;
        if (isCounter(sink + 1)) s += 0.3;
        if (isCounter(hob - 1)) s += 0.3;
        if (isCounter(hob + 1)) s += 0.3;
        // A blind corner between two appliances breaks the work sequence.
        for (let i = Math.min(fridge, sink, hob); i <= Math.max(fridge, sink, hob); i++) {
          if (modules[i].blind) s -= 0.5;
        }

        if (!best || s > best.score) best = { fridge, sink, hob, score: s };
      }
    }
  }
  return best;
}

/**
 * Galley: sink and hob share one strip (hob off the strip's ends, landing
 * space beside both); the fridge takes an end of either strip. Across the
 * aisle the work triangle is a real triangle, so the same NKBA leg scoring
 * applies; the "sink between" workflow rule becomes "sink nearer the fridge
 * than the hob" when the fridge is on the other strip.
 */
export function assignGalley(modules: Module[], split: number): Assignment | null {
  const n = modules.length;
  const ends = [...new Set([0, split - 1, split, n - 1])];
  let best: Assignment | null = null;
  for (const [s0, s1] of [[0, split], [split, n]]) {
    if (s1 - s0 < 3) continue;
    for (let sink = s0; sink < s1; sink++) {
      for (let hob = s0 + 1; hob < s1 - 1; hob++) {
        if (hob === sink) continue;
        for (const fridge of ends) {
          if (fridge === sink || fridge === hob) continue;
          const same = fridge >= s0 && fridge < s1;
          if (same && Math.abs(hob - fridge) < 2) continue;
          const dFS = dist(modules[fridge].center, modules[sink].center);
          const dSH = dist(modules[sink].center, modules[hob].center);
          const dHF = dist(modules[hob].center, modules[fridge].center);
          let s = 0;
          if (same ? (sink - fridge) * (sink - hob) < 0 : dFS <= dHF) s += 3;
          s += 1.5 * (legScore(dFS) + legScore(dSH) + legScore(dHF));
          if (dFS + dSH + dHF > 7.9) s -= 2;
          if (modules[sink].atWindow) s += 1.2;
          if (modules[hob].atWindow) s -= 2;
          s += 0.8; // the fridge is always at a strip end
          if (Number.isFinite(modules[fridge].doorDist)) {
            s += 0.6 * Math.max(0, 1 - modules[fridge].doorDist / 4);
          }
          const isCounter = (i: number) => i >= s0 && i < s1 && i !== fridge && i !== sink && i !== hob;
          if (isCounter(sink - 1)) s += 0.3;
          if (isCounter(sink + 1)) s += 0.3;
          if (isCounter(hob - 1)) s += 0.3;
          if (isCounter(hob + 1)) s += 0.3;
          if (!best || s > best.score) best = { fridge, sink, hob, score: s };
        }
      }
    }
  }
  return best;
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

type Geo = { closed: boolean; points: Point2D[] };

/** Rectangle in module-local coordinates (u along the wall, v into the room). */
function localRect(m: Module, u0: number, v0: number, u1: number, v1: number): Geo {
  return {
    closed: true,
    points: [
      at(m.base, m.along, m.into, u0, v0),
      at(m.base, m.along, m.into, u1, v0),
      at(m.base, m.along, m.into, u1, v1),
      at(m.base, m.along, m.into, u0, v1),
    ],
  };
}

function drawModule(m: Module, kind: Appliance): Geo[] {
  const p = (u: number, v: number) => at(m.base, m.along, m.into, u, v);
  const geo: Geo[] = [{ closed: true, points: m.footprint }];

  if (kind === "sink") {
    geo.push(localRect(m, 0.09, 0.12, 0.51, 0.52));    // bowl
    geo.push({ closed: false, points: [p(0.24, 0.07), p(0.36, 0.07)] }); // tap
  } else if (kind === "hob") {
    const burner = (cu: number, cv: number) => localRect(m, cu - 0.08, cv - 0.08, cu + 0.08, cv + 0.08);
    geo.push(burner(0.18, 0.18), burner(0.42, 0.18), burner(0.18, 0.42), burner(0.42, 0.42));
  } else if (kind === "fridge") {
    geo.push(localRect(m, 0.05, 0.05, 0.55, 0.55));    // door panel
    geo.push({ closed: false, points: [p(0.05, 0.05), p(0.55, 0.55)] });
    geo.push({ closed: false, points: [p(0.55, 0.05), p(0.05, 0.55)] });
    geo.push({ closed: false, points: [p(0.47, 0.20), p(0.47, 0.40)] }); // handle
  }
  return geo;
}

/** Footprint (depth = MODULE) or clearance envelope (depth = MODULE + CLEARANCE). */
function runOutline(run: Run, depth: number): Point2D[] {
  if (run.straight && run.galley) {
    // Two strips as one ring: strip one, a zero-width slit across the aisle,
    // strip two, and back along the slit. Area and drawing match the two
    // rectangles; the wire format has room for only one polygon.
    // The slit joins the two closest back corners, so it runs along a wall.
    const s = run.straight, g = run.galley;
    const ringB = [g.start, g.end, add(g.end, mul(g.into, depth)), add(g.start, mul(g.into, depth))];
    const ringA = [s.start, s.end, add(s.end, mul(s.into, depth)), add(s.start, mul(s.into, depth))];
    let ia = 0, ib = 0, best = Infinity;
    for (const i of [0, 1]) for (const j of [0, 1]) {
      const d = dist(ringA[i], ringB[j]);
      if (d < best) { best = d; ia = i; ib = j; }
    }
    const rot = (r: Point2D[], k: number) => [...r.slice(k), ...r.slice(0, k)];
    const a = rot(ringA, ia), b = rot(ringB, ib);
    return [...a, a[0], ...b, b[0]];
  }
  if (run.straight) {
    const { start, end, into } = run.straight;
    return [start, end, add(end, mul(into, depth)), add(start, mul(into, depth))];
  }
  const c = run.corner!;
  const aEnd = add(c.point, mul(c.aDir, c.aLen));
  const bEnd = add(c.point, mul(c.bDir, c.bLen));
  // The band between the counter's back polyline and its inward offset, mitred
  // where the legs meet so the inner edge stays parallel to each wall.
  return dedupe([
    bEnd,
    c.point,
    aEnd,
    add(aEnd, mul(c.aNormal, depth)),
    mitre(c.point, c.aNormal, c.bNormal, depth),
    add(bEnd, mul(c.bNormal, depth)),
  ]);
}

// ─── Public API ──────────────────────────────────────────────────────────────

interface ScoredRun {
  run: Run;
  assignment: Assignment;
  score: number;
}

function signature(run: Run): string {
  return run.modules.map((m) => `${m.center[0].toFixed(2)},${m.center[1].toFixed(2)}`).join(";");
}

/** Order-free footprint signature: the same counter walked the other way is one run. */
function footprintSignature(run: Run): string {
  return run.modules.map((m) => `${m.center[0].toFixed(2)},${m.center[1].toFixed(2)}`).sort().join(";");
}

// ─── Open-kitchen ranking ────────────────────────────────────────────────────
//
// In an open kitchen the counter should read as the back of the kitchen seen
// from the living room, not as a screen across it. Module count comes first
// (the step-down search only drops a module when nothing fits); among layouts
// with the same count, strongest first:
//   I on the back wall (opposite and parallel to the opening) › I on a side
//   wall › I on any other closed wall › L › II (galley).
// The tier bonuses are far apart so a tier is never overturned by appliance
// scoring; within a tier, layouts lose points for crowding the opening and for
// leaving a useless sliver of wall at a run end.

const TIER_BACK = 30;
const TIER_SIDE = 20;
const TIER_OTHER = 10;
const TIER_GALLEY = -10;
/** A counter closer than this to the opening narrows it. */
const MOUTH_CLEAR = 0.6;
/** A wall stub shorter than this at a run end is wasted. */
const SLIVER = 0.3;

function distPointSeg(p: Point2D, a: Point2D, b: Point2D): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, mul(ab, t)));
}

/** Gap between a polygon and a segment (both convex here; touching = 0). */
function distPolySeg(poly: Point2D[], a: Point2D, b: Point2D): number {
  let d = Infinity;
  for (const p of poly) d = Math.min(d, distPointSeg(p, a, b));
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    d = Math.min(d, distPointSeg(a, p, q), distPointSeg(b, p, q));
  }
  return d;
}

/** Outward direction (kitchen → living room) of the longest opening. */
function openingOutward(poly: Point2D[], segs: OpenSegment[]): Point2D | null {
  const groups: { dir: Point2D; total: number }[] = [];
  for (const [s0, s1] of segs) {
    const l = dist(s0, s1);
    if (l < 1e-9) continue;
    const inward = inwardNormal(s0, s1, poly);
    const out = mul(inward, -1);
    const g = groups.find((x) => dot(x.dir, out) > 0.9);
    if (g) g.total += l;
    else groups.push({ dir: out, total: l });
  }
  groups.sort((x, y) => y.total - x.total);
  return groups[0]?.dir ?? null;
}

/** Wall stub left beside each end of the stretch t0…t1 of wall a→b. */
function endGaps(room: Room, w: Run["walls"][number]): number[] {
  const L = dist(w.a, w.b);
  const dir = norm(sub(w.b, w.a));
  const nrm = perp(dir);
  const stops = [0, L];
  for (const [s0, s1] of room.openSegments ?? []) {
    if (Math.abs(dot(sub(s0, w.a), nrm)) > 0.03 || Math.abs(dot(sub(s1, w.a), nrm)) > 0.03) continue;
    stops.push(dot(sub(s0, w.a), dir), dot(sub(s1, w.a), dir));
  }
  const dw = doorWidth(room.name);
  for (const door of room.doors ?? []) {
    if (Math.abs(dot(sub(door, w.a), nrm)) > 0.35) continue;
    const t = dot(sub(door, w.a), dir);
    stops.push(t - dw / 2, t + dw / 2);
  }
  const before = Math.min(...stops.filter((s) => s <= w.t0 + 1e-6).map((s) => w.t0 - s));
  const after = Math.min(...stops.filter((s) => s >= w.t1 - 1e-6).map((s) => s - w.t1));
  return [before, after];
}

function openKitchenBonus(run: Run, room: Room, outward: Point2D | null): number {
  const segs = room.openSegments ?? [];
  let s = 0;
  if (run.galley) {
    s += TIER_GALLEY;
  } else if (run.straight) {
    const d = outward ? dot(run.straight.into, outward) : 0;
    s += d > 0.9 ? TIER_BACK : Math.abs(d) < 0.3 ? TIER_SIDE : TIER_OTHER;
  }
  // Crowding the opening: counter within MOUTH_CLEAR of it, worst module counts.
  let foot = Infinity;
  let zone = Infinity;
  for (const m of run.modules) {
    for (const [a, b] of segs) {
      foot = Math.min(foot, distPolySeg(m.footprint, a, b));
      if (!m.blind) zone = Math.min(zone, distPolySeg(m.clearance, a, b));
    }
  }
  if (foot < MOUTH_CLEAR) s -= 3 * (1 - foot / MOUTH_CLEAR);
  if (zone < 0.05) s -= 0.5;
  // Slivers: a stub of wall 1 cm – 0.3 m long beside a run end.
  for (const w of run.walls) {
    for (const g of endGaps(room, w)) if (g > 0.01 && g < SLIVER) s -= 1.5;
  }
  return s;
}

/**
 * Open kitchens: a layout whose strips sit on the same walls with the same
 * module counts, each nudged less than SLIVER along its wall, is the same
 * kitchen, not another option (anchors flush / centred / beside an opening
 * often land a few cm apart). Keeps the best-ranked of each such group;
 * `scored` must already be sorted best first.
 */
function dropNudgedRuns(scored: ScoredRun[]): ScoredRun[] {
  const kept: ScoredRun[] = [];
  const twins = (x: Run, y: Run) =>
    !!x.corner === !!y.corner && !!x.galley === !!y.galley
    && x.walls.length === y.walls.length
    && x.walls.every((w, i) => {
      const v = y.walls[i];
      return dist(w.a, v.a) < 1e-6 && dist(w.b, v.b) < 1e-6
        && Math.abs((w.t1 - w.t0) - (v.t1 - v.t0)) < 1e-6
        && Math.abs(w.t0 - v.t0) < SLIVER;
    });
  for (const s of scored) {
    if (!kept.some((k) => twins(k.run, s.run))) kept.push(s);
  }
  return kept;
}

/**
 * Every worthwhile way to lay a modular kitchen into `room`, best first.
 *
 * Tries the full module count for the apartment type, dropping one module at a
 * time down to MIN_MODULES — a 5-module kitchen beats no kitchen. The first
 * count that fits wins. If nothing fits with its transition zones on real floor,
 * the search runs again accepting partial clearance, so a tight room still gets
 * a kitchen (with a lower score, and the zones visibly clipped).
 *
 * Open kitchens (`room.openKitchen` or `room.openSegments` non-empty) follow
 * stricter rules: no module backs onto an opening and at least OPEN_PASSAGE of
 * the opening stays free of counters (enumerateRuns), transition zones must lie
 * wholly on the kitchen's floor (no partial-clearance retry), only I, L and
 * galley (II) layouts on real walls are made, and runs are ranked by
 * openKitchenBonus — I on the back wall › I on a side wall › L › II. May
 * return [] (an honest failure: open kitchens never fall back to presets).
 * Every module stays inside the kitchen: a kitchen whose walls hold fewer
 * modules than its target gets the most that fit, never worktop past the
 * opening.
 */
export function getFlexibleKitchenPlacements(
  room: Room,
  aptType: number,
  furnitureName: string,
  opts: PlacementOptions = {},
  maxOptions = 24,
): PlacementOption[] {
  const target = kitchenUsableTarget(aptType);
  const segs = room.openSegments ?? [];
  const open = !!room.openKitchen || segs.length > 0;
  const outward = segs.length ? openingOutward(room.polygon, segs) : null;

  let scored: ScoredRun[] = [];
  // Sizes are counted in usable modules (a blind corner is no worktop), up to
  // `target`; the run may carry one blind corner on top. Closed: keep only the
  // largest size that fits. Open: also keep the layouts one module shorter, as
  // lower-ranked alternatives (size always ranks first).
  let best = 0;
  const floor = () => (open ? best - 1 : best);
  for (const minRatio of open ? [0.999] : [0.999, 0.5]) {
    for (let count = target + 1; count >= MIN_MODULES; count--) {
      if (best > 0 && count < floor()) break;
      const seen = new Set<string>();
      for (const run of enumerateRuns(room, count, opts)) {
        if (run.clearanceRatio < minRatio) continue;
        const usable = usableModules(run);
        if (usable > target) continue;
        const sig = open ? footprintSignature(run) : signature(run);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const assignment = run.galley
          ? assignGalley(run.modules, run.galley.split)
          : assignAppliances(run.modules);
        if (!assignment) continue;
        const score = open
          ? assignment.score
            + 1.2 * usable
            - 2.0 * (target - usable)
            + openKitchenBonus(run, room, outward)
          : assignment.score
            + 1.2 * usable                             // more counter is better
            - 2.0 * (target - usable)                  // …but falling short of the target hurts
            + (run.corner ? 0.5 : 0)                   // an L works better than one long wall
            + 3.0 * run.clearanceRatio;
        scored.push({ run, assignment, score });
        best = Math.max(best, usable);
      }
    }
    if (scored.length) break;
  }
  scored = scored.filter((s) => usableModules(s.run) >= floor());

  if (open) {
    scored.sort((a, b) => usableModules(b.run) - usableModules(a.run) || b.score - a.score);
    scored = dropNudgedRuns(scored);
  } else {
    scored.sort((a, b) => b.score - a.score);
  }
  scored = scored.slice(0, maxOptions);

  return scored.map(({ run, assignment }) => {
    const kinds: Appliance[] = run.modules.map((_, i) =>
      i === assignment.fridge ? "fridge" :
      i === assignment.sink   ? "sink"   :
      i === assignment.hob    ? "hob"    : "counter",
    );
    const footprint = runOutline(run, MODULE);
    const envelope  = runOutline(run, MODULE + CLEARANCE);
    const shape = run.galley ? "galley" : run.corner ? "L" : "straight";
    const ends: [Point2D, Point2D] = run.straight
      ? [run.straight.start, run.straight.end]
      : [add(run.corner!.point, mul(run.corner!.aDir, run.corner!.aLen)), run.corner!.point];

    return {
      // One synthetic variant: these runs are generated, not library variants, so
      // the app's variant pills would point at geometry that doesn't exist.
      variantIndex: 0,
      placed: {
        name: `${furnitureName} — ${shape}, ${run.modules.length} modules`,
        transformedGeometry: run.modules.flatMap((m, i) => drawModule(m, kinds[i])),
        transformedBbox: envelope,
        transformedSmallBbox: footprint,
        wallSegment: ends,
        smallCutout: footprint,
        largeCutout: envelope,
        ...(open ? {
          modules: run.modules.map((m) => ({ footprint: m.footprint, clearance: m.clearance })),
        } : {}),
      },
    };
  });
}
