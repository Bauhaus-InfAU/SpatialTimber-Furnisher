import type { Pipeline } from "./types";

/**
 * Parse placement_order.md into a map of section heading → ordered steps.
 * Each step is a list of alternative furniture names (split by " | ").
 *
 * Example output:
 *   { "Bedroom": [["Bed"], ["Wardrobe"]], "Bathroom": [["Bathtube","Shower"], ["Toilet"], ["Sink"]] }
 */
export function parsePipelineMd(md: string): Pipeline {
  const result: Pipeline = {};
  let currentSection: string | null = null;

  for (const raw of md.split("\n")) {
    const line = raw.trim();

    if (line.startsWith("## ")) {
      currentSection = line.slice(3).trim();
      result[currentSection] = [];
      continue;
    }

    // Numbered list item: "1. Bed" or "2. Bathtube | Shower"
    const listMatch = line.match(/^\d+\.\s+(.+)$/);
    if (listMatch && currentSection !== null) {
      const alternatives = listMatch[1].split("|").map((s) => s.trim()).filter(Boolean);
      if (alternatives.length > 0) {
        result[currentSection].push(alternatives);
      }
    }
  }

  return result;
}
