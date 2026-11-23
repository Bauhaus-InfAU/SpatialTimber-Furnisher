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

export interface FallbackSet {
  about?:        string;
  /** Points taken off the 0–100 room score when a room needs a fallback rule. */
  penaltyPoints: number;
  rules:         FallbackRule[];
}
