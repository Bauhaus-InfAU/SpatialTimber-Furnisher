import libraryJson from "./default/furniture_library.json";
import fallbacksJson from "./default/fallbacks.json";
import pipelineMd from "./default/placement_order.md?raw";
import { parsePipelineMd } from "./pipelineParser";
import type { FallbackSet, FurnitureLibrary, Pipeline } from "./types";

export const defaultLibrary: FurnitureLibrary = libraryJson as unknown as FurnitureLibrary;
export const defaultPipeline: Pipeline = parsePipelineMd(pipelineMd);
export const defaultFallbacks: FallbackSet = fallbacksJson as unknown as FallbackSet;
