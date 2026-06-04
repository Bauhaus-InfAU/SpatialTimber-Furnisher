import type { Point2D } from "../layout/types";

// ─── Placer output types ──────────────────────────────────────────────────────

export interface PlacedFurniture {
  name: string;
  transformedGeometry: { closed: boolean; points: Point2D[] }[];
  /** Full bounding box (furniture + pathway). For debug vis. */
  transformedBbox: Point2D[];
  /** Physical footprint only. Used for collision check and debug vis. */
  transformedSmallBbox: Point2D[];
  /** The wall segment used (for debug drawing). */
  wallSegment: [Point2D, Point2D];
  /** Polygon to subtract from room_full (physical footprint; L-shaped for kitchen). */
  smallCutout: Point2D[];
  /** Polygon to subtract from room_rdc (full clearance zone). */
  largeCutout: Point2D[];
}

export interface PlacementOption {
  /** Index into entry.pieces[0].variants */
  variantIndex: number;
  placed: PlacedFurniture;
}

export interface PlacementOptions {
  /**
   * If provided, wall candidates must lie on one of these reference walls
   * (edge midpoint within 0.02 m). Used during pipeline placement to reject
   * edges of a reduced polygon that aren't along an original room wall.
   * Omit for furniture that can stand freely (e.g. a dining table).
   */
  referenceWalls?: [Point2D, Point2D][];
  /**
   * Polygon whose edges are iterated as wall-candidate edges.
   * Defaults to `room.polygon`. In pipeline step 2+ this is room_rdc_new
   * (= room − door − previous bbox_bigs) so placements start on actual walls
   * not shadowed by previous clearance zones.
   */
  edgePolygon?: Point2D[];
  /**
   * Polygon used for inward-normal testing, wall extension, ray-cast collision
   * checks, and the final bbox_small containment check. Defaults to
   * `room.polygon`. In pipeline step 2+ this is room_full_new
   * (= room − previous bbox_smalls) so a new piece's bbox_big may overlap
   * previous bbox_bigs (transition zones) but its bbox_small cannot overlap
   * previous bbox_smalls.
   */
  collisionPolygon?: Point2D[];
}

// ─── Pipeline output types ────────────────────────────────────────────────────

export interface PipelineStep {
  furnitureName: string;
  placed: PlacedFurniture;
}

export interface PipelineResult {
  steps: PipelineStep[];
  warnings: string[];
}

export interface StepOptions {
  furnitureName:  string;
  /** All valid (variant × position) combinations for this step. Empty if none. */
  allOptions:     PlacementOption[];
  /** Index into allOptions; clamped to a valid range. -1 iff allOptions is empty. */
  selectedIndex:  number;
  /** The placement chosen by selectedIndex — null iff allOptions is empty. */
  selected:       PlacementOption | null;
}

export interface PipelineWithOptions {
  steps:    StepOptions[];
  warnings: string[];
}
