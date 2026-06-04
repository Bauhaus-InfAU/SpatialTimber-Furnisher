import type { PipelineWithOptions } from "@engine/types";
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
  | "doors"
  | "windows"
  | "furnish";

export type RoomToolId = Extract<
  ToolId,
  "Bedroom" | "Living room" | "Kitchen" | "Bathroom" | "WC" | "Children"
>;

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
};

export const ROOM_TOOLS: Array<{
  id: RoomToolId;
  label: string;
  chipLabel: string;
  color: string;
}> = [
  { id: "Bedroom", label: "Bed", chipLabel: "bedroom", color: "#4c78a8" },
  { id: "Living room", label: "Liv", chipLabel: "living", color: "#59a14f" },
  { id: "Kitchen", label: "Kit", chipLabel: "kitchen", color: "#f28e2b" },
  { id: "Bathroom", label: "Bath", chipLabel: "bath", color: "#76b7b2" },
  { id: "WC", label: "WC", chipLabel: "wc", color: "#af7aa1" },
  { id: "Children", label: "Child", chipLabel: "children", color: "#edc948" },
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
};

export function isRoomTool(tool: ToolId): tool is RoomToolId {
  return (
    tool === "Bedroom" ||
    tool === "Living room" ||
    tool === "Kitchen" ||
    tool === "Bathroom" ||
    tool === "WC" ||
    tool === "Children"
  );
}
