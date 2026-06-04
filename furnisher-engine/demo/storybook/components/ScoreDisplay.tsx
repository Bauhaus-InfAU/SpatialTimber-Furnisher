import type { RoomScore } from "../../../src/engine";

// ─── Display contract ─────────────────────────────────────────────────────────

interface Props {
  score: RoomScore;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 70) return "#5cba7d";
  if (score >= 40) return "#e8c060";
  return "#cc6666";
}

function nodeBadgeColor(ns: number): string {
  if (ns >= 1.0)  return "#5cba7d";
  if (ns >= 0.75) return "#e8c060";
  return "#cc6666";
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ScoreDisplay({ score }: Props) {
  const color = scoreColor(score.score);

  return (
    <div style={{
      fontFamily: "'Segoe UI', sans-serif",
      marginBottom: 12,
      padding: "10px 14px",
      background: "#1a1a1a",
      borderRadius: 8,
      border: `1px solid ${color}44`,
    }}>

      {/* Score headline */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 28, fontWeight: 700, color, lineHeight: 1 }}>
          {score.score.toFixed(1)}
        </span>
        <span style={{ fontSize: 12, color: "#666" }}>/ 100</span>
        <span style={{ fontSize: 11, color: "#555", marginLeft: 4 }}>room score</span>
      </div>

      {/* Per-step breakdown */}
      {score.steps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {score.steps.map((step, i) => {
            const ns = step.nodeScore;
            const badgeColor = nodeBadgeColor(ns);
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{
                  fontFamily: "monospace", fontSize: 11,
                  color: "#888", minWidth: 110, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {step.furnitureName}
                </span>

                {/* option count */}
                <span style={{
                  fontFamily: "monospace", fontSize: 10,
                  background: (step.preferredCount + step.fallbackCount) === 0 ? "#2a1a1a" : "#1a2a1a",
                  border: `1px solid ${badgeColor}66`,
                  borderRadius: 3, padding: "1px 5px",
                  color: badgeColor,
                }}>
                  {step.preferredCount + step.fallbackCount} opt
                </span>

                {/* fallback variant indicator */}
                {step.usedFallbackVariant && (
                  <span style={{
                    fontFamily: "monospace", fontSize: 10,
                    background: "#2a2000", border: "1px solid #88660088",
                    borderRadius: 3, padding: "1px 5px", color: "#cc9933",
                  }}>
                    fallback variant
                  </span>
                )}

                {/* weight */}
                <span style={{ fontFamily: "monospace", fontSize: 10, color: "#444" }}>
                  ×{step.levelWeight.toFixed(2)}
                </span>

                {/* contribution */}
                <span style={{ fontFamily: "monospace", fontSize: 10, color: "#555" }}>
                  = {(ns * step.levelWeight * 100).toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
