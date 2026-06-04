export type { PlacedFurniture, PlacementOption, PlacementOptions, PipelineStep, PipelineResult, StepOptions, PipelineWithOptions } from "./types";
export { getAllPlacements, placeFurniture, placeVariantAtCorner, getDoorRectangles, doorWidth } from "./placer";
export { subtractPolygon, subtractPlacement } from "./subtraction";
export { runRoomPipeline, runRoomPipelineAt } from "./pipeline";
export type { RoomScore, StepScore } from "./scorer";
export { scoreRoom } from "./scorer";
