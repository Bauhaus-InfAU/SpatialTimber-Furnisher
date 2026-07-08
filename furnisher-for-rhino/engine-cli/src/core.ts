// ─── Furnisher core ─────────────────────────────────────────────────────────
//
// Reusable bridge logic between callers (CLI, batch runner) and the TypeScript
// furnisher engine. Takes ONE JSON request object, runs the engine, returns
// the response object. All geometry is in metres, the engine's native unit.
//
// NOTE: the engine emits many `[placer] ...` debug lines via console.log at
// runtime. Callers should silence console.log/debug/info before invoking
// processRequest if stdout is their JSON channel.

import { getAllPlacements, getDoorRectangles, doorWidth, subtractPolygon } from "../../../furnisher-engine/src/engine/index";
import { scoreRoom } from "../../../furnisher-engine/src/engine/scorer";
import { defaultLibrary, defaultPipeline } from "../../../furnisher-engine/src/library/loader";
import { findFurnitureByName, roomNameToCategory } from "../../../furnisher-engine/src/library/lookup";
import type { RoomName, Point2D, Room } from "../../../furnisher-engine/src/layout/types";
import type { PlacementOption, StepOptions, PipelineWithOptions } from "../../../furnisher-engine/src/engine/types";
import type { FurnitureLibrary, Pipeline } from "../../../furnisher-engine/src/library/types";

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export interface RoomInput {
  name: string;
  polygon: Point2D[];
  windows?: Point2D[];
}

export interface Request {
  rooms: RoomInput[];
  doors?: Point2D[];
  aptType?: number;
  /** "flat": selections[room]=[flatIdx...] | "variant-position": [vi,pos,...] */
  selectionMode?: "flat" | "variant-position";
  selections?: number[][];
}

interface VariantGroup {
  variantIndex: number;
  startFlatIndex: number;
  count: number;
}

export interface StepScoreOut {
  furnitureName: string;
  preferredCount: number;
  fallbackCount: number;
  usedFallback: boolean;
  nodeScore: number;
  levelWeight: number;
}

export interface DoorOut {
  /** The four wall-aligned rectangle points [c0,c1,c2,c3].
   *  c0 = door - wallDir*dw/2,  c1 = door + wallDir*dw/2
   *  c2 = c1 + inward*dw,       c3 = c0 + inward*dw  */
  rect: Point2D[];
  /** Width of the door (metres). */
  width: number;
  /** 0 → hinge at c0, panel swings to c3, arc c3→c1.
   *  1 → hinge at c1, panel swings to c2, arc c2→c0.
   *  Chosen so the door opens toward the room interior (hinge near nearest corner). */
  hingeAtIndex: 0 | 1;
}

export interface StepOut {
  furnitureName: string;
  optionCount: number;
  selectedIndex: number;
  variantGroups: VariantGroup[];
  selectedVariant: number;
  selectedPosition: number;
  geometry: { closed: boolean; points: Point2D[] }[];
  bbox: Point2D[];
  smallBbox: Point2D[];
}

export interface RoomOut {
  name: string;
  /** null when this room's computation failed (see `error`). */
  score: number | null;
  stepScores: StepScoreOut[];
  steps: StepOut[];
  doors: DoorOut[];
  warnings: string[];
  /** Present when the engine threw for this room; other rooms are unaffected. */
  error?: string;
}

// ─── Polygon helpers ──────────────────────────────────────────────────────────

const ADJACENT_DOOR_THRESHOLD = 0.4;

function polygonSignedArea(pts: Point2D[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/**
 * Remove near-duplicate vertices AND collinear intermediate points.
 *
 * Rhino's ToPolyline() discretises even rectangular curves, leaving extra
 * vertices on straight wall segments (e.g. 6 points on a 4-sided rectangle).
 * polygon-clipping's boolean ops can silently fail on such degenerate inputs,
 * causing the subtraction chain to return the original polygon — so subsequent
 * pieces see the full room and land on top of earlier ones.
 */
function simplifyPolygon(pts: Point2D[], minEdge = 0.005, collinearTol = 0.002): Point2D[] {
  if (pts.length <= 3) return pts;

  // 1. Remove near-duplicate consecutive vertices.
  let out: Point2D[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const curr = pts[i];
    if (Math.hypot(curr[0] - prev[0], curr[1] - prev[1]) >= minEdge) out.push(curr);
  }
  // Check last vs first.
  while (out.length > 3) {
    const first = out[0], last = out[out.length - 1];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) < minEdge) out.pop();
    else break;
  }

  // 2. Remove collinear intermediate points (prev→curr→next nearly on one line).
  //    Repeat until stable — one pass might leave new collinear triples.
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    const next: Point2D[] = [];
    for (let i = 0; i < out.length; i++) {
      const prev = out[(i - 1 + out.length) % out.length];
      const curr = out[i];
      const nxt  = out[(i + 1) % out.length];
      // Cross-product magnitude = 2 × triangle area.
      const cross = Math.abs(
        (curr[0] - prev[0]) * (nxt[1] - prev[1]) -
        (nxt[0]  - prev[0]) * (curr[1] - prev[1]),
      );
      if (cross > collinearTol) {
        next.push(curr);
      } else {
        changed = true; // drop this collinear point
      }
    }
    if (next.length >= 3) out = next;
  }

  return out.length >= 3 ? out : pts;
}

/** Engine wants CCW winding. */
function normalizePolygon(pts: Point2D[]): Point2D[] {
  const s = simplifyPolygon(pts);
  return polygonSignedArea(s) < 0 ? [...s].reverse() : s;
}

function distPointToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function distPointToPolygon(p: Point2D, poly: Point2D[]): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = distPointToSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (d < min) min = d;
  }
  return min;
}

// ─── Room name resolver ───────────────────────────────────────────────────────

const VALID_ROOM_NAMES = new Set<string>([
  "Bedroom", "Living room", "Bathroom", "WC", "Kitchen",
  "Children 1", "Children 2", "Children 3", "Children 4",
]);

function resolveRoomName(raw: string, childCounter: { n: number }): RoomName {
  const name = (raw ?? "").replace(/^\s*\d+[\s._-]*/, "").trim();
  if (/^children$/i.test(name)) {
    childCounter.n++;
    return `Children ${Math.min(4, childCounter.n)}` as RoomName;
  }
  for (const valid of VALID_ROOM_NAMES) {
    if (valid.toLowerCase() === name.toLowerCase()) return valid as RoomName;
  }
  if (/^children\s*\d+$/i.test(name)) {
    const n = parseInt(name.replace(/\D+/g, ""), 10) || 1;
    return `Children ${Math.min(4, n)}` as RoomName;
  }
  return name as RoomName;
}

function inferApartmentType(names: RoomName[]): number {
  const hasSleeping = names.some(n => n === "Bedroom" || n.startsWith("Children"));
  const qualifying = names.filter(
    n => n === "Living room" || n === "Bedroom" || n.startsWith("Children"),
  ).length;
  const min = hasSleeping ? 2 : 1;
  return Math.min(4, Math.max(min, qualifying || min));
}

// ─── Variant group builder ────────────────────────────────────────────────────

function buildVariantGroups(allOptions: PlacementOption[]): VariantGroup[] {
  const groups: VariantGroup[] = [];
  for (let i = 0; i < allOptions.length; i++) {
    const vi = allOptions[i].variantIndex;
    const last = groups[groups.length - 1];
    if (last && last.variantIndex === vi) { last.count++; }
    else { groups.push({ variantIndex: vi, startFlatIndex: i, count: 1 }); }
  }
  return groups;
}

// ─── Strict clearance pipeline ───────────────────────────────────────────────
//
// The engine's standard runRoomPipelineAt prevents new piece N's smallBbox from
// overlapping previous pieces' smallBboxes (via roomFullChain) and from being
// placed inside previous pieces' largeBboxes (via roomRdcChain).
//
// BUT it does NOT prevent new piece N's largeBbox from containing a PREVIOUSLY
// placed piece's smallBbox — meaning a later piece's clearance zone can engulf
// an earlier piece's physical footprint, leaving it inaccessible.
//
// This pipeline adds that bidirectional check.

const FREESTANDING = new Set<string>(["Dining"]);

function sectionName(name: RoomName): string {
  return name.startsWith("Children") ? "Children" : name;
}

/** AABB overlap test between two (possibly rotated) rectangle polygons.
 *  Uses min/max bounds — conservative but correct for axis-aligned bboxes,
 *  which is what the engine produces for wall-aligned furniture. */
function aabbOverlap(pts1: Point2D[], pts2: Point2D[]): boolean {
  if (!pts1.length || !pts2.length) return false;
  const xs1 = pts1.map(p => p[0]), ys1 = pts1.map(p => p[1]);
  const xs2 = pts2.map(p => p[0]), ys2 = pts2.map(p => p[1]);
  const eps = 1e-3; // 1 mm — avoids rejecting pieces that merely share a wall edge
  return Math.max(...xs1) > Math.min(...xs2) + eps &&
         Math.max(...xs2) > Math.min(...xs1) + eps &&
         Math.max(...ys1) > Math.min(...ys2) + eps &&
         Math.max(...ys2) > Math.min(...ys1) + eps;
}

function runStrictPipelineAt(
  room: Room,
  aptType: number,
  selectedIndices: number[],
  opts?: { library?: FurnitureLibrary; pipeline?: Pipeline },
): PipelineWithOptions {
  const lib      = opts?.library   ?? defaultLibrary;
  const pipeline = opts?.pipeline  ?? defaultPipeline;
  const steps    = pipeline[sectionName(room.name)] ?? [];
  const category = roomNameToCategory(room.name);

  const originalWalls: [Point2D, Point2D][] = room.polygon.map(
    (a, i) => [a, room.polygon[(i + 1) % room.polygon.length]],
  );

  const doorRects = getDoorRectangles(room);
  let roomFullChain: Point2D[] = room.polygon;
  let roomRdcChain: Point2D[]  = room.polygon;
  for (const rect of doorRects) roomRdcChain = subtractPolygon(roomRdcChain, rect);

  // Physical footprints of all pieces placed so far.
  const placedSmallBboxes: Point2D[][] = [];

  const resultSteps: StepOptions[] = [];
  const warnings: string[]         = [];

  for (let i = 0; i < steps.length; i++) {
    const alternatives = steps[i];

    let entry = null, resolvedName = "";
    for (const name of alternatives) {
      entry = findFurnitureByName(lib, aptType, category, name);
      if (entry) { resolvedName = name; break; }
    }
    if (!entry) {
      warnings.push(`No library entry for [${alternatives.join(" | ")}] in ${category} apt ${aptType} — skipped`);
      resultSteps.push({ furnitureName: alternatives.join(" | "), allOptions: [], selectedIndex: -1, selected: null });
      continue;
    }

    const placementOpts = {
      referenceWalls:   FREESTANDING.has(resolvedName) ? undefined : originalWalls,
      collisionPolygon: roomFullChain,
      edgePolygon:      roomRdcChain,
    };

    const allRaw = getAllPlacements(room, entry, placementOpts);

    if (allRaw.length === 0) {
      warnings.push(`No valid placement found for "${resolvedName}" — skipped`);
      resultSteps.push({ furnitureName: resolvedName, allOptions: [], selectedIndex: -1, selected: null });
      continue;
    }

    // Strict filter: reject options where this piece's largeBbox overlaps any
    // previously placed piece's smallBbox (clearance zone would block a placed piece).
    const strictOptions = allRaw.filter(opt =>
      !placedSmallBboxes.some(prev =>
        aabbOverlap(opt.placed.transformedBbox as unknown as Point2D[], prev),
      ),
    );

    const useOptions = strictOptions.length > 0 ? strictOptions : allRaw;
    if (strictOptions.length === 0) {
      warnings.push(`"${resolvedName}": all placements interfere with clearance zones — using best available`);
    }

    const raw          = selectedIndices[i] ?? 0;
    const selectedIndex = Math.min(Math.max(raw, 0), useOptions.length - 1);
    const selected      = useOptions[selectedIndex];

    resultSteps.push({ furnitureName: resolvedName, allOptions: useOptions, selectedIndex, selected });

    placedSmallBboxes.push(selected.placed.transformedSmallBbox as unknown as Point2D[]);
    roomFullChain = subtractPolygon(roomFullChain, selected.placed.smallCutout);
    roomRdcChain  = subtractPolygon(roomRdcChain,  selected.placed.largeCutout);
  }

  return { steps: resultSteps, warnings };
}

// ─── Score-sort options ───────────────────────────────────────────────────────
//
// Greedy pass: for each step, score every option keeping previous steps at their
// BEST GENERATION INDEX (not 0). Returns the best generation-order index per step,
// which the caller uses to re-run the pipeline for correct geometry + downstream options.
//
// Also reorders each step's allOptions (in-place) so sorted index 0 = best room score.

interface SortResult {
  bestGenIndices: number[];
  /** sortedToGen[step][sortedIdx] = generation-order index in the current run. */
  sortedToGen: number[][];
}

function sortOptionsByScore(
  room: Room,
  aptType: number,
  steps: StepOptions[],
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
      const r  = runStrictPipelineAt(room, aptType, sels);
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

// ─── Door hinge selection ─────────────────────────────────────────────────────

/**
 * Return 0 if c0 should be the hinge, 1 if c1 should.
 * Rule: place the hinge at the wall-point closest to any room corner.
 * This makes the door swing away from corners, toward the open room interior.
 */
function pickHingeIndex(c0: Point2D, c1: Point2D, polygon: Point2D[]): 0 | 1 {
  const nearestCornerDist = (p: Point2D) =>
    Math.min(...polygon.map(v => Math.hypot(v[0] - p[0], v[1] - p[1])));
  return nearestCornerDist(c0) <= nearestCornerDist(c1) ? 0 : 1;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function processRequest(req: Request) {
  const childCounter = { n: 0 };
  const allDoors = req.doors ?? [];

  const engineRooms = req.rooms.map((r) => {
    const name = resolveRoomName(r.name, childCounter);
    const polygon = normalizePolygon(r.polygon);
    const doors = allDoors.filter(d => distPointToPolygon(d, polygon) <= ADJACENT_DOOR_THRESHOLD);
    return { name, polygon, doors, windows: r.windows ?? [] };
  });

  const aptType = req.aptType ?? inferApartmentType(engineRooms.map(r => r.name));

  const computeRoom = (er: (typeof engineRooms)[number], roomIdx: number): RoomOut => {
    const room = {
      name: er.name,
      polygon: er.polygon,
      ...(er.doors.length ? { doors: er.doors } : {}),
      ...(er.windows.length ? { windows: er.windows } : {}),
    };

    const rawSel = req.selections?.[roomIdx] ?? [];
    const hasUserSel = rawSel.some(v => v !== 0);

    // ── Step 1: discover options ──────────────────────────────────────────────
    let result = runStrictPipelineAt(room, aptType, []);

    // ── Step 2: sort + capture gen-index maps ─────────────────────────────────
    const { bestGenIndices } = sortOptionsByScore(room, aptType, result.steps);

    // ── Step 3: re-run with best gen indices so downstream options are correct
    result = runStrictPipelineAt(room, aptType, bestGenIndices);
    const { bestGenIndices: bestGenIdx2, sortedToGen: maps2 } =
      sortOptionsByScore(room, aptType, result.steps);

    // ── Step 4: apply user selections with proper re-runs ─────────────────────
    //
    // User indices are SORTED indices (0 = best).
    // maps2[step][sortedIdx] = generation-order index for that option.
    //
    // When the user picks a non-zero sorted index for step i, we must re-run the
    // pipeline from step i+1 to get the correct downstream options in the space
    // left by the user's chosen placement — exactly as the app does.
    if (hasUserSel) {
      // Resolve raw input to sorted flat indices per step.
      const userSortedIdx: number[] = result.steps.map((s, i) => {
        let k: number;
        if (req.selectionMode === "variant-position") {
          const vi  = rawSel[i * 2]     ?? 0;
          const pos = rawSel[i * 2 + 1] ?? 0;
          const groups = buildVariantGroups(s.allOptions);
          const group  = groups.find(g => g.variantIndex === vi) ?? groups[0];
          k = group ? Math.min(group.startFlatIndex + pos, group.startFlatIndex + group.count - 1) : 0;
        } else {
          k = rawSel[i] ?? 0;
        }
        return Math.min(Math.max(k, 0), Math.max(0, s.allOptions.length - 1));
      });

      // Convert sorted indices → generation indices, re-running after each
      // changed step so downstream options are always computed in the correct space.
      let resolvedGenIdx = [...bestGenIdx2];
      let currentResult  = result;
      let currentMaps    = maps2;

      for (let i = 0; i < result.steps.length; i++) {
        const k = userSortedIdx[i];
        if (k === 0) continue; // already using the best for this step

        // Map sorted k → generation index in the current pipeline run.
        const genIdx = currentMaps[i]?.[k] ?? resolvedGenIdx[i];
        resolvedGenIdx[i] = genIdx;

        // Re-run from this step onwards to get correct downstream options.
        const runSels = [
          ...resolvedGenIdx.slice(0, i + 1),
          ...new Array(result.steps.length - i - 1).fill(0),
        ];
        currentResult = runStrictPipelineAt(room, aptType, runSels);
        const { bestGenIndices: newBest, sortedToGen: newMaps } =
          sortOptionsByScore(room, aptType, currentResult.steps);
        currentMaps = newMaps;
        // Update best gen indices for remaining steps.
        for (let j = i + 1; j < result.steps.length; j++) {
          resolvedGenIdx[j] = newBest[j];
        }
      }
      result = currentResult;
    }

    // Score this room.
    const roomScore = scoreRoom(er.name, result);

    const stepScores: StepScoreOut[] = roomScore.steps.map(s => ({
      furnitureName: s.furnitureName,
      preferredCount: s.preferredCount,
      fallbackCount: s.fallbackCount,
      usedFallback: s.usedFallbackVariant,
      nodeScore: s.nodeScore,
      levelWeight: s.levelWeight,
    }));

    const steps: StepOut[] = result.steps.map((s) => {
      const groups = buildVariantGroups(s.allOptions);
      let selVariant = -1, selPos = -1;
      if (s.selectedIndex >= 0) {
        const g = groups.find(
          g => s.selectedIndex >= g.startFlatIndex &&
               s.selectedIndex < g.startFlatIndex + g.count,
        );
        if (g) { selVariant = g.variantIndex; selPos = s.selectedIndex - g.startFlatIndex; }
      }
      return {
        furnitureName: s.furnitureName,
        optionCount: s.allOptions.length,
        selectedIndex: s.selectedIndex,
        variantGroups: groups,
        selectedVariant: selVariant,
        selectedPosition: selPos,
        geometry: s.selected ? s.selected.placed.transformedGeometry : [],
        bbox: s.selected ? s.selected.placed.transformedBbox : [],
        smallBbox: s.selected ? s.selected.placed.transformedSmallBbox : [],
      };
    });

    // Door geometry from the engine
    const dw = doorWidth(er.name);
    const doorRects = getDoorRectangles(room);
    const doors: DoorOut[] = doorRects.map(rect => ({
      rect,
      width: dw,
      hingeAtIndex: pickHingeIndex(rect[0], rect[1], er.polygon),
    }));

    return { name: er.name, score: roomScore.score, stepScores, steps, doors, warnings: result.warnings };
  };

  // Per-room error isolation: one bad room (e.g. polygon-clipping's "Unable to
  // complete output ring" on a degenerate polygon) must not kill the whole
  // apartment. Failed rooms come back with score: null and an error string.
  const roomsOut: RoomOut[] = engineRooms.map((er, roomIdx) => {
    try {
      return computeRoom(er, roomIdx);
    } catch (err) {
      return {
        name: er.name,
        score: null,
        stepScores: [],
        steps: [],
        doors: [],
        warnings: [],
        error: String((err && (err as Error).message) || err),
      };
    }
  });

  return { aptType, rooms: roomsOut };
}
