export type { FurnitureCategory, FurnitureVariant, FurniturePiece, FurnitureEntry, FurnitureLibrary, Pipeline, FallbackSet, FallbackRule, FallbackPieceRef, FallbackPiece, OptionalStep } from "./types";
export { parsePipelineMd } from "./pipelineParser";
export { defaultLibrary, defaultPipeline, defaultFallbacks } from "./loader";
export { findFurniture, findFurnitureByName, resolveStep, resolveStepNearestType, resolvePipelineStep, roomNameToCategory, apartmentLabelToType, getAllCategories } from "./lookup";

// Convenience constant: all categories present in the default library.
import { defaultLibrary } from "./loader";
import { getAllCategories } from "./lookup";
export const ALL_CATEGORIES = getAllCategories(defaultLibrary);
