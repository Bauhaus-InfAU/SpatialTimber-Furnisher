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
//   - every room furnished with the strict pipeline, options sorted by room
//     score, the caller's selections replayed with downstream re-runs;
//   - kitchens first; an open kitchen's counter may continue past the opening
//     as plain worktop (kitchenFlex.ts), its floor reserved in the living room
//     (kept only if the living room loses nothing, else the kitchen is redone
//     without it); then the optional bar with stools reserved in the living
//     room across the opening (same rule);
//   - per-room error isolation: a failing room comes back with score null.
// All geometry is in metres. Moved here unchanged from the CLI's core.ts.
//
// NOTE: the engine emits many `[placer] ...` debug lines via console.log at
// runtime. Callers whose stdout is a JSON channel should silence console.log.

import { getDoorRectangles, doorWidth, simplifyPolygon as engineSimplify } from "./placer";
import { runRoomPipelineSteps } from "./pipeline";
import type { PipelineOptions } from "./pipeline";
import { detectOpenKitchens, openKitchenHint, isOpenKitchenName, splitPassages } from "./openKitchen";
import type { OpenKitchenResult } from "./openKitchen";
import { planKitchenBars } from "./kitchenBar";
import { scoreRoom } from "./scorer";
import type { RoomName, Point2D, Room } from "../layout/types";
import type { PlacementOption, StepOptions, PipelineWithOptions } from "./types";

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
  /** Present on an open kitchen whose counter continues past the opening into
   *  a living room (drawn with the Kitchen step). `zones` (footprint and work
   *  zone of the worktop past the opening) are reserved out of that room. */
  extension?: { zones: Point2D[][]; livingRoom: number };
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

// ─── Strict clearance pipeline ───────────────────────────────────────────────
//
// The engine's shared all-options runner (runRoomPipelineSteps) with the CLI's
// settings: the strict clearance filter reports when it has to fall back, and
// closed kitchens use the library presets unless the request asks for the
// modular placer. Open kitchens (Room.openSegments) and the living-room
// opening filter are handled inside the engine, so they hold in every re-run
// that sortOptionsByScore and the selection replay make.

function runStrictPipelineAt(
  room: Room,
  aptType: number,
  selectedIndices: number[],
  opts: PipelineOptions,
): PipelineWithOptions {
  return runRoomPipelineSteps(room, aptType, selectedIndices, opts);
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
  opts: PipelineOptions,
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
      const r  = runStrictPipelineAt(room, aptType, sels, opts);
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

/** Options of `furnishApartment`; every default is the CLI's behaviour. */
export interface FurnishApartmentOptions {
  /** Overrides `request.flexibleKitchen` (closed kitchens on the modular placer). */
  flexibleKitchen?: boolean;
  /** Furniture library to use instead of the default one (the app's customised steps / sizes). */
  library?: PipelineOptions["library"];
  /** Placement order to use instead of the default one (the app's customised steps). */
  pipeline?: PipelineOptions["pipeline"];
  /** Also return each room's engine room and full pipeline result (all options), as `detail`. */
  detail?: boolean;
}

/** Per request room: the engine room it was furnished as and the full pipeline result (null when it failed). */
export interface ApartmentDetail {
  rooms: ({ room: Room; result: PipelineWithOptions } | null)[];
}

export interface ApartmentResult {
  aptType: number;
  rooms: RoomOut[];
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

  const pipelineOpts: PipelineOptions = {
    flexibleKitchen: opts.flexibleKitchen ?? req.flexibleKitchen === true,
    warnOnStrictFallback: true,
    ...(opts.library ? { library: opts.library } : {}),
    ...(opts.pipeline ? { pipeline: opts.pipeline } : {}),
  };

  // An open kitchen sees the living rooms across its opening (Room.extendInto)
  // so a short counter may continue into one as plain worktop; `noExtend`
  // turns that off (the fallback when the living room loses by it).
  const engineRoomOf = (roomIdx: number, reserved?: Point2D[][], noExtend = false): Room => {
    const er = engineRooms[roomIdx];
    const open = openInfo[roomIdx];
    const extendInto = !noExtend && er.name === "Kitchen" && open.openKitchen && open.openSegments.length
      ? open.openRooms.map((li) => ({ index: li, room: engineRoomOf(li) }))
      : [];
    return {
      name: er.name,
      polygon: er.polygon,
      ...(er.doors.length ? { doors: er.doors } : {}),
      ...(er.windows.length ? { windows: er.windows } : {}),
      ...(open.openSegments.length ? { openSegments: open.openSegments } : {}),
      ...(open.openKitchen ? { openKitchen: true } : {}),
      ...(reserved?.length ? { reserved } : {}),
      ...(extendInto.length ? { extendInto } : {}),
    };
  };

  type Computed = { out: RoomOut; result: PipelineWithOptions; room: Room };

  const computeRoom = (er: (typeof engineRooms)[number], roomIdx: number, reserved?: Point2D[][], noExtend = false): Computed => {
    const open = openInfo[roomIdx];
    const room = engineRoomOf(roomIdx, reserved, noExtend);

    const rawSel = req.selections?.[roomIdx] ?? [];
    const hasUserSel = rawSel.some(v => v !== 0);

    // ── Step 1: discover options ──────────────────────────────────────────────
    let result = runStrictPipelineAt(room, aptType, [], pipelineOpts);

    // ── Step 2: sort + capture gen-index maps ─────────────────────────────────
    const { bestGenIndices } = sortOptionsByScore(room, aptType, result.steps, pipelineOpts);

    // ── Step 3: re-run with best gen indices so downstream options are correct
    result = runStrictPipelineAt(room, aptType, bestGenIndices, pipelineOpts);
    const { bestGenIndices: bestGenIdx2, sortedToGen: maps2 } =
      sortOptionsByScore(room, aptType, result.steps, pipelineOpts);

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
        currentResult = runStrictPipelineAt(room, aptType, runSels, pipelineOpts);
        const { bestGenIndices: newBest, sortedToGen: newMaps } =
          sortOptionsByScore(room, aptType, currentResult.steps, pipelineOpts);
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

    const out: RoomOut = {
      name: er.name,
      score: roomScore.score,
      stepScores,
      steps,
      doors,
      warnings: [...open.warnings, ...result.warnings],
      ...(open.openKitchen ? { openKitchen: true as const } : {}),
      ...(open.openSegments.length ? { openSegments: open.openSegments } : {}),
      ...(open.openRooms.length ? { openRooms: open.openRooms } : {}),
      ...(passages[roomIdx].length ? { passages: passages[roomIdx] } : {}),
    };
    return { out, result, room };
  };

  const failed = (er: (typeof engineRooms)[number], roomIdx: number, err: unknown): RoomOut => ({
    name: er.name,
    score: null,
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

  // ── Open kitchens, after every room is furnished: the worktop extension and
  //    the bar, both reserving floor in the living room across the opening.
  //
  //    Bar: its stool zone is reserved and the living room re-furnished; a bar
  //    that costs the living room a step or any score is dropped (the kitchen
  //    keeps its counter either way). tryBar works on the given rooms and
  //    returns the outcome without committing it.
  //
  //    Worktop extension: a kitchen whose chosen counter runs on past the
  //    opening (PlacedFurniture.extension) is weighed against the same kitchen
  //    furnished without extensions — each with the living room re-furnished
  //    around it (extension floor reserved) and then its best bar. The
  //    extension is kept only if the living room ends up with no step lost and
  //    no less score than without it; otherwise the kitchen is redone without.
  type BarOutcome = { li: number; living: Computed; plan: ReturnType<typeof planKitchenBars>[number] };
  const lostAny = (from: Computed, to: Computed) =>
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
    const ext = kc.result.steps[0]?.selected?.placed.extension;

    if (ext) {
      const li = ext.room;
      const base = computed[li];
      // With the extension: living room around it, then its bar.
      let withExt: { living: Computed; bar: BarOutcome | null } | null = null;
      if (base) {
        try {
          const living = computeRoom(engineRooms[li], li, [...(base.room.reserved ?? []), ...ext.zones]);
          const rooms = [...computed];
          rooms[li] = living;
          let bar: BarOutcome | null = null;
          try { bar = tryBar(ki, kc, rooms); } catch { bar = null; }
          withExt = { living, bar };
        } catch {
          withExt = null;
        }
      }
      // Without: the kitchen redone without extensions, then its bar.
      let plain: Computed | null = null;
      let plainErr: unknown = null;
      try {
        plain = computeRoom(engineRooms[ki], ki, undefined, true);
      } catch (err) {
        plainErr = err;
      }
      let plainBar: BarOutcome | null = null;
      if (plain) {
        try { plainBar = tryBar(ki, plain, computed); } catch { plainBar = null; }
      }
      const livingOf = (o: { living: Computed; bar: BarOutcome | null }) =>
        o.bar && o.bar.li === li ? o.bar.living : o.living;
      const finalWith = withExt ? livingOf(withExt) : null;
      const finalPlain = base ? (plainBar && plainBar.li === li ? plainBar.living : base) : null;
      const keep = !!withExt && !!finalWith && (!plain || !finalPlain
        || (!lostAny(finalPlain, finalWith) && (finalWith.out.score ?? 0) >= (finalPlain.out.score ?? 0)));
      if (keep && withExt) {
        computed[li] = withExt.living;
        roomsOut[li] = withExt.living.out;
        roomsOut[ki].extension = { zones: ext.zones, livingRoom: li };
        if (withExt.bar) commitBar(ki, withExt.bar);
        return;
      }
      if (!plain) {
        computed[ki] = null;
        roomsOut[ki] = failed(engineRooms[ki], ki, plainErr);
        return;
      }
      plain.out.warnings.push("Open kitchen: worktop extension into the living room dropped (the living room would lose by it)");
      computed[ki] = plain;
      roomsOut[ki] = plain.out;
      if (plainBar) commitBar(ki, plainBar);
      return;
    }

    try {
      const bar = tryBar(ki, kc, computed);
      if (bar) commitBar(ki, bar);
    } catch (err) {
      roomsOut[ki].warnings.push(`Open kitchen: bar skipped (${String((err && (err as Error).message) || err)})`);
    }
  });

  if (opts.detail) {
    return { aptType, rooms: roomsOut, detail: { rooms: computed.map((c) => (c ? { room: c.room, result: c.result } : null)) } };
  }
  return { aptType, rooms: roomsOut };
}
