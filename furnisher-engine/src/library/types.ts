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
