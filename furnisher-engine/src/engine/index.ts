export type { PlacedFurniture, PlacementOption, PlacementOptions, PipelineStep, PipelineResult, StepOptions, PipelineWithOptions } from "./types";
export { getAllPlacements, placeFurniture, placeVariantAtCorner, getDoorRectangles, doorWidth, simplifyPolygon } from "./placer";
export { subtractPolygon, subtractPolygonAll, subtractPlacement } from "./subtraction";
export { runRoomPipeline, runRoomPipelineAt } from "./pipeline";
export type { PipelineOptions } from "./pipeline";
export { getFlexibleKitchenPlacements, kitchenModuleCount, MODULE as KITCHEN_MODULE, CLEARANCE as KITCHEN_CLEARANCE } from "./kitchenFlex";
export type { RoomScore, StepScore } from "./scorer";
export { scoreRoom } from "./scorer";
