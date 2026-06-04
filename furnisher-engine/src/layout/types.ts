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
}

/** Full output of one generateApartment() call. */
export interface Apartment {
  label:   ApartmentLabel;
  rooms:   Room[];
}
