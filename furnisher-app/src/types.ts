import type { PipelineWithOptions } from "@engine/types";
import type { RoomFallback } from "@engine/index";
import type { FallbackSet } from "@library";
import type { RoomName } from "@layout/types";

export type ToolId =
  | "upload"
  | "scale2d"
  | "Bedroom"
  | "Living room"
  | "Kitchen"
  | "Bathroom"
  | "WC"
  | "Children"
  | "Hall"
  | "Corridor"
  | "doors"
  | "windows"
  | "furnish";

export type RoomToolId = Extract<
  ToolId,
  "Bedroom" | "Living room" | "Kitchen" | "Bathroom" | "WC" | "Children" | "Hall" | "Corridor"
>;

/** Circulation spaces: traced for the layout/template, never furnished — the
 *  engine's RoomName vocabulary has no equivalent and no furniture recipes. */
export const CIRCULATION_ROOM_TYPES = ["Hall", "Corridor"] as const;

export type CirculationRoomId = (typeof CIRCULATION_ROOM_TYPES)[number];
/** The room types the engine can actually furnish — exactly the ones that have a
 *  matching RoomName. */
export type FurnishableRoomId = Exclude<RoomToolId, CirculationRoomId>;

export function isCirculationRoom(type: RoomToolId): type is CirculationRoomId {
  return (CIRCULATION_ROOM_TYPES as readonly string[]).includes(type);
}

export type Point2D = { x: number; y: number };

export type BackgroundImage = {
  id: string;
  src: string;
  name: string;
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  selected: boolean;
};

export type ScaleCalibration = {
  p1: Point2D | null;
  p2: Point2D | null;
  cursor: Point2D | null;
};

export type DrawnRoom = {
  id: string;
  type: RoomToolId;
  points: Point2D[];
  color: string;
  doors: Point2D[];
  windows: Point2D[];
  /** Per-window real widths (metres), aligned with `windows`. Absent for
   *  user-drawn rooms and older bundles → fall back to windowWidth(type). */
  windowWidths?: number[];
  /** Caller's room subtype, passed to the engine as is (furnishApartment): on a kitchen "Open kitchen" makes it
   *  open, "Kitchen" closed; anything else / absent → decided by geometry. Also "Studio" etc. from the composer. */
  subtype?: string | null;
  /** Explicit open-kitchen flag for a kitchen (beats subtype and geometry); null / absent = not set. */
  open?: boolean | null;
  /** Order of each door point in the apartment's door list (aligned with `doors`), kept from an imported
   *  request so an unedited layout sends the very same request. Doors without one come after. */
  doorOrder?: number[];
};

export type RoomDraft = {
  type: RoomToolId;
  points: Point2D[];
  cursor: Point2D | null;
  color: string;
  orthogonal: boolean;
};

export type FurnishedRoomResult = {
  roomId: string;
  roomName: RoomName;
  steps: PipelineWithOptions["steps"];
  warnings: string[];
  /** Set when the room needed a fallback (a smaller piece, or the step's other alternative); see the engine's furnish.ts. */
  fallback?: RoomFallback | null;
  /** The apartment type and fallback set the room was furnished with (for its score: optional steps). */
  aptType?: number;
  fallbacks?: FallbackSet | null;
};

// Room-type data colours — a muted, earthy set harmonised with the
// SpatialTimber warm palette (extends the system's peach/olive/sky data
// colours). Kept deliberately desaturated so they never compete with the
// single clay accent.
export const ROOM_TOOLS: Array<{
  id: RoomToolId;
  label: string;
  chipLabel: string;
  color: string;
}> = [
  { id: "Bedroom", label: "Bed", chipLabel: "bedroom", color: "#5E84A8" },
  { id: "Living room", label: "Liv", chipLabel: "living", color: "#788C5D" },
  { id: "Kitchen", label: "Kit", chipLabel: "kitchen", color: "#C2873F" },
  { id: "Bathroom", label: "Bath", chipLabel: "bath", color: "#5F9B95" },
  { id: "WC", label: "WC", chipLabel: "wc", color: "#9A7AA0" },
  { id: "Children", label: "Child", chipLabel: "children", color: "#CBA13F" },
  { id: "Hall", label: "Hall", chipLabel: "hall", color: "#8C8375" },
  { id: "Corridor", label: "Corr", chipLabel: "corridor", color: "#A79C88" },
];

// ─── Wall settings ────────────────────────────────────────────────────────────
// Walls are generated from the traced geometry: the apartment contour gives the
// outer walls, the room polygons give the inner (partition) walls. The offset
// says which side of the drawn line the thickness is laid on — "inner" keeps the
// drawn line as the outer face, "outer" keeps it as the inner face (so the traced
// clear dimensions are preserved), "midline" straddles it.

export type WallOffset = "inner" | "midline" | "outer";

export type WallTypeSettings = {
  enabled: boolean;
  /** Metres. */
  thickness: number;
  offset: WallOffset;
};

export type WallSettings = {
  outer: WallTypeSettings;
  inner: WallTypeSettings;
};

export const DEFAULT_WALL_SETTINGS: WallSettings = {
  outer: { enabled: true, thickness: 0.25, offset: "outer" },
  inner: { enabled: true, thickness: 0.1, offset: "midline" },
};

export const WALL_OFFSET_OPTIONS: Array<{ id: WallOffset; label: string; title: string }> = [
  { id: "inner",   label: "Inner",    title: "Thickness laid inside the drawn line" },
  { id: "midline", label: "Mid-line", title: "Thickness centred on the drawn line" },
  { id: "outer",   label: "Outer",    title: "Thickness laid outside the drawn line" },
];

export type CustomFurnitureDef = {
  name: string;
  bigWidth: number;
  bigDepth: number;
  smallWidth: number;
  smallDepth: number;
  smallOffsetX: number;
  smallOffsetY: number;
};

export type PipelineStepConfig = {
  id: string;
  names: string[];
  custom?: CustomFurnitureDef;
  variantIndex: number;
  sizeOverride?: { bigWidth: number; bigDepth: number; smallWidth?: number; smallDepth?: number };
};

export type PipelineConfig = {
  aptTypeOverride: number | null;
  roomOverrides: Record<string, PipelineStepConfig[]>;
  /** Build the kitchen from 0.6 m modules along the room's walls instead of
   *  dropping in the library's preset counter block. Kitchen only — every other
   *  room keeps its preset recipe either way. */
  flexibleKitchen: boolean;
};

export function isRoomTool(tool: ToolId): tool is RoomToolId {
  return (
    tool === "Bedroom" ||
    tool === "Living room" ||
    tool === "Kitchen" ||
    tool === "Bathroom" ||
    tool === "WC" ||
    tool === "Children" ||
    tool === "Hall" ||
    tool === "Corridor"
  );
}
