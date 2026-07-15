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

    const allOptions = getAllPlacements(room, entry, placementOpts);

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

    roomFullChain = subtractPolygon(roomFullChain, selected.placed.smallCutout);
    roomRdcChain  = subtractPolygon(roomRdcChain,  selected.placed.largeCutout);
  }

  return { steps: resultSteps, warnings };
}
