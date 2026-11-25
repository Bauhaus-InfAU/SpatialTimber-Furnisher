// ─── Furnish one room: search, fallback pieces, score ────────────────────────
//
// The one way a room is furnished, shared by the app and the CLI (until 2026-11
// this lived in the CLI's core.ts only):
//
//   1. the regular pieces of placement_order.md, each step's alternative chosen
//      for exactly this apartment type (resolveStep: 1- and 2-room bathrooms get
//      their shower); the placements are picked by sortOptionsByScore;
//   2. only when that leaves a step without any valid placement:
//        a. the regular pieces at other positions (searchOtherPositions, bounded);
//        b. the step's other alternative the old nearest-type way ("next
//           alternative": the 3-room bathtub where no shower layout exists),
//           no reduction of points, at its ranked positions, then at others;
//        c. each rule of default/fallbacks.json for this room and apartment
//           type, in file order (smaller pieces), the room score reduced by
//           `penaltyPoints`, at its ranked positions, then at others.
//      The first complete layout is used; when there is none, the regular
//      result of 1 stands.
//
// A room the regular pieces furnish completely is computed exactly as before.
//
// A kitchen built from 0.6 m modules (an open kitchen, Room.openKitchen /
// openSegments, or opts.flexibleKitchen) gets no other alternative and no
// fallback piece for its kitchen step: the modular placer owns that step and
// never falls back to a preset block (see pipeline.ts). Its other ways are
// skipped; the regular result stands.

import type { Room, RoomName } from "../layout/types";
import type { FallbackPiece, FallbackSet, FurnitureLibrary, OptionalStep, Pipeline } from "../library/types";
import { defaultLibrary, defaultPipeline, defaultFallbacks } from "../library/loader";
import { findFurnitureByName, resolveStep, resolveStepNearestType, roomNameToCategory } from "../library/lookup";
import { runRoomPipelineAt } from "./pipeline";
import type { PipelineOptions } from "./pipeline";
import { scoreRoom } from "./scorer";
import type { RoomScore } from "./scorer";
import type { PipelineWithOptions, StepOptions } from "./types";
import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Polygon as ClipPolygon } from "polygon-clipping";

export interface FurnishOptions extends PipelineOptions {
  /**
   * Fallback pieces and optional steps. Default: default/fallbacks.json when
   * neither `library` nor `pipeline` is given, otherwise none (a custom
   * library or pipeline is furnished as it is). Pass `null` for none.
   */
  fallbacks?: FallbackSet | null;
  /**
   * Bound of the search for other positions (pipeline runs per way of
   * furnishing; default SEARCH_RUNS, 0 = no search).
   */
  searchRuns?: number;
}

/** How a room that its regular pieces leave incomplete was furnished. */
export interface RoomFallback {
  /** Rule id from fallbacks.json, or "next-alternative". */
  id:            string;
  label:         string;
  /** Points taken off the room score (0 for "next-alternative"). */
  penaltyPoints: number;
  pieces:        FallbackPiece[];
}

export interface FurnishedRoom {
  /** The chosen layout; each step's options sorted best first (sorted index 0 = best room score). */
  result:         PipelineWithOptions;
  /** The chosen placement per step as generation-order indices: runRoomPipelineAt(room, aptType, selection, options) gives the same layout. */
  selection:      number[];
  /** The best option per step after the sort, as generation-order indices, and sortedToGen[step][sortedIdx]. */
  bestGenIndices: number[];
  sortedToGen:    number[][];
  /** null when the regular pieces were used. */
  fallback:       RoomFallback | null;
  /** The pipeline options of the chosen way, for re-running the room (e.g. with another selection). */
  options:        FurnishOptions;
}

// ─── Section lookup ───────────────────────────────────────────────────────────

export function roomSection(name: RoomName): string {
  return name.startsWith("Children") ? "Children" : name;
}

// ─── Score-sort options ───────────────────────────────────────────────────────
//
// Greedy pass: for each step, score every option keeping previous steps at their
// BEST GENERATION INDEX (not 0). Returns the best generation-order index per step,
// which the caller uses to re-run the pipeline for correct geometry + downstream options.
//
// Also reorders each step's allOptions (in-place) so sorted index 0 = best room score.

export interface SortResult {
  bestGenIndices: number[];
  /** sortedToGen[step][sortedIdx] = generation-order index in the current run. */
  sortedToGen: number[][];
}

export function sortOptionsByScore(
  room: Room,
  aptType: number,
  steps: StepOptions[],
  opts?: PipelineOptions,
): SortResult {
  const bestGenIdxPrev: number[] = [];
  const bestGenIndices: number[] = [];
  const sortedToGen: number[][] = [];

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si];
    if (step.allOptions.length <= 1) {
      bestGenIdxPrev.push(0);
      bestGenIndices.push(0);
      sortedToGen.push([0]);
      continue;
    }

    const scored: { origIdx: number; score: number }[] = [];
    for (let oi = 0; oi < step.allOptions.length; oi++) {
      const sels = [
        ...bestGenIdxPrev,
        oi,
        ...new Array(steps.length - si - 1).fill(0),
      ];
      const r  = runRoomPipelineAt(room, aptType, sels, opts);
      const rs = scoreRoom(room.name, r);
      scored.push({ origIdx: oi, score: rs.score });
    }
    scored.sort((a, b) => b.score - a.score || a.origIdx - b.origIdx);

    const bestGenIdx = scored[0].origIdx;
    bestGenIdxPrev.push(bestGenIdx);
    bestGenIndices.push(bestGenIdx);
    // sortedToGen[si][k] = gen index of the k-th best option
    sortedToGen.push(scored.map(s => s.origIdx));

    const oldToNew = new Map(scored.map((s, ni) => [s.origIdx, ni]));
    step.allOptions = scored.map(s => step.allOptions[s.origIdx]);
    if (step.selectedIndex >= 0) {
      step.selectedIndex = oldToNew.get(step.selectedIndex) ?? 0;
    }
    step.selected = step.allOptions[step.selectedIndex] ?? step.selected;
  }

  return { bestGenIndices, sortedToGen };
}

/** True when every pipeline step of the room has at least one valid placement. */
export function isComplete(result: PipelineWithOptions): boolean {
  return result.steps.length > 0 && result.steps.every(s => s.allOptions.length > 0);
}

// ─── The ways to furnish a room, in order ────────────────────────────────────

interface Way {
  pieces:   FallbackPiece[] | undefined;
  fallback: RoomFallback | null;
}

/** True when the room's kitchen step is built by the modular placer (pipeline.ts), never from a preset. */
export function modularKitchen(room: Room, opts?: PipelineOptions): boolean {
  return roomNameToCategory(room.name) === "Kitchen" &&
    (!!room.openKitchen || (room.openSegments?.length ?? 0) > 0 || !!opts?.flexibleKitchen);
}

function waysToFurnish(
  roomName: RoomName,
  aptType: number,
  lib: FurnitureLibrary,
  pipeline: Pipeline,
  fallbacks: FallbackSet | null,
  modular = false,
): Way[] {
  const section  = roomSection(roomName);
  const category = roomNameToCategory(roomName);
  // The modular kitchen step takes no other piece (see the top of this file).
  const steps    = (pipeline[section] ?? []).filter(alts => !(modular && alts.includes("Kitchen")));
  const ways: Way[] = [{ pieces: undefined, fallback: null }];

  // a. The nearest-type alternative, where it differs from the regular choice.
  const swapped: FallbackPiece[] = [];
  for (const alts of steps) {
    const a = resolveStep(lib, aptType, category, alts);
    const b = resolveStepNearestType(lib, aptType, category, alts);
    if (a && b && a.entry !== b.entry) swapped.push({ furnitureName: b.name, replaces: a.name });
  }
  if (swapped.length) {
    ways.push({
      pieces: swapped,
      fallback: {
        id: "next-alternative",
        label: swapped.map(p => `${p.furnitureName} instead of ${p.replaces}`).join(", "),
        penaltyPoints: 0,
        pieces: swapped,
      },
    });
  }

  // b. The fallback pieces of fallbacks.json.
  for (const rule of fallbacks?.rules ?? []) {
    if (rule.room !== section || !rule.aptTypes.includes(aptType)) continue;
    const pieces: FallbackPiece[] = [];
    let missing = false;
    for (const alts of steps) {
      const from = alts.find(n => n in rule.replace);
      if (!from) continue;
      const ref = rule.replace[from];
      const piece: FallbackPiece = typeof ref === "string"
        ? { furnitureName: ref, replaces: from }
        : { furnitureName: ref.name, replaces: from, aptType: ref.aptType };
      if (!findFurnitureByName(lib, piece.aptType ?? aptType, category, piece.furnitureName)) { missing = true; break; }
      pieces.push(piece);
    }
    if (missing || !pieces.length) continue;
    ways.push({
      pieces,
      fallback: { id: rule.id, label: rule.label, penaltyPoints: fallbacks!.penaltyPoints, pieces },
    });
  }
  return ways;
}

// ─── Furnish ──────────────────────────────────────────────────────────────────

interface Attempt {
  result:         PipelineWithOptions;
  selection:      number[];
  bestGenIndices: number[];
  sortedToGen:    number[][];
}

/** One way of furnishing the room, the placements picked by the greedy score sort. */
function furnishWith(room: Room, aptType: number, opts: PipelineOptions): Attempt {
  // Step 1: discover options. Step 2: sort and take the best generation indices.
  const first = runRoomPipelineAt(room, aptType, [], opts);
  const { bestGenIndices: selection } = sortOptionsByScore(room, aptType, first.steps, opts);
  // Step 3: re-run with them so downstream options are correct, and sort for the output order.
  const result = runRoomPipelineAt(room, aptType, selection, opts);
  const sorted = sortOptionsByScore(room, aptType, result.steps, opts);
  return { result, selection, bestGenIndices: sorted.bestGenIndices, sortedToGen: sorted.sortedToGen };
}

// ─── Other positions ──────────────────────────────────────────────────────────
//
// The score sort ranks a step's positions with the later steps at their first
// position, and keeps the best. Where that leaves a later piece without any
// place, a complete layout may still exist with a piece at another position
// (e.g. the shower in the other corner leaves room for toilet and washbasin).
// searchOtherPositions tries them depth first, each step's positions in ranked
// order, and stops at the first complete layout or after `runs` pipeline runs.

/** Pipeline runs the search for other positions may take, per way of furnishing a room. */
export const SEARCH_RUNS = 300;

export interface PositionSearch {
  /** Generation-order indices of the first complete layout found, or null. */
  selection: number[] | null;
  /** Pipeline runs used. */
  runs:      number;
  /** True when every combination was tried (the bound was not reached). */
  exhausted: boolean;
  /** Per piece: how often a tried layout ended with this piece finding no place. */
  blocked:   Record<string, number>;
}

export function searchOtherPositions(
  room: Room,
  aptType: number,
  opts: PipelineOptions,
  runs: number = SEARCH_RUNS,
): PositionSearch {
  const out: PositionSearch = { selection: null, runs: 0, exhausted: true, blocked: {} };
  const run = (sel: number[]) => { out.runs++; return runRoomPipelineAt(room, aptType, sel, opts); };
  const base = run([]);
  const n = base.steps.length;
  const pad = (sel: number[]) => [...sel, ...new Array(Math.max(0, n - sel.length)).fill(0)];
  if (isComplete(base)) { out.selection = pad([]); return out; }

  // `at` is the run with `prefix` fixed and the later steps at their first position.
  const visit = (prefix: number[], at: PipelineWithOptions): number[] | null => {
    const i = prefix.length;
    const count = at.steps[i]?.allOptions.length ?? 0;
    if (count === 0 || i >= n - 1) {
      const s = at.steps.find(st => st.allOptions.length === 0);
      if (s) out.blocked[s.furnitureName] = (out.blocked[s.furnitureName] ?? 0) + 1;
      return null;
    }
    const kids: { k: number; r: PipelineWithOptions; score: number }[] = [];
    for (let k = 0; k < count; k++) {
      if (out.runs >= runs) { out.exhausted = false; break; }
      const r = run([...prefix, k]);
      kids.push({ k, r, score: scoreRoom(room.name, r).score });
    }
    kids.sort((a, b) => b.score - a.score || a.k - b.k);
    const done = kids.find(x => isComplete(x.r));
    if (done) return pad([...prefix, done.k]);
    for (const kid of kids) {
      if (out.runs >= runs) { out.exhausted = false; return null; }
      const found = visit([...prefix, kid.k], kid.r);
      if (found) return found;
    }
    return null;
  };
  out.selection = visit([], base);
  return out;
}

/** The layout at a found selection, its options sorted for the output (as furnishWith). */
function attemptAt(room: Room, aptType: number, opts: PipelineOptions, selection: number[]): Attempt {
  const result = runRoomPipelineAt(room, aptType, selection, opts);
  const sorted = sortOptionsByScore(room, aptType, result.steps, opts);
  return { result, selection, bestGenIndices: sorted.bestGenIndices, sortedToGen: sorted.sortedToGen };
}

/** The fallback set in force for these options (see FurnishOptions.fallbacks). */
export function fallbacksFor(opts?: FurnishOptions): FallbackSet | null {
  if (opts?.fallbacks !== undefined) return opts.fallbacks;
  return opts?.library || opts?.pipeline ? null : defaultFallbacks;
}

/**
 * Furnish one room: the regular pieces first, then (only for a room they leave
 * incomplete) the next alternative and the fallback pieces, as described at the
 * top of this file.
 */
export function furnishRoom(room: Room, aptType: number, opts: FurnishOptions = {}): FurnishedRoom {
  const lib       = opts.library  ?? defaultLibrary;
  const pipeline  = opts.pipeline ?? defaultPipeline;
  const fallbacks = fallbacksFor(opts);
  const ways = waysToFurnish(room.name, aptType, lib, pipeline, fallbacks, modularKitchen(room, opts));

  const optionsOf = (way: Way): FurnishOptions => (way.pieces ? { ...opts, pieces: way.pieces } : opts);

  // Each way: its pieces at the ranked positions, then at other positions
  // (searchOtherPositions); the first complete layout wins.
  const regular = furnishWith(room, aptType, optionsOf(ways[0]));
  if (isComplete(regular.result)) return { ...regular, fallback: null, options: optionsOf(ways[0]) };
  const runs = opts.searchRuns ?? SEARCH_RUNS;
  for (const way of ways) {
    const wayOpts = optionsOf(way);
    const ranked = way === ways[0] ? regular : furnishWith(room, aptType, wayOpts);
    if (isComplete(ranked.result)) return { ...ranked, fallback: way.fallback, options: wayOpts };
    if (runs > 0) {
      const found = searchOtherPositions(room, aptType, wayOpts, runs).selection;
      if (found) return { ...attemptAt(room, aptType, wayOpts, found), fallback: way.fallback, options: wayOpts };
    }
  }
  return { ...regular, fallback: null, options: optionsOf(ways[0]) };
}

// ─── Score ────────────────────────────────────────────────────────────────────

/** Steps the room did without (optional steps of fallbacks.json that found no place). */
export interface MissingOptional {
  pieces:             { furnitureName: string; id: string; label: string }[];
  /** Points taken off the room score (fallbacks.json `optionalPenaltyPoints`). */
  penaltyPoints:      number;
  /** The room's score on its other pieces, before any reduction. */
  scoreBeforePenalty: number;
}

export interface FurnishedRoomScore {
  /** The room's 0–100 score after the reductions. */
  score:              number;
  /** The score before the reductions (when a fallback or an optional step applies). */
  scoreBeforePenalty: number;
  /** The engine's score per step (scoreRoom). */
  roomScore:          RoomScore;
  /** The room counts as furnished: every step placed (or the only steps without a place are optional ones), no pieces overlapping. */
  furnished:          boolean;
  /** Pieces whose solid outlines overlap (pieceOverlaps). */
  overlaps:           PieceOverlap[];
  /** Set when the room did without an optional step. */
  missingOptional:    MissingOptional | null;
}

/** The optional steps of a fallback set for this room and apartment type. */
export function optionalStepsFor(roomName: RoomName, aptType: number, fallbacks: FallbackSet | null): OptionalStep[] {
  const section = roomSection(roomName);
  return (fallbacks?.optional ?? []).filter(o => o.room === section && o.aptTypes.includes(aptType));
}

/**
 * The room's score: scoreRoom, less the fallback's reduction of points. When
 * the only steps without a place are optional ones for this apartment type
 * (fallbacks.json `optional`), the room is scored on its other steps (their
 * weights rescaled), less `optionalPenaltyPoints`, and counts as furnished.
 */
export function scoreFurnishedRoom(
  roomName: RoomName,
  result: PipelineWithOptions,
  fallback: RoomFallback | null,
  aptType?: number,
  fallbacks?: FallbackSet | null,
): FurnishedRoomScore {
  const roomScore = scoreRoom(roomName, result);
  const placed = result.steps.map(s => s.allOptions.length > 0 || s.selected !== null);
  const overlaps = pieceOverlaps(result);
  const furnished = allPlaced(result) && overlaps.length === 0;
  const fbPenalty = fallback?.penaltyPoints ?? 0;
  const less = (v: number, p: number) => (p ? Math.max(0, Math.round((v - p) * 10) / 10) : v);

  const optional = aptType === undefined ? [] : optionalStepsFor(roomName, aptType, fallbacks ?? null);
  const unplaced = result.steps.filter((_, i) => !placed[i]);
  if (!allPlaced(result) && optional.length && unplaced.length < result.steps.length &&
      unplaced.every(s => optional.some(o => o.furniture === s.furnitureName))) {
    const rest = roomScore.steps.filter((_, i) => placed[i]);
    const w = rest.reduce((sum, s) => sum + s.levelWeight, 0);
    const base = w > 0 ? Math.round((rest.reduce((sum, s) => sum + s.nodeScore * s.levelWeight, 0) / w) * 1000) / 10 : 0;
    const penaltyPoints = fallbacks?.optionalPenaltyPoints ?? 0;
    const pieces = unplaced.map(s => {
      const o = optional.find(x => x.furniture === s.furnitureName)!;
      return { furnitureName: s.furnitureName, id: o.id, label: o.label };
    });
    return {
      score: less(base, penaltyPoints + fbPenalty), scoreBeforePenalty: base, roomScore,
      furnished: overlaps.length === 0, overlaps, missingOptional: { pieces, penaltyPoints, scoreBeforePenalty: base },
    };
  }
  return { score: less(roomScore.score, fbPenalty), scoreBeforePenalty: roomScore.score, roomScore, furnished, overlaps, missingOptional: null };
}

// ─── Apartment ────────────────────────────────────────────────────────────────

/** A room as the apartment summary counts it. */
export interface RoomTally {
  /** The room's score (null when its computation failed: counts as 0). */
  score:     number | null;
  /** Floor area, the room's weight in the apartment score. */
  area:      number;
  /** The room counts as furnished (see roomFurnished). */
  furnished: boolean;
}

export interface ApartmentSummary {
  /** The rooms' scores weighted by their areas, rounded to 2 decimals (0 without area). */
  score:     number;
  /** Every room counts as furnished. */
  furnished: boolean;
}

/**
 * A room counts as furnished when its computation did not fail, it has steps,
 * every step has a placement (a valid one, or one the user placed by hand in
 * the app), and no two of its pieces overlap (pieceOverlaps).
 */
export function roomFurnished(result: PipelineWithOptions | null): boolean {
  return !!result && allPlaced(result) && pieceOverlaps(result).length === 0;
}

function allPlaced(result: PipelineWithOptions): boolean {
  return result.steps.length > 0 && result.steps.every(s => s.allOptions.length > 0 || s.selected !== null);
}

// ─── Overlapping pieces ───────────────────────────────────────────────────────
//
// Where every placement of a piece interferes with a clearance zone, the
// pipeline keeps the best one anyway ("using best available"), and the piece
// can then stand on another (e.g. the dining table on the sofa). Such a room
// does not count as furnished. Two pieces overlap when their solid outlines
// (the closed outlines of their geometry) share more than OVERLAP_M2 of floor.

/** Floor (m²) two pieces' solid outlines may share before they count as overlapping. */
export const OVERLAP_M2 = 0.01;

export interface PieceOverlap {
  a:  string;
  b:  string;
  /** The shared floor, m², 2 decimals. */
  m2: number;
}

const GRID = 1e-7;
const snap = (pts: [number, number][]) => pts.map(([x, y]) => [Math.round(x / GRID) * GRID, Math.round(y / GRID) * GRID] as [number, number]);

function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

function area(mp: MultiPolygon): number {
  return mp.reduce((sum, poly) => sum + ringArea(poly[0] as [number, number][]) -
    poly.slice(1).reduce((h, ring) => h + ringArea(ring as [number, number][]), 0), 0);
}

function solidOf(step: StepOptions): MultiPolygon | null {
  const polys: ClipPolygon[] = (step.selected?.placed.transformedGeometry ?? [])
    .filter(g => g.closed && g.points.length >= 3)
    .map(g => [snap(g.points as [number, number][])]);
  if (!polys.length) return null;
  const u = polygonClipping.union(polys[0], ...polys.slice(1));
  return u.length ? u : null;
}

/** The pairs of the room's pieces whose solid outlines overlap by more than OVERLAP_M2, in step order. */
export function pieceOverlaps(result: PipelineWithOptions): PieceOverlap[] {
  const solids = result.steps.map(s => {
    try { return solidOf(s); } catch { return null; }
  });
  const out: PieceOverlap[] = [];
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const a = solids[i], b = solids[j];
      if (!a || !b) continue;
      let x = 0;
      try { x = area(polygonClipping.intersection(a, b)); } catch { continue; }
      if (x > OVERLAP_M2) out.push({ a: result.steps[i].furnitureName, b: result.steps[j].furnitureName, m2: Math.round(x * 100) / 100 });
    }
  }
  return out;
}

/** Rounds to 2 decimals as Python's round(x, 2) does: the nearer value, an exact tie (only x = k/8) to the even digit. */
export function round2(x: number): number {
  const eighths = x * 8;                                  // exact
  if (Number.isInteger(eighths) && Math.abs(eighths) % 2 === 1) {
    const hundredths = x * 100;                           // exact: ends in .5
    const low = Math.floor(hundredths);
    return Number(((low % 2 === 0 ? low : low + 1) / 100).toFixed(2));
  }
  return Number(x.toFixed(2));
}

/**
 * The apartment's score and whether every room counts as furnished: every
 * room of the request counts, each weighted by its area (the Composer's rule:
 * the area-weighted mean of the room scores, rounded to 2 decimals).
 */
export function summarizeApartment(rooms: RoomTally[]): ApartmentSummary {
  let wsum = 0, asum = 0, furnished = true;
  for (const r of rooms) {
    wsum += (r.score || 0) * r.area;
    asum += r.area;
    furnished = furnished && r.furnished;
  }
  return { score: asum ? round2(wsum / asum) : 0, furnished };
}

export type { OptionalStep };
export type { FallbackSet };
