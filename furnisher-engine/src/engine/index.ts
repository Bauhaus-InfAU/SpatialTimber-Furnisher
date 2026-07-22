export type { PlacedFurniture, PlacementOption, PlacementOptions, PipelineStep, PipelineResult, StepOptions, PipelineWithOptions } from "./types";
export { getAllPlacements, placeFurniture, placeVariantAtCorner, getDoorRectangles, doorWidth, simplifyPolygon } from "./placer";
export { subtractPolygon, subtractPolygonAll, subtractPlacement } from "./subtraction";
export { runRoomPipeline, runRoomPipelineAt } from "./pipeline";
export type { RoomScore, StepScore } from "./scorer";
export { scoreRoom } from "./scorer";
