// ─── Furniture library types (mirrors furniture_library.json schema) ──────────

import type { Point2D } from "../layout/types";

export type FurnitureCategory =
  | "Bathroom"
  | "Kitchen"
  | "Livingroom"
  | "Bedroom"
  | "Children"
  | "WC";

export interface FurnitureVariant {
  linePlacement: { points: Point2D[] };
  bboxBig:   { origin: Point2D; width: number; height: number; rotation: number; points: Point2D[] };
  bboxSmall: { origin: Point2D; width: number; height: number; rotation: number; points: Point2D[] };
  geometry:  { closed: boolean; points: Point2D[] }[];
}

export interface FurniturePiece {
  id:            string;
  name:          string;
  apartmentType: number;
  category:      string;
  furnitureName: string;
  importance:    number;
  score:         number;
  variants:      FurnitureVariant[];
}

export interface FurnitureEntry {
  id:            string;
  apartmentType: number;
  category:      FurnitureCategory;
  furnitureName: string;
  pieces:        FurniturePiece[];
}

export interface FurnitureLibrary {
  version:   string;
  generated: string;
  count:     { files: number; pieces: number; variants: number };
  furniture: FurnitureEntry[];
}

/** Parsed placement_order.md: section heading → ordered list of alternatives per step. */
export type Pipeline = Record<string, string[][]>;

// ─── Fallback pieces (mirrors default/fallbacks.json) ────────────────────────

/** A replacement piece: a furniture name looked up for the room's apartment type, or for a given one. */
export type FallbackPieceRef = string | { name: string; aptType: number };

export interface FallbackRule {
  id:       string;
  /** Pipeline section the rule applies to ("Bathroom", "Children", "Kitchen", ...). */
  room:     string;
  aptTypes: number[];
  /** Regular furniture name (any alternative of a step) → the piece used instead. */
  replace:  Record<string, FallbackPieceRef>;
  label:    string;
}

/** A step a room may do without (e.g. the dining table of a living room). */
export interface OptionalStep {
  id:        string;
  /** Pipeline section ("Living room", ...). */
  room:      string;
  /** Apartment types where the room may do without it. */
  aptTypes:  number[];
  /** The step's furniture name in placement_order.md ("Dining"). */
  furniture: string;
  label:     string;
}

export interface FallbackSet {
  about?:        string;
  /** Points taken off the 0–100 room score when a room needs a fallback rule. */
  penaltyPoints: number;
  rules:         FallbackRule[];
  /** Points taken off the room score when an optional step finds no place. */
  optionalPenaltyPoints?: number;
  optional?:     OptionalStep[];
}

/** One piece a room uses in place of a regular one (from a fallback rule, or the step's other alternative). */
export interface FallbackPiece {
  furnitureName: string;
  /** The regular furniture name it stands in for (an alternative of the step). */
  replaces:      string;
  /** Look the piece up for this apartment type instead of the room's own. */
  aptType?:      number;
}
