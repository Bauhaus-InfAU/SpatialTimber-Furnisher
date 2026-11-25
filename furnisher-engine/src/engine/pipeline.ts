// ─── Room Pipeline ────────────────────────────────────────────────────────────
//
// Reads the parsed pipeline definition and runs the full furniture placement
// chain for a single room:
//   place piece N → subtract footprint → feed roomRdc into piece N+1
//
// One step generator (generateStepOptions) serves every runner (runRoomPipeline,
// runRoomPipelineAt, runRoomPipelineSteps; furnishRoom in furnish.ts and
// furnishApartment in apartment.ts run the room through them), so a rule added there (flexible / open kitchens, the strict clearance
// filter, the living-room opening filter) holds for every consumer.

import type { Point2D, Room, RoomName } from "../layout/types";
import type { FallbackPiece, FurnitureCategory, FurnitureLibrary, Pipeline } from "../library/types";
import { defaultLibrary, defaultPipeline } from "../library/loader";
import { roomNameToCategory, resolvePipelineStep } from "../library/lookup";
import type { PlacementOption } from "./types";
import type { PipelineStep, PipelineResult, StepOptions, PipelineWithOptions } from "./types";
import { getAllPlacements, getDoorRectangles, simplifyPolygon } from "./placer";
import { getFlexibleKitchenPlacements, passageOk } from "./kitchenFlex";
import { backsOntoOpening, polySegDist } from "./openKitchen";

/** A freestanding living-room piece keeps this far (metres) off a kitchen opening. */
const MOUTH_CLEAR = 0.6;
import { subtractPolygon } from "./subtraction";

export type { PipelineStep, PipelineResult, StepOptions, PipelineWithOptions };

/** Options shared by both pipeline entry points. */
export interface PipelineOptions {
  library?: FurnitureLibrary;
  pipeline?: Pipeline;
  /**
   * Build the kitchen from 0.6 m modules laid along the room's own walls
   * (see kitchenFlex.ts) instead of dropping in the library's preset block.
   * The preset route is used for every other room either way. Open kitchens
   * (Room.openSegments) always use the modular placer, whatever this says.
   */
  flexibleKitchen?: boolean;
  /**
   * Pieces that stand in for regular ones (a fallback of default/fallbacks.json,
   * see furnish.ts). A step whose alternative is replaced uses the piece; every
   * other step takes the first alternative the library has for this apartment
   * type (resolveStep). Never read for a kitchen built from modules (open
   * kitchens, flexibleKitchen): those never fall back to a preset block.
   */
  pieces?: FallbackPiece[];
  /**
   * The caller has already passed the polygon through simplifyPolygon (the CLI
   * and furnishApartment do so once per room, also for the door output);
   * simplifying it a second time can still move a vertex, so it is left as it is.
   */
  polygonSimplified?: boolean;
}

// ─── Freestanding furniture ───────────────────────────────────────────────────
//
// Pieces in this set bypass the walls_must filter and can stand freely on any
// edge of the current polygon (e.g. a dining table in the living room).
const FREESTANDING_FURNITURE = new Set<string>(["Dining"]);

// ─── Section lookup ───────────────────────────────────────────────────────────

function roomNameToSection(name: RoomName): string {
  if (name.startsWith("Children")) return "Children";
  return name;
}

// ─── Strict clearance rule (ground truth, shared by every consumer) ──────────
//
// Subtracting each placed piece's cutouts stops a NEW piece's footprint from
// landing on a prior footprint or inside a prior clearance zone. It does NOT
// stop a new piece's *clearance* zone (largeBbox) from engulfing an already
// placed piece's *footprint* — e.g. a freestanding dining table dropped on top
// of the sofa. This axis-aligned overlap test lets the pipeline reject those
// options so the engine never returns an overlapping layout.
function aabbOverlap(pts1: Point2D[], pts2: Point2D[]): boolean {
  if (!pts1.length || !pts2.length) return false;
  const xs1 = pts1.map((p) => p[0]), ys1 = pts1.map((p) => p[1]);
  const xs2 = pts2.map((p) => p[0]), ys2 = pts2.map((p) => p[1]);
  const eps = 1e-3; // 1 mm — don't reject pieces that merely share a wall edge
  return (
    Math.max(...xs1) > Math.min(...xs2) + eps &&
    Math.max(...xs2) > Math.min(...xs1) + eps &&
    Math.max(...ys1) > Math.min(...ys2) + eps &&
    Math.max(...ys2) > Math.min(...ys1) + eps
  );
}

// ─── Shared step generator ────────────────────────────────────────────────────

/** Room-level inputs every step of one pipeline run shares. */
interface RoomContext {
  room: Room;
  aptType: number;
  lib: FurnitureLibrary;
  category: FurnitureCategory;
  originalWalls: [Point2D, Point2D][];
  opts?: PipelineOptions;
}

/** The polygons and footprints left by the steps placed so far. */
interface ChainState {
  roomFullChain: Point2D[];
  roomRdcChain: Point2D[];
  placedSmallBboxes: Point2D[][];
}

interface GeneratedStep {
  furnitureName: string;
  /** Every valid option, best first. Empty when the step is skipped. */
  options: PlacementOption[];
  warnings: string[];
}

function makeContext(room: Room, aptType: number, opts?: PipelineOptions): RoomContext {
  const originalWalls: [Point2D, Point2D][] = room.polygon.map(
    (a, i) => [a, room.polygon[(i + 1) % room.polygon.length]],
  );
  return {
    room,
    aptType,
    lib: opts?.library ?? defaultLibrary,
    category: roomNameToCategory(room.name),
    originalWalls,
    opts,
  };
}

function initialChain(room: Room): ChainState {
  let roomFullChain: Point2D[] = room.polygon;
  let roomRdcChain: Point2D[] = room.polygon;
  for (const rect of getDoorRectangles(room)) roomRdcChain = subtractPolygon(roomRdcChain, rect);
  // Floor a neighbour has claimed (e.g. bar stools) is neither footprint nor
  // clearance space for this room's furniture.
  for (const area of room.reserved ?? []) {
    roomFullChain = subtractPolygon(roomFullChain, area);
    roomRdcChain  = subtractPolygon(roomRdcChain,  area);
  }
  return { roomFullChain, roomRdcChain, placedSmallBboxes: [] };
}

function applySelection(state: ChainState, selected: PlacementOption): void {
  state.placedSmallBboxes.push(selected.placed.transformedSmallBbox as Point2D[]);
  state.roomFullChain = subtractPolygon(state.roomFullChain, selected.placed.smallCutout);
  state.roomRdcChain  = subtractPolygon(state.roomRdcChain,  selected.placed.largeCutout);
}

/**
 * All options for one pipeline step, given what is already placed.
 *
 *   • Kitchen step of an open kitchen → modular placer under the open-kitchen
 *     rules only; when that finds nothing the step has no options (warning).
 *   • Kitchen step with opts.flexibleKitchen → modular placer.
 *   • Everything else → library presets. In a living room with an opening,
 *     wall-backed pieces may not back onto it (kept unfiltered, with a
 *     warning, rather than lose the piece). With `strict`, options whose
 *     clearance would engulf a placed footprint are dropped (again falling back
 *     to the unfiltered list rather than lose the piece).
 */
function generateStepOptions(
  ctx: RoomContext,
  state: ChainState,
  alternatives: string[],
  strict: boolean,
): GeneratedStep {
  const { room, aptType, lib, category, opts } = ctx;
  const warnings: string[] = [];
  const openSegs = room.openSegments ?? [];
  const isKitchenStep = category === "Kitchen" && alternatives.includes("Kitchen");

  const openKitchen = !!room.openKitchen || openSegs.length > 0;
  if (isKitchenStep && (openKitchen || opts?.flexibleKitchen)) {
    const flex = getFlexibleKitchenPlacements(room, aptType, "Kitchen", {
      collisionPolygon: state.roomFullChain,
      edgePolygon:      state.roomRdcChain,
    });
    if (flex.length) return { furnitureName: "Kitchen", options: flex, warnings };
    // Open kitchens never fall back to the library presets (a rigid block that
    // ignores the opening): no modular layout is an honest "no kitchen".
    warnings.push(openKitchen
      ? `Open kitchen: no modular counter of ≥ 4 modules fits on its walls — skipped`
      : `No valid placement found for "Kitchen" — skipped`);
    return { furnitureName: "Kitchen", options: [], warnings };
  }

  const resolved = resolvePipelineStep(lib, aptType, category, alternatives, opts?.pieces);
  const entry = resolved ? resolved.entry : null;
  const resolvedName = resolved ? resolved.name : "";
  if (!entry) {
    warnings.push(
      `No library entry for [${alternatives.join(" | ")}] in ${category} apt ${aptType} — skipped`,
    );
    return { furnitureName: alternatives.join(" | "), options: [], warnings };
  }

  const freestanding = FREESTANDING_FURNITURE.has(resolvedName);
  let raw = getAllPlacements(room, entry, {
    referenceWalls:   freestanding ? undefined : ctx.originalWalls,
    collisionPolygon: state.roomFullChain,
    edgePolygon:      state.roomRdcChain,
  });

  // Living room beside an open kitchen: keep the opening open. Nothing
  // wall-backed backs onto it, a freestanding piece (dining table) keeps
  // MOUTH_CLEAR off it, and OPEN_PASSAGE of it stays free of footprints
  // (this piece, the ones placed before it, and reserved bar stools).
  if (openSegs.length > 0 && !isKitchenStep && raw.length > 0) {
    const others = [...state.placedSmallBboxes, ...(room.reserved ?? [])];
    const clear = raw.filter((o) => {
      const fp = o.placed.transformedSmallBbox as Point2D[];
      if (!freestanding && backsOntoOpening(o.placed, openSegs)) return false;
      if (freestanding && openSegs.some(([a, b]) => polySegDist(fp, a, b) < MOUTH_CLEAR)) return false;
      return passageOk(openSegs, [...others, fp]);
    });
    if (clear.length > 0) raw = clear;
    else warnings.push(`"${resolvedName}": every placement crowds the kitchen opening — using them anyway`);
  }

  if (raw.length === 0) {
    warnings.push(`No valid placement found for "${resolvedName}" — skipped`);
    return { furnitureName: resolvedName, options: [], warnings };
  }
  if (!strict) return { furnitureName: resolvedName, options: raw, warnings };

  const strictOptions = raw.filter(
    (opt) => !state.placedSmallBboxes.some((prev) => aabbOverlap(opt.placed.transformedBbox as Point2D[], prev)),
  );
  if (strictOptions.length > 0) return { furnitureName: resolvedName, options: strictOptions, warnings };
  warnings.push(`"${resolvedName}": all placements interfere with clearance zones — using best available`);
  return { furnitureName: resolvedName, options: raw, warnings };
}

// ─── Pipeline runner ──────────────────────────────────────────────────────────

/**
 * Run the full placement pipeline for a room.
 *
 * Pass `opts.library` / `opts.pipeline` to override the defaults at runtime
 * (e.g. for in-session edits or custom presets).
 */
export function runRoomPipeline(
  room: Room,
  aptType: number,
  opts?: PipelineOptions,
): PipelineResult {
  if (!opts?.polygonSimplified) room = { ...room, polygon: simplifyPolygon(room.polygon) }; // strip model noise
  const pipeline = opts?.pipeline ?? defaultPipeline;
  const steps    = pipeline[roomNameToSection(room.name)] ?? [];
  const ctx      = makeContext(room, aptType, opts);
  const state    = initialChain(room);

  const placed: PipelineStep[] = [];
  const warnings: string[]     = [];

  for (const alternatives of steps) {
    const gen = generateStepOptions(ctx, state, alternatives, false);
    warnings.push(...gen.warnings);
    if (!gen.options.length) continue;
    const first = gen.options[0];
    placed.push({ furnitureName: gen.furnitureName, placed: first.placed });
    applySelection(state, first);
  }

  return { steps: placed, warnings };
}

// ─── All-options pipeline (interactive exploration) ───────────────────────────

/**
 * The all-options runner on `room` exactly as given (no polygon
 * simplification). `selectedIndices[i]` picks one placement for step i;
 * subsequent steps see the polygon that results from subtracting it.
 * Shared by runRoomPipelineAt and the Rhino CLI, which normalises polygons
 * itself and re-runs this many times while ranking options.
 */
export function runRoomPipelineSteps(
  room: Room,
  aptType: number,
  selectedIndices: number[],
  opts?: PipelineOptions,
): PipelineWithOptions {
  const pipeline = opts?.pipeline ?? defaultPipeline;
  const steps    = pipeline[roomNameToSection(room.name)] ?? [];
  const ctx      = makeContext(room, aptType, opts);
  const state    = initialChain(room);

  const resultSteps: StepOptions[] = [];
  const warnings:    string[]      = [];

  for (let i = 0; i < steps.length; i++) {
    const gen = generateStepOptions(ctx, state, steps[i], true);
    warnings.push(...gen.warnings);
    if (gen.options.length === 0) {
      resultSteps.push({ furnitureName: gen.furnitureName, allOptions: [], selectedIndex: -1, selected: null });
      continue;
    }
    const allOptions    = gen.options;
    const selectedIndex = Math.min(Math.max(selectedIndices[i] ?? 0, 0), allOptions.length - 1);
    const selected      = allOptions[selectedIndex];
    resultSteps.push({ furnitureName: gen.furnitureName, allOptions, selectedIndex, selected });
    applySelection(state, selected);
  }

  return { steps: resultSteps, warnings };
}

/**
 * Run the pipeline exposing every valid placement at every step.
 *
 * `selectedIndices[i]` picks one placement for step i; subsequent steps see the
 * polygon that results from subtracting the chosen placement.
 */
export function runRoomPipelineAt(
  room: Room,
  aptType: number,
  selectedIndices: number[],
  opts?: PipelineOptions,
): PipelineWithOptions {
  if (!opts?.polygonSimplified) room = { ...room, polygon: simplifyPolygon(room.polygon) }; // strip model noise
  return runRoomPipelineSteps(room, aptType, selectedIndices, opts);
}
