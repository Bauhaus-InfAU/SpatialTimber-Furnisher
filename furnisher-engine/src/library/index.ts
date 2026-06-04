export type { FurnitureCategory, FurnitureVariant, FurniturePiece, FurnitureEntry, FurnitureLibrary, Pipeline } from "./types";
export { parsePipelineMd } from "./pipelineParser";
export { defaultLibrary, defaultPipeline } from "./loader";
export { findFurniture, findFurnitureByName, roomNameToCategory, apartmentLabelToType, getAllCategories } from "./lookup";

// Convenience constant: all categories present in the default library.
import { defaultLibrary } from "./loader";
import { getAllCategories } from "./lookup";
export const ALL_CATEGORIES = getAllCategories(defaultLibrary);
