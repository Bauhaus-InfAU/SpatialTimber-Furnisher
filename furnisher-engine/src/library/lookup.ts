// ─── Furniture lookup: maps room/apartment types → library entries ────────────

import type { RoomName, ApartmentLabel } from "../layout/types";
import type { FurnitureCategory, FurnitureEntry, FurnitureLibrary } from "./types";

// ─── Mappings ────────────────────────────────────────────────────────────────

const ROOM_TO_CATEGORY: Record<RoomName, FurnitureCategory> = {
  "Bedroom":     "Bedroom",
  "Living room": "Livingroom",
  "Bathroom":    "Bathroom",
  "WC":          "WC",
  "Kitchen":     "Kitchen",
  "Children 1":  "Children",
  "Children 2":  "Children",
  "Children 3":  "Children",
  "Children 4":  "Children",
};

const LABEL_TO_APT_TYPE: Record<ApartmentLabel, number> = {
  "Studio (living)":  1,
  "Studio (bedroom)": 1,
  "1-Bedroom":        1,
  "2-Bedroom":        2,
  "3-Bedroom":        3,
  "4-Bedroom":        4,
  "5-Bedroom":        4,
};

// ─── Public API ──────────────────────────────────────────────────────────────

export function roomNameToCategory(name: RoomName): FurnitureCategory {
  return ROOM_TO_CATEGORY[name];
}

export function apartmentLabelToType(label: ApartmentLabel): number {
  return LABEL_TO_APT_TYPE[label];
}

/** Return the first furniture entry matching apartment type + category, or null. */
export function findFurniture(
  library: FurnitureLibrary,
  aptType: number,
  category: FurnitureCategory,
): FurnitureEntry | null {
  return (
    library.furniture.find(
      (f) => f.apartmentType === aptType && f.category === category,
    ) ?? null
  );
}

/** Return the entry matching apartment type + category + exact furnitureName, or null.
 *  Falls back to the nearest available apartment type (ascending) when no exact match exists. */
export function findFurnitureByName(
  library: FurnitureLibrary,
  aptType: number,
  category: FurnitureCategory,
  name: string,
): FurnitureEntry | null {
  const exact = library.furniture.find(
    (f) => f.apartmentType === aptType && f.category === category && f.furnitureName === name,
  );
  if (exact) return exact;

  // Collect all entries for this category + name, sorted by apt type ascending
  const candidates = library.furniture
    .filter((f) => f.category === category && f.furnitureName === name)
    .sort((a, b) => a.apartmentType - b.apartmentType);

  if (!candidates.length) return null;

  // Prefer the closest type >= requested; otherwise take the highest available
  return candidates.find((f) => f.apartmentType >= aptType) ?? candidates[candidates.length - 1];
}

/** All categories present in the given library. */
export function getAllCategories(library: FurnitureLibrary): FurnitureCategory[] {
  return [...new Set(library.furniture.map((f) => f.category))] as FurnitureCategory[];
}

// ─── Pipeline steps with alternatives ("Bathtube | Shower") ──────────────────

export interface ResolvedStep {
  entry: FurnitureEntry;
  /** The alternative that was resolved (e.g. "Shower"). */
  name: string;
}

/**
 * The entry for one pipeline step, the nearest-type way: the first alternative
 * that exists for ANY apartment type wins (findFurnitureByName per alternative,
 * left to right). Until 2026-11 this was the only rule; it gives the 3-room
 * bathtub to 1- and 2-room bathrooms because "Bathtube" is found (for type 3)
 * before "Shower" is tried. Kept as the second choice of resolveStep.
 */
export function resolveStepNearestType(
  library: FurnitureLibrary,
  aptType: number,
  category: FurnitureCategory,
  alternatives: string[],
): ResolvedStep | null {
  for (const name of alternatives) {
    const entry = findFurnitureByName(library, aptType, category, name);
    if (entry) return { entry, name };
  }
  return null;
}

/**
 * The entry for one pipeline step: the first alternative that the library has
 * for exactly this apartment type (so 1- and 2-room bathrooms get their own
 * Shower); when none has, the nearest-type rule above. For a step with a single
 * name this is always the same entry as resolveStepNearestType.
 */
export function resolveStep(
  library: FurnitureLibrary,
  aptType: number,
  category: FurnitureCategory,
  alternatives: string[],
): ResolvedStep | null {
  for (const name of alternatives) {
    const entry = library.furniture.find(
      (f) => f.apartmentType === aptType && f.category === category && f.furnitureName === name,
    );
    if (entry) return { entry, name };
  }
  return resolveStepNearestType(library, aptType, category, alternatives);
}
