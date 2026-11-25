// ─── Open-kitchen bar ────────────────────────────────────────────────────────
//
// Where an open kitchen meets the living room there may be a bar: a short,
// plain counter top (no sink, hob or fridge) standing in the kitchen with its
// long side on the opening, and two or three bar stools on the living-room
// side. It is optional decoration on top of the kitchen counter, never a
// substitute for it.
//
// planKitchenBars lists every bar that fits next to an already chosen counter,
// best first. The caller (the Rhino CLI) checks each against the living room —
// the stool zone is reserved out of the living room's floor, and a bar that
// costs the living room options or score is dropped.
//
// Rules:
//   • bar top BAR_DEPTH deep, BAR_LENGTHS long (longest that fits wins), wholly
//     inside the kitchen, its long side on an open segment;
//   • ≥ BAR_COUNTER_GAP between every counter module's footprint and the bar,
//     and no overlap with any module's work zone;
//   • the opening keeps OPEN_PASSAGE free (counter and bar both count);
//   • the stool zone (bar length × STOOL_ZONE deep, across the opening) lies
//     wholly in one living room, clear of that room's door swings and of floor
//     already reserved there (the counter's worktop extension).

import type { Point2D, Room } from "../layout/types";
import type { PlacedFurniture } from "./types";
import { pointInPolygon, insetInside, getDoorRectangles } from "./placer";
import { polyPolyDist, convexOverlap, type OpenSegment } from "./openKitchen";
import { passageOk } from "./kitchenFlex";

export const BAR_DEPTH = 0.5;
export const BAR_LENGTHS = [1.8, 1.5, 1.2];
export const BAR_COUNTER_GAP = 1.0;
export const STOOL_ZONE = 0.6;
const STOOL_RADIUS = 0.2;

export interface BarPlan {
  /** Bar top, inside the kitchen. */
  footprint: Point2D[];
  /** Stool outlines, on the living-room side of the opening. */
  stools: Point2D[][];
  /** Floor the stools take in the living room (reserve it there). */
  stoolZone: Point2D[];
  /** Drawing: bar top, its front edge line, stools. */
  geometry: { closed: boolean; points: Point2D[] }[];
  /** Index (into the caller's `livings`) of the living room the stools stand in. */
  livingIndex: number;
  length: number;
}

const add = (a: Point2D, b: Point2D): Point2D => [a[0] + b[0], a[1] + b[1]];
const mul = (v: Point2D, s: number): Point2D => [v[0] * s, v[1] * s];

function circle(c: Point2D, r: number, n = 16): Point2D[] {
  const out: Point2D[] = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/**
 * Every bar that fits beside the kitchen's chosen counter, best first
 * (longest, then most free passage). `livings` are the rooms across the
 * opening; `gap` is the distance between the two boundaries at the opening
 * (0 when they touch).
 */
export function planKitchenBars(
  kitchen: Room,
  placed: PlacedFurniture,
  livings: { index: number; room: Room }[],
  gap = 0,
): BarPlan[] {
  const segs: OpenSegment[] = kitchen.openSegments ?? [];
  const modules = placed.modules ?? [];
  if (!segs.length || !modules.length || !livings.length) return [];
  const footprints = modules.map((m) => m.footprint);
  const clearances = modules.map((m) => m.clearance).filter((c) => c.length >= 3);
  const doorRects = new Map(livings.map((l) => [l.index, getDoorRectangles(l.room)]));

  const plans: (BarPlan & { passage: number })[] = [];
  for (const [s0, s1] of segs) {
    const L = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]);
    if (L < BAR_LENGTHS[BAR_LENGTHS.length - 1]) continue;
    const u: Point2D = [(s1[0] - s0[0]) / L, (s1[1] - s0[1]) / L];
    let inward: Point2D = [-u[1], u[0]];
    const mid = add(s0, mul(u, L / 2));
    if (!pointInPolygon(add(mid, mul(inward, 0.05)), kitchen.polygon)) inward = mul(inward, -1);
    const outward = mul(inward, -1);

    for (const len of BAR_LENGTHS) {
      if (len > L + 1e-9) continue;
      const slack = L - len;
      const ts: number[] = [];
      for (const t of [0, slack, slack / 2, 0.9, slack - 0.9]) {
        const c = Math.min(Math.max(t, 0), slack);
        if (!ts.some((x) => Math.abs(x - c) < 0.05)) ts.push(c);
      }
      for (const t of ts) {
        const p0 = add(s0, mul(u, t));
        const p1 = add(p0, mul(u, len));
        const bar: Point2D[] = [p0, p1, add(p1, mul(inward, BAR_DEPTH)), add(p0, mul(inward, BAR_DEPTH))];
        if (!insetInside(bar, kitchen.polygon)) continue;
        if (footprints.some((f) => polyPolyDist(f, bar) < BAR_COUNTER_GAP - 1e-6)) continue;
        if (clearances.some((c) => convexOverlap(c, bar))) continue;
        if (!passageOk(segs, [...footprints, bar])) continue;

        const z0 = add(p0, mul(outward, gap));
        const z1 = add(z0, mul(u, len));
        const zone: Point2D[] = [z0, z1, add(z1, mul(outward, STOOL_ZONE)), add(z0, mul(outward, STOOL_ZONE))];
        const living = livings.find((l) => insetInside(zone, l.room.polygon));
        if (!living) continue;
        if ((doorRects.get(living.index) ?? []).some((r) => convexOverlap(r, zone))) continue;
        // Floor already reserved there (a worktop extension of the counter).
        if ((living.room.reserved ?? []).some((r) => convexOverlap(r, zone))) continue;

        const n = len >= 1.8 - 1e-9 ? 3 : 2;
        const stools: Point2D[][] = [];
        for (let k = 0; k < n; k++) {
          stools.push(circle(add(add(z0, mul(u, (len * (k + 0.5)) / n)), mul(outward, STOOL_ZONE / 2)), STOOL_RADIUS));
        }
        const lip = 0.05; // the overhang line on the stool side
        const geometry = [
          { closed: true, points: bar },
          { closed: false, points: [add(p0, mul(inward, lip)), add(p1, mul(inward, lip))] },
          ...stools.map((s) => ({ closed: true, points: s })),
        ];
        // Free passage left beside the bar (for ranking only).
        const passage = Math.max(t, slack - t);
        plans.push({ footprint: bar, stools, stoolZone: zone, geometry, livingIndex: living.index, length: len, passage });
      }
    }
  }

  plans.sort((a, b) => b.length - a.length || b.passage - a.passage);
  return plans.map(({ passage: _passage, ...p }) => p);
}
