// ─── Furnisher core ─────────────────────────────────────────────────────────
//
// Reusable bridge logic between callers (CLI, batch runner) and the TypeScript
// furnisher engine. Takes ONE JSON request object, runs the engine, returns
// the response object. All geometry is in metres, the engine's native unit.
//
// NOTE: the engine emits many `[placer] ...` debug lines via console.log at
// runtime. Callers should silence console.log/debug/info before invoking
// processRequest if stdout is their JSON channel.

import { getDoorRectangles, doorWidth, simplifyPolygon as engineSimplify, runRoomPipelineAt, furnishRoom, scoreFurnishedRoom, sortOptionsByScore, summarizeApartment, fallbacksFor } from "../../../furnisher-engine/src/engine/index";
import type { RoomName, Point2D } from "../../../furnisher-engine/src/layout/types";
import type { PlacementOption } from "../../../furnisher-engine/src/engine/types";

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export interface RoomInput {
  name: string;
  polygon: Point2D[];
  windows?: Point2D[];
  /** Floor area (m²), the room's weight in the apartment score; default: the polygon's area. */
  area?: number;
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
  /** Only on a fallback piece: the regular piece it stands in for (e.g. "Bathtube"). */
  replaces?: string;
}

/** Present only when the room could not be furnished completely with its regular pieces. */
export interface FallbackOut {
  /** Rule id from fallbacks.json, or "next-alternative" (e.g. the bathtub where the shower does not fit). */
  id: string;
  label: string;
  /** Points taken off this room's score (fallbacks.json `penaltyPoints`; 0 for "next-alternative"). */
  penaltyPoints: number;
  /** The room's score before the reduction. */
  scoreBeforePenalty: number;
  pieces: { furnitureName: string; replaces: string }[];
}

export interface RoomOut {
  name: string;
  /** null when this room's computation failed (see `error`). */
  score: number | null;
  /** The room counts as furnished: no error, and every step has a valid placement (or only optional steps have none). */
  furnished: boolean;
  stepScores: StepScoreOut[];
  steps: StepOut[];
  doors: DoorOut[];
  warnings: string[];
  /** Present when the room needed a fallback (see FallbackOut). */
  fallback?: FallbackOut;
  /** Present when the room did without an optional step (fallbacks.json `optional`, e.g. no dining table in a 1-room apartment). */
  missingOptional?: { pieces: { furnitureName: string; id: string; label: string }[]; penaltyPoints: number; scoreBeforePenalty: number };
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

/** Engine wants CCW winding. Also strips CAD/model noise (sub-decimetre spur
 *  edges and tiny notches) via the engine's shared simplifier, so a visually
 *  rectangular room isn't left with fake ~0.1 m corners that defeat placement. */
function normalizePolygon(pts: Point2D[]): Point2D[] {
  const s = engineSimplify(simplifyPolygon(pts));
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

// ─── Furnishing ───────────────────────────────────────────────────────────────
//
// The search (score-sorted placements, the strict clearance rule), the regular
// pieces first and the fallbacks after, and the reduction of points live in the
// engine (furnisher-engine/src/engine/furnish.ts), shared with the app.

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

    // Steps 1 to 3: the engine furnishes the room (regular pieces first; the
    // next alternative and the fallback pieces only for a room they leave incomplete).
    // normalizePolygon has already simplified the polygon (as the engine would).
    const furnished = furnishRoom(room, aptType, { polygonSimplified: true });
    const opts = furnished.options;
    let result = furnished.result;
    const bestGenIdx2 = furnished.bestGenIndices;
    const maps2 = furnished.sortedToGen;

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
        currentResult = runRoomPipelineAt(room, aptType, runSels, opts);
        const { bestGenIndices: newBest, sortedToGen: newMaps } =
          sortOptionsByScore(room, aptType, currentResult.steps, opts);
        currentMaps = newMaps;
        // Update best gen indices for remaining steps.
        for (let j = i + 1; j < result.steps.length; j++) {
          resolvedGenIdx[j] = newBest[j];
        }
      }
      result = currentResult;
    }

    // Score this room; a fallback costs its reduction of points.
    const { score, roomScore, furnished: roomIsFurnished, missingOptional } =
      scoreFurnishedRoom(er.name, result, furnished.fallback, aptType, fallbacksFor(opts));
    const fb: Omit<FallbackOut, "scoreBeforePenalty"> | null = furnished.fallback
      ? {
          id: furnished.fallback.id,
          label: furnished.fallback.label,
          penaltyPoints: furnished.fallback.penaltyPoints,
          pieces: furnished.fallback.pieces.map(p => ({ furnitureName: p.furnitureName, replaces: p.replaces })),
        }
      : null;
    const replacedBy = new Map((fb?.pieces ?? []).map(p => [p.furnitureName, p.replaces]));

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
        ...(replacedBy.has(s.furnitureName) ? { replaces: replacedBy.get(s.furnitureName) } : {}),
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

    return {
      name: er.name, score, furnished: roomIsFurnished, stepScores, steps, doors, warnings: result.warnings,
      ...(fb ? { fallback: { ...fb, scoreBeforePenalty: roomScore.score } } : {}),
      ...(missingOptional ? { missingOptional } : {}),
    };
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
        furnished: false,
        stepScores: [],
        steps: [],
        doors: [],
        warnings: [],
        error: String((err && (err as Error).message) || err),
      };
    }
  });

  return { aptType, rooms: roomsOut, apartment: apartmentOf(req.rooms, roomsOut) };
}

/** The room's weight in the apartment score: its `area` when the request gives one, else its polygon's area. */
export function roomArea(r: RoomInput): number {
  return typeof r.area === "number" ? r.area : Math.abs(polygonSignedArea(r.polygon));
}

/** The apartment's score (area-weighted, every room of the request) and whether every room counts as furnished. */
export function apartmentOf(inputs: RoomInput[], rooms: Pick<RoomOut, "score" | "furnished">[]) {
  return summarizeApartment(rooms.map((r, i) => ({ score: r.score, area: roomArea(inputs[i]), furnished: r.furnished })));
}
