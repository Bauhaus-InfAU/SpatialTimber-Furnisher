// ─── Primitive geometry ───────────────────────────────────────────────────────

export type Point2D = [number, number];

export interface Segment {
  start: Point2D;
  end:   Point2D;
}

// ─── Room ─────────────────────────────────────────────────────────────────────

export type RoomName =
  | "Bedroom"
  | "Living room"
  | "Bathroom"
  | "WC"
  | "Kitchen"
  | "Children 1"
  | "Children 2"
  | "Children 3"
  | "Children 4";

export type ApartmentLabel =
  | "Studio (living)"
  | "Studio (bedroom)"
  | "1-Bedroom"
  | "2-Bedroom"
  | "3-Bedroom"
  | "4-Bedroom"
  | "5-Bedroom";

/** A single room as produced by the room generator. */
export interface Room {
  name:     RoomName;
  /** Closed polygon — last point does NOT repeat the first. */
  polygon:  Point2D[];
  /**
   * Points on walls where doors sit.
   * Optional — when omitted the engine skips door-swing subtraction and
   * door-obstacle checks, treating the room as if it has no door constraint.
   */
  doors?:   Point2D[];
  /**
   * Center points of windows on walls.
   * Used to exclude wall segments from wardrobe placement only.
   */
  windows?: Point2D[];
  /**
   * Stretches of this room's boundary that have no wall: the opening between
   * an open kitchen and the living room it belongs to. Each entry is one
   * straight piece [start, end] lying on a polygon edge (a wall may be open
   * only in part, so a piece need not span a whole edge). The kitchen and the
   * living room each carry their own side of the same opening.
   *
   * Optional — when omitted or empty the room is treated as fully walled.
   * When present on a Kitchen, the kitchen step uses the modular placer and
   * no counter module may back onto an open piece; on a Living room, wall-
   * backed furniture may not back onto one. See engine/openKitchen.ts.
   */
  openSegments?: [Point2D, Point2D][];
  /**
   * True for a kitchen that is open to the living room. Its kitchen step is
   * built only from 0.6 m modules (kitchenFlex.ts) under the open-kitchen
   * rules — never from library presets — even when no opening could be
   * located (`openSegments` empty: every wall is then usable).
   */
  openKitchen?: boolean;
  /**
   * Floor areas taken by a neighbouring room's furniture (e.g. the bar stools
   * of an open kitchen standing on the living-room side of the opening).
   * Subtracted from the room before its first piece is placed.
   */
  reserved?: Point2D[][];
  /**
   * Open kitchens only: the living rooms across the opening, with the
   * caller's index for each. When the counter inside the kitchen falls short
   * of its worktop target, a leg may continue past the opening along a living-
   * room wall that carries on the kitchen wall (kitchenFlex.ts). The caller
   * must then reserve `PlacedFurniture.extension.zones` in that room.
   */
  extendInto?: { index: number; room: Room }[];
}

/** Full output of one generateApartment() call. */
export interface Apartment {
  label:   ApartmentLabel;
  rooms:   Room[];
}
