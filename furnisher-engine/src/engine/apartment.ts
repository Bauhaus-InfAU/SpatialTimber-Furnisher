// ─── Apartment-level furnishing ─────────────────────────────────────────────
//
// ONE entry point for furnishing a whole apartment: `furnishApartment(request)`.
// Callers (the CLI / batch runner in furnisher-for-rhino/engine-cli, the app's
// archive browser) all go through it, so the apartment-level rules hold
// everywhere:
//   - room names resolved (numbered "Children", "Open kitchen" → Kitchen),
//     polygons normalised (CCW, CAD noise stripped), doors assigned to every
//     room within ADJACENT_DOOR_THRESHOLD;
//   - open kitchens detected once for the apartment (explicit flag / subtype /
//     name / geometry, see openKitchen.ts) and their openings expressed on the
//     normalised polygons; door points on an opening become passages (no swing);
//   - every room furnished by furnishRoom (furnish.ts): the regular pieces,
//     then other positions, the other alternative and the fallback pieces of
//     fallbacks.json (never for a modular kitchen step); scored by
//     scoreFurnishedRoom (penalty points, optional steps, overlaps); the
//     caller's selections replayed with downstream re-runs;
//   - open kitchens: the counter stays inside the kitchen (kitchenFlex.ts);
//     then the optional bar with stools reserved in the living room across
//     the opening (dropped if the living room loses by it);
//   - per-room error isolation: a failing room comes back with score null;
//   - the apartment's score and "every room furnished" (summarizeApartment),
//     after the bar.
// All geometry is in metres. Moved here from the CLI's core.ts.
//
// NOTE: the engine emits many `[placer] ...` debug lines via console.log at
// runtime. Callers whose stdout is a JSON channel should silence console.log.

import { getDoorRectangles, doorWidth, simplifyPolygon as engineSimplify } from "./placer";
import { runRoomPipelineAt } from "./pipeline";
import { furnishRoom, scoreFurnishedRoom, sortOptionsByScore, summarizeApartment, fallbacksFor } from "./furnish";
import type { FurnishOptions, RoomFallback, ApartmentSummary } from "./furnish";
import type { FallbackSet } from "../library/types";
import { detectOpenKitchens, openKitchenHint, isOpenKitchenName, splitPassages } from "./openKitchen";
import type { OpenKitchenResult } from "./openKitchen";
import { planKitchenBars } from "./kitchenBar";
import type { RoomName, Point2D, Room } from "../layout/types";
import type { PlacementOption, PipelineWithOptions } from "./types";

// ─── Wire shapes ─────────────────────────────────────────────────────────────

export interface RoomInput {
  name: string;
  polygon: Point2D[];
  windows?: Point2D[];
  /**
   * Room subtype from the caller (Building Composer). Read for kitchens only:
   * "Open kitchen" → open, "Kitchen" → closed (case-insensitive). Anything
   * else, or absent → decided by geometry (see engine/openKitchen.ts).
   */
  subtype?: string | null;
  /** Explicit open-kitchen flag; beats subtype, name and geometry. */
  open?: boolean | null;
  /** Floor area (m²), the room's weight in the apartment score; default: the polygon's area. */
  area?: number;
}

export interface ApartmentRequest {
  rooms: RoomInput[];
  doors?: Point2D[];
  aptType?: number;
  /** "flat": selections[room]=[flatIdx...] | "variant-position": [vi,pos,...] */
  selectionMode?: "flat" | "variant-position";
  selections?: number[][];
  /**
   * Lay CLOSED kitchens out with the modular placer too (open kitchens always
   * use it). Default false: closed kitchens get the library presets.
   */
  flexibleKitchen?: boolean;
  /**
   * The room polygons were pulled inside their wall thickness while the door
   * and window points stayed on the walls' centre lines: move each point onto
   * the room's own outline (when it is at most WALL_INSET_MAX off it). Default
   * false: points are used as sent (the composer's zero-thickness rooms).
   */
  roomsInsideWalls?: boolean;
  /**
   * Door zones as the quarter circle the leaf sweeps instead of the full square (pieces still keep out of it).
   * Default false: the square, as before. (2026-11-27, compact Swiss bathrooms of Swiss Dwellings.)
   */
  doorSwingArc?: boolean;
}

export interface VariantGroup {
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
  /** The room counts as furnished: no error, every step has a valid placement (or only optional steps have none), no pieces overlap. */
  furnished: boolean;
  stepScores: StepScoreOut[];
  steps: StepOut[];
  doors: DoorOut[];
  warnings: string[];
  /** Present when the room needed a fallback (see FallbackOut). */
  fallback?: FallbackOut;
  /** Present when the room did without an optional step (fallbacks.json `optional`, e.g. no dining table in a 1-room apartment). */
  missingOptional?: { pieces: { furnitureName: string; id: string; label: string }[]; penaltyPoints: number; scoreBeforePenalty: number };
  /** Present when pieces of the room overlap (then the room does not count as furnished). */
  overlaps?: { a: string; b: string; m2: number }[];
  /** Present when the engine threw for this room; other rooms are unaffected. */
  error?: string;
  /** Present (true) on a kitchen furnished as an open kitchen. */
  openKitchen?: true;
  /** Present on an open kitchen and its living room: this room's side of the
   *  opening, as [start, end] pieces of its boundary. */
  openSegments?: [Point2D, Point2D][];
  /** Present on an open kitchen and its living room(s): indices of the rooms
   *  across the opening. Their results depend on each other (bar stools), so
   *  a retry must replace them together. */
  openRooms?: number[];
  /** Door points lying on this room's opening: passages, not doors (no swing). */
  passages?: Point2D[];
  /** Present on an open kitchen that got a bar (also drawn into the Kitchen
   *  step's geometry). The stool zone is reserved out of the living room. */
  bar?: { footprint: Point2D[]; stools: Point2D[][]; stoolZone: Point2D[]; livingRoom: number };
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

/** With `roomsInsideWalls`: a door or window point at most this far off the
 *  room's outline (half the thickest wall, 0.15 m, plus slack) is moved onto
 *  it; points further away belong to another room's wall and stay put. */
const WALL_INSET_MAX = 0.16;

function snapToOutline(p: Point2D, poly: Point2D[]): Point2D {
  let best: Point2D = p;
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q: Point2D = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < min) { min = d; best = q; }
  }
  return min <= WALL_INSET_MAX ? best : p;
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
  if (isOpenKitchenName(raw)) return "Kitchen"; // open-ness is read separately
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

/** Options of `furnishApartment`; every default is the CLI's behaviour. */
export interface FurnishApartmentOptions {
  /** Overrides `request.flexibleKitchen` (closed kitchens on the modular placer). */
  flexibleKitchen?: boolean;
  /** Furniture library to use instead of the default one (the app's customised steps / sizes). */
  library?: FurnishOptions["library"];
  /** Placement order to use instead of the default one (the app's customised steps). */
  pipeline?: FurnishOptions["pipeline"];
  /**
   * Fallback pieces and optional steps (furnish.ts, FurnishOptions.fallbacks). Default:
   * default/fallbacks.json when neither `library` nor `pipeline` is given, otherwise none.
   */
  fallbacks?: FallbackSet | null;
  /** Also return each room's engine room and full pipeline result (all options), as `detail`. */
  detail?: boolean;
}

/**
 * Per request room: the engine room it was furnished as, the full pipeline result,
 * the fallback used and the options it was run with (null when it failed).
 */
export interface ApartmentDetail {
  rooms: ({ room: Room; result: PipelineWithOptions; fallback: RoomFallback | null; options: FurnishOptions; fallbacks: FallbackSet | null } | null)[];
}

export interface ApartmentResult {
  aptType: number;
  rooms: RoomOut[];
  /** The apartment's score (room scores weighted by area) and whether every room counts as furnished. */
  apartment: ApartmentSummary;
  /** Only with `opts.detail`. */
  detail?: ApartmentDetail;
}

/** Furnish a whole apartment (see the header of this file). */
export function furnishApartment(req: ApartmentRequest, opts: FurnishApartmentOptions = {}): ApartmentResult {
  const childCounter = { n: 0 };
  const allDoors = req.doors ?? [];

  const engineRooms = req.rooms.map((r) => {
    const name = resolveRoomName(r.name, childCounter);
    const polygon = normalizePolygon(r.polygon);
    const snap = (p: Point2D) => (req.roomsInsideWalls ? snapToOutline(p, polygon) : p);
    const doors = allDoors
      .filter(d => distPointToPolygon(d, polygon) <= ADJACENT_DOOR_THRESHOLD)
      .map(snap);
    const windows = (r.windows ?? []).map(snap);
    return { name, polygon, doors, windows };
  });

  const aptType = req.aptType ?? inferApartmentType(engineRooms.map(r => r.name));

  // Open kitchens: decided once for the whole apartment. Touching is judged on
  // the request polygons (shared edges are exact there; normalisation snaps
  // each room separately), and the openings are then expressed on the
  // normalised polygons the engine runs on. Batch retries that perturb the
  // coordinates re-detect in their own frame.
  let openInfo: OpenKitchenResult[];
  try {
    openInfo = detectOpenKitchens(engineRooms.map((er, i) => ({
      name: er.name,
      polygon: er.polygon,
      sourcePolygon: req.rooms[i].polygon,
      hint: er.name === "Kitchen"
        ? openKitchenHint(req.rooms[i].name, req.rooms[i].subtype, req.rooms[i].open)
        : undefined,
    })));
  } catch (err) {
    // Never let detection take the apartment down: furnish every room closed.
    const msg = `Open-kitchen detection failed (${String((err && (err as Error).message) || err)}) — rooms furnished as closed`;
    openInfo = engineRooms.map(er => ({
      openKitchen: false,
      openSegments: [],
      gap: 0,
      openRooms: [],
      warnings: er.name === "Kitchen" ? [msg] : [],
    }));
  }

  // A door point on an opening is a passage marker (the composer puts one in
  // the middle of an open-kitchen edge): no door swing on either side.
  const passages: Point2D[][] = engineRooms.map(() => []);
  engineRooms.forEach((er, i) => {
    const o = openInfo[i];
    if (!o.openSegments.length) return;
    const split = splitPassages(er.doors, o.openSegments, o.gap);
    er.doors = split.doors;
    passages[i] = split.passages;
  });

  // normalizePolygon has already simplified every polygon (as the engine would).
  const pipelineOpts: FurnishOptions = {
    flexibleKitchen: opts.flexibleKitchen ?? req.flexibleKitchen === true,
    polygonSimplified: true,
    ...(opts.library ? { library: opts.library } : {}),
    ...(opts.pipeline ? { pipeline: opts.pipeline } : {}),
    ...(opts.fallbacks !== undefined ? { fallbacks: opts.fallbacks } : {}),
  };

  const engineRoomOf = (roomIdx: number, reserved?: Point2D[][]): Room => {
    const er = engineRooms[roomIdx];
    const open = openInfo[roomIdx];
    return {
      name: er.name,
      polygon: er.polygon,
      ...(er.doors.length ? { doors: er.doors } : {}),
      ...(er.windows.length ? { windows: er.windows } : {}),
      ...(open.openSegments.length ? { openSegments: open.openSegments } : {}),
      ...(open.openKitchen ? { openKitchen: true } : {}),
      ...(reserved?.length ? { reserved } : {}),
      ...(req.doorSwingArc ? { doorArc: true } : {}),
    };
  };

  type Computed = { out: RoomOut; result: PipelineWithOptions; room: Room; fallback: RoomFallback | null; options: FurnishOptions };

  const computeRoom = (er: (typeof engineRooms)[number], roomIdx: number, reserved?: Point2D[][]): Computed => {
    const open = openInfo[roomIdx];
    const room = engineRoomOf(roomIdx, reserved);

    const rawSel = req.selections?.[roomIdx] ?? [];
    const hasUserSel = rawSel.some(v => v !== 0);

    // ── Steps 1 to 3: the engine furnishes the room (furnish.ts): regular
    //    pieces first; other positions, the next alternative and the fallback
    //    pieces only for a room they leave incomplete.
    const furnishedRoom = furnishRoom(room, aptType, pipelineOpts);
    const ropts = furnishedRoom.options;
    let result = furnishedRoom.result;
    const bestGenIdx2 = furnishedRoom.bestGenIndices;
    const maps2 = furnishedRoom.sortedToGen;

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
        currentResult = runRoomPipelineAt(room, aptType, runSels, ropts);
        const { bestGenIndices: newBest, sortedToGen: newMaps } =
          sortOptionsByScore(room, aptType, currentResult.steps, ropts);
        currentMaps = newMaps;
        // Update best gen indices for remaining steps.
        for (let j = i + 1; j < result.steps.length; j++) {
          resolvedGenIdx[j] = newBest[j];
        }
      }
      result = currentResult;
    }

    // Score this room; a fallback costs its reduction of points.
    const { score, roomScore, furnished: roomIsFurnished, missingOptional, overlaps } =
      scoreFurnishedRoom(er.name, result, furnishedRoom.fallback, aptType, fallbacksFor(ropts));
    const fb = furnishedRoom.fallback;
    const fallbackOut: FallbackOut | null = fb
      ? {
          id: fb.id,
          label: fb.label,
          penaltyPoints: fb.penaltyPoints,
          pieces: fb.pieces.map(p => ({ furnitureName: p.furnitureName, replaces: p.replaces })),
          scoreBeforePenalty: roomScore.score,
        }
      : null;
    const replacedBy = new Map((fallbackOut?.pieces ?? []).map(p => [p.furnitureName, p.replaces]));

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

    const out: RoomOut = {
      name: er.name,
      score,
      furnished: roomIsFurnished,
      stepScores,
      steps,
      doors,
      warnings: [...open.warnings, ...result.warnings],
      ...(fallbackOut ? { fallback: fallbackOut } : {}),
      ...(missingOptional ? { missingOptional } : {}),
      ...(overlaps.length ? { overlaps } : {}),
      ...(open.openKitchen ? { openKitchen: true as const } : {}),
      ...(open.openSegments.length ? { openSegments: open.openSegments } : {}),
      ...(open.openRooms.length ? { openRooms: open.openRooms } : {}),
      ...(passages[roomIdx].length ? { passages: passages[roomIdx] } : {}),
    };
    return { out, result, room, fallback: furnishedRoom.fallback, options: ropts };
  };

  const failed = (er: (typeof engineRooms)[number], roomIdx: number, err: unknown): RoomOut => ({
    name: er.name,
    score: null,
    furnished: false,
    stepScores: [],
    steps: [],
    doors: [],
    warnings: [],
    error: String((err && (err as Error).message) || err),
    ...(openInfo[roomIdx].openRooms.length ? { openRooms: openInfo[roomIdx].openRooms } : {}),
  });

  // Per-room error isolation: one bad room (e.g. polygon-clipping's "Unable to
  // complete output ring" on a degenerate polygon) must not kill the whole
  // apartment. Failed rooms come back with score: null and an error string.
  const computed: (Computed | null)[] = [];
  const roomsOut: RoomOut[] = engineRooms.map((er, roomIdx) => {
    try {
      const c = computeRoom(er, roomIdx);
      computed[roomIdx] = c;
      return c.out;
    } catch (err) {
      computed[roomIdx] = null;
      return failed(er, roomIdx, err);
    }
  });

  // ── Open kitchens, after every room is furnished: the bar, reserving floor
  //    in the living room across the opening.
  //
  //    Bar: its stool zone is reserved and the living room re-furnished; a bar
  //    that costs the living room a step or any score (or its "furnished") is
  //    dropped (the kitchen keeps its counter either way). tryBar works on the
  //    given rooms and returns the outcome without committing it.
  type BarOutcome = { li: number; living: Computed; plan: ReturnType<typeof planKitchenBars>[number] };
  // A step that had a place and has none now, or a room that counted as
  // furnished and does not now (e.g. pieces overlapping).
  const lostAny = (from: Computed, to: Computed) =>
    (from.out.furnished && !to.out.furnished) ||
    from.out.steps.some((s, i) => s.optionCount > 0 && (to.out.steps[i]?.optionCount ?? 0) === 0);
  const tryBar = (ki: number, kc: Computed, rooms: (Computed | null)[]): BarOutcome | null => {
    if (!openInfo[ki].openSegments.length) return null;
    const step = kc.result.steps[0];
    if (!step?.selected) return null;
    const livings = openInfo[ki].openRooms
      .filter(li => rooms[li])
      .map(li => ({ index: li, room: rooms[li]!.room }));
    const plans = planKitchenBars(kc.room, step.selected.placed, livings, openInfo[ki].gap);
    for (const plan of plans.slice(0, 4)) {
      const li = plan.livingIndex;
      const base = rooms[li]!;
      const reserved = [...(base.room.reserved ?? []), plan.stoolZone];
      let withBar: Computed;
      try {
        withBar = computeRoom(engineRooms[li], li, reserved);
      } catch {
        continue;
      }
      if (lostAny(base, withBar) || (withBar.out.score ?? 0) < (base.out.score ?? 0)) continue;
      return { li, living: withBar, plan };
    }
    return null;
  };
  const commitBar = (ki: number, bar: BarOutcome) => {
    computed[bar.li] = bar.living;
    roomsOut[bar.li] = bar.living.out;
    const kOut = roomsOut[ki];
    kOut.steps[0] = { ...kOut.steps[0], geometry: [...kOut.steps[0].geometry, ...bar.plan.geometry] };
    kOut.bar = { footprint: bar.plan.footprint, stools: bar.plan.stools, stoolZone: bar.plan.stoolZone, livingRoom: bar.li };
  };

  engineRooms.forEach((_er, ki) => {
    const kc = computed[ki];
    if (!kc || !openInfo[ki].openKitchen) return;
    try {
      const bar = tryBar(ki, kc, computed);
      if (bar) commitBar(ki, bar);
    } catch (err) {
      roomsOut[ki].warnings.push(`Open kitchen: bar skipped (${String((err && (err as Error).message) || err)})`);
    }
  });

  const apartment = apartmentSummaryOf(req.rooms, roomsOut);
  if (opts.detail) {
    return {
      aptType, rooms: roomsOut, apartment,
      detail: {
        rooms: computed.map((c) => (c
          ? { room: c.room, result: c.result, fallback: c.fallback, options: c.options, fallbacks: fallbacksFor(c.options) }
          : null)),
      },
    };
  }
  return { aptType, rooms: roomsOut, apartment };
}

/** The room's weight in the apartment score: its `area` when the request gives one, else its polygon's area. */
export function roomArea(r: RoomInput): number {
  return typeof r.area === "number" ? r.area : Math.abs(polygonSignedArea(r.polygon));
}

/**
 * The apartment's score (area-weighted, every room of the request) and whether
 * every room counts as furnished (summarizeApartment). The batch runner calls
 * it again after its retries.
 */
export function apartmentSummaryOf(inputs: RoomInput[], rooms: Pick<RoomOut, "score" | "furnished">[]): ApartmentSummary {
  return summarizeApartment(rooms.map((r, i) => ({ score: r.score, area: roomArea(inputs[i]), furnished: r.furnished })));
}
