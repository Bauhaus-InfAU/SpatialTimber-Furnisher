// ─── Room Pipeline ────────────────────────────────────────────────────────────
//
// Reads the parsed pipeline definition and runs the full furniture placement
// chain for a single room:
//   place piece N → subtract footprint → feed roomRdc into piece N+1

import type { Point2D, Room, RoomName } from "../layout/types";
import type { FurnitureLibrary, Pipeline } from "../library/types";
import { defaultLibrary, defaultPipeline } from "../library/loader";
import { roomNameToCategory, findFurnitureByName } from "../library/lookup";
import type { PlacementOptions } from "./types";
import type { PipelineStep, PipelineResult, StepOptions, PipelineWithOptions } from "./types";
import { placeFurniture, getAllPlacements, getDoorRectangles, simplifyPolygon } from "./placer";
import { subtractPolygon } from "./subtraction";

export type { PipelineStep, PipelineResult, StepOptions, PipelineWithOptions };

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
// options so the engine never returns an overlapping layout (previously this
// lived only in the Rhino CLI, so the app — a pure consumer — didn't get it).
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
  opts?: { library?: FurnitureLibrary; pipeline?: Pipeline },
): PipelineResult {
  room = { ...room, polygon: simplifyPolygon(room.polygon) }; // strip model noise
  const lib      = opts?.library   ?? defaultLibrary;
  const pipeline = opts?.pipeline  ?? defaultPipeline;
  const section  = roomNameToSection(room.name);
  const steps    = pipeline[section] ?? [];
  const category = roomNameToCategory(room.name);

  const originalWalls: [Point2D, Point2D][] = [];
  for (let i = 0; i < room.polygon.length; i++) {
    const a = room.polygon[i];
    const b = room.polygon[(i + 1) % room.polygon.length];
    originalWalls.push([a, b]);
  }

  let roomFullChain: Point2D[] = room.polygon;
  const _doorRects = getDoorRectangles(room);
  let roomRdcChain: Point2D[] = room.polygon;
  for (const rect of _doorRects) roomRdcChain = subtractPolygon(roomRdcChain, rect);

  const placed: PipelineStep[] = [];
  const warnings: string[]     = [];

  for (const alternatives of steps) {
    let entry = null;
    let resolvedName = "";
    for (const name of alternatives) {
      entry = findFurnitureByName(lib, aptType, category, name);
      if (entry) { resolvedName = name; break; }
    }

    if (!entry) {
      warnings.push(
        `No library entry for [${alternatives.join(" | ")}] in ${category} apt ${aptType} — skipped`,
      );
      continue;
    }

    const placementOpts: PlacementOptions = {
      referenceWalls:   FREESTANDING_FURNITURE.has(resolvedName) ? undefined : originalWalls,
      collisionPolygon: roomFullChain,
      edgePolygon:      roomRdcChain,
    };

    const result = placeFurniture(room, entry, placementOpts);
    if (!result) {
      warnings.push(`No valid placement found for "${resolvedName}" — skipped`);
      continue;
    }

    placed.push({ furnitureName: resolvedName, placed: result });

    roomFullChain = subtractPolygon(roomFullChain, result.smallCutout);
    roomRdcChain  = subtractPolygon(roomRdcChain,  result.largeCutout);
  }

  return { steps: placed, warnings };
}

// ─── All-options pipeline (interactive exploration) ───────────────────────────

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
  opts?: { library?: FurnitureLibrary; pipeline?: Pipeline },
): PipelineWithOptions {
  room = { ...room, polygon: simplifyPolygon(room.polygon) }; // strip model noise
  const lib      = opts?.library   ?? defaultLibrary;
  const pipeline = opts?.pipeline  ?? defaultPipeline;
  const section  = roomNameToSection(room.name);
  const steps    = pipeline[section] ?? [];
  const category = roomNameToCategory(room.name);

  const originalWalls: [Point2D, Point2D][] = [];
  for (let i = 0; i < room.polygon.length; i++) {
    const a = room.polygon[i];
    const b = room.polygon[(i + 1) % room.polygon.length];
    originalWalls.push([a, b]);
  }

  let roomFullChain: Point2D[] = room.polygon;
  const _doorRects = getDoorRectangles(room);
  let roomRdcChain: Point2D[] = room.polygon;
  for (const rect of _doorRects) roomRdcChain = subtractPolygon(roomRdcChain, rect);

  const resultSteps: StepOptions[] = [];
  const warnings:    string[]      = [];
  const placedSmallBboxes: Point2D[][] = []; // footprints placed so far (strict rule)

  for (let i = 0; i < steps.length; i++) {
    const alternatives = steps[i];

    let entry = null;
    let resolvedName = "";
    for (const name of alternatives) {
      entry = findFurnitureByName(lib, aptType, category, name);
      if (entry) { resolvedName = name; break; }
    }

    if (!entry) {
      warnings.push(
        `No library entry for [${alternatives.join(" | ")}] in ${category} apt ${aptType} — skipped`,
      );
      resultSteps.push({
        furnitureName: alternatives.join(" | "),
        allOptions:    [],
        selectedIndex: -1,
        selected:      null,
      });
      continue;
    }

    const placementOpts: PlacementOptions = {
      referenceWalls:   FREESTANDING_FURNITURE.has(resolvedName) ? undefined : originalWalls,
      collisionPolygon: roomFullChain,
      edgePolygon:      roomRdcChain,
    };

    const rawOptions = getAllPlacements(room, entry, placementOpts);

    // Strict clearance: drop options whose clearance zone would engulf an
    // already-placed footprint (fall back to raw only if that leaves nothing,
    // so a piece is never silently lost to the filter).
    const strict = rawOptions.filter(
      (opt) => !placedSmallBboxes.some((prev) => aabbOverlap(opt.placed.transformedBbox as Point2D[], prev)),
    );
    const allOptions = strict.length > 0 ? strict : rawOptions;

    if (allOptions.length === 0) {
      warnings.push(`No valid placement found for "${resolvedName}" — skipped`);
      resultSteps.push({
        furnitureName: resolvedName,
        allOptions:    [],
        selectedIndex: -1,
        selected:      null,
      });
      continue;
    }

    const raw = selectedIndices[i] ?? 0;
    const selectedIndex = Math.min(Math.max(raw, 0), allOptions.length - 1);
    const selected = allOptions[selectedIndex];

    resultSteps.push({ furnitureName: resolvedName, allOptions, selectedIndex, selected });

    placedSmallBboxes.push(selected.placed.transformedSmallBbox as Point2D[]);
    roomFullChain = subtractPolygon(roomFullChain, selected.placed.smallCutout);
    roomRdcChain  = subtractPolygon(roomRdcChain,  selected.placed.largeCutout);
  }

  return { steps: resultSteps, warnings };
}
