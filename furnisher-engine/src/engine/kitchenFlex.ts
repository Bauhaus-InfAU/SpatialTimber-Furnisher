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
  /** Straight runs carry their end points instead. */
  straight: { start: Point2D; end: Point2D; into: Point2D } | null;
  /** 0…1 — how much of the required transition zone is actually free floor. */
  clearanceRatio: number;
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
  const out: number[] = [];
  for (const v of raw) {
    const c = Math.min(Math.max(v, 0), slack);
    if (!out.some((o) => Math.abs(o - c) < 0.05)) out.push(c);
  }
  return out;
}

/** Exported for tests. */
export function enumerateRuns(room: Room, count: number, opts: PlacementOptions): Run[] {
  const poly = room.polygon;
  const n = poly.length;
  const edgePoly = opts.edgePolygon ?? poly;
  const collisionPoly = opts.collisionPolygon ?? poly;
  const runs: Run[] = [];
  const runLen = count * MODULE;

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
      runs.push({
        modules,
        corner: null,
        straight: { start, end: add(start, mul(dir, runLen)), into },
        clearanceRatio: ratio,
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
      // legB[0] covers the same corner as legA[0] — keep one module for the two,
      // shaped as the cell both legs actually leave free: bounded by the two
      // walls, the two legs' first cut lines, and the mitre between them. At 90°
      // that hexagon collapses to the plain 0.6 × 0.6 square; on a slanted wall
      // it fills the wedge instead of leaving a notch between the legs.
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
      // Path order: out along leg A, through the corner, out along leg B.
      const modules = [...legA.slice(1).reverse(), legA[0], ...legB.slice(1)];
      const ratio = validateRun(modules, edgePoly, collisionPoly);
      if (ratio === null) continue;
      runs.push({
        modules,
        corner: {
          point: c,
          aDir, aNormal, aLen: aCount * MODULE,
          bDir, bNormal, bLen: bCount * MODULE,
        },
        straight: null,
        clearanceRatio: ratio,
      });
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

/**
 * Every worthwhile way to lay a modular kitchen into `room`, best first.
 *
 * Tries the full module count for the apartment type, dropping one module at a
 * time down to MIN_MODULES — a 5-module kitchen beats no kitchen. The first
 * count that fits wins. If nothing fits with its transition zones on real floor,
 * the search runs again accepting partial clearance, so a tight room still gets
 * a kitchen (with a lower score, and the zones visibly clipped).
 */
export function getFlexibleKitchenPlacements(
  room: Room,
  aptType: number,
  furnitureName: string,
  opts: PlacementOptions = {},
  maxOptions = 24,
): PlacementOption[] {
  const target = kitchenModuleCount(aptType);

  let scored: ScoredRun[] = [];
  for (const minRatio of [0.999, 0.5]) {
    for (let count = target; count >= MIN_MODULES && scored.length === 0; count--) {
      const seen = new Set<string>();
      for (const run of enumerateRuns(room, count, opts)) {
        if (run.clearanceRatio < minRatio) continue;
        const sig = signature(run);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const assignment = assignAppliances(run.modules);
        if (!assignment) continue;
        const score =
          assignment.score
          + 1.2 * count                              // more counter is better
          - 2.0 * (target - count)                   // …but falling short of the target hurts
          + (run.corner ? 0.5 : 0)                   // an L works better than one long wall
          + 3.0 * run.clearanceRatio;
        scored.push({ run, assignment, score });
      }
    }
    if (scored.length) break;
  }

  scored.sort((a, b) => b.score - a.score);
  scored = scored.slice(0, maxOptions);

  return scored.map(({ run, assignment }) => {
    const kinds: Appliance[] = run.modules.map((_, i) =>
      i === assignment.fridge ? "fridge" :
      i === assignment.sink   ? "sink"   :
      i === assignment.hob    ? "hob"    : "counter",
    );
    const footprint = runOutline(run, MODULE);
    const envelope  = runOutline(run, MODULE + CLEARANCE);
    const shape = run.corner ? "L" : "straight";
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
      },
    };
  });
}
