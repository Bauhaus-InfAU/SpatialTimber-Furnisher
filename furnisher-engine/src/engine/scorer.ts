// ─── Room Quality Scorer ──────────────────────────────────────────────────────
//
// Converts PipelineWithOptions into a 0–100 quality score.
// Formula: Score(room) = 100 × Σ nodeScore(step.allOptions.length) × levelWeight(i)
//
// nodeScore: 0 variants → 0.0, 1 variant → 0.75, 2+ variants → 1.0
// levelWeights: Bedroom [0.6, 0.4], Children [0.7, 0.3], all others equal 1/N

import type { RoomName } from "../layout/types";
import type { PipelineWithOptions } from "./types";

// ─── Output types (display contract) ─────────────────────────────────────────

export interface StepScore {
  furnitureName: string;
  /** Valid placements for the preferred variant (variantIndex 0). */
  preferredCount:      number;
  /** Valid placements across all fallback variants (variantIndex > 0). */
  fallbackCount:       number;
  /** True when only fallback variants fit (preferred variant had 0 placements). */
  usedFallbackVariant: boolean;
  /** 0.0 | 0.75 | 1.0, with ×0.85 applied when usedFallbackVariant is true. */
  nodeScore:           number;
  /** Weight applied for this step in the room formula. */
  levelWeight:         number;
}

export interface RoomScore {
  roomName: string;
  /** 0–100, rounded to 1 decimal place. */
  score:    number;
  steps:    StepScore[];
}

// ─── Node scoring ─────────────────────────────────────────────────────────────

function nodeScore(count: number): number {
  if (count <= 0) return 0.0;
  if (count === 1) return 0.75;
  return 1.0;
}

// ─── Level weight configuration ───────────────────────────────────────────────

function getLevelWeights(roomName: RoomName, stepCount: number): number[] {
  if (stepCount === 0) return [];

  if (roomName === "Bedroom" && stepCount >= 2) {
    const tail = stepCount - 2;
    // Primary 2 steps: [0.6, 0.4], extra steps get 0 (shouldn't exist per pipeline)
    return [0.6, 0.4, ...Array(tail).fill(0)].slice(0, stepCount);
  }

  if (roomName.startsWith("Children") && stepCount >= 2) {
    const tail = stepCount - 2;
    return [0.7, 0.3, ...Array(tail).fill(0)].slice(0, stepCount);
  }

  const w = 1 / stepCount;
  return Array(stepCount).fill(w);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function scoreRoom(roomName: RoomName, result: PipelineWithOptions): RoomScore {
  const { steps } = result;
  const weights = getLevelWeights(roomName, steps.length);

  const stepScores: StepScore[] = steps.map((step, i) => {
    const preferredCount = step.allOptions.filter(o => o.variantIndex === 0).length;
    const fallbackCount  = step.allOptions.filter(o => o.variantIndex > 0).length;
    const usedFallbackVariant = preferredCount === 0 && fallbackCount > 0;
    const effectiveCount = preferredCount > 0 ? preferredCount : fallbackCount;
    const ns = usedFallbackVariant
      ? nodeScore(effectiveCount) * 0.85
      : nodeScore(effectiveCount);
    return {
      furnitureName:       step.furnitureName,
      preferredCount,
      fallbackCount,
      usedFallbackVariant,
      nodeScore:           ns,
      levelWeight:         weights[i] ?? 0,
    };
  });

  const raw = stepScores.reduce((sum, s) => sum + s.nodeScore * s.levelWeight, 0);
  const score = Math.round(raw * 1000) / 10;  // × 100, 1 decimal

  return { roomName, score, steps: stepScores };
}
