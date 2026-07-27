// Canvas-view toggles (Transition zones / Failed pieces / Walls). Extracted from
// the furnish card so both the "Trace & Furnish" and "Explore dataset" tabs can
// show the same controls whenever something is furnished on the shared canvas.

export type AffordToggleProps = {
  showTransitionAreas: boolean;
  onToggleTransitionAreas: () => void;
  showFailedCandidates: boolean;
  onToggleFailedCandidates: () => void;
  showWalls: boolean;
  onToggleWalls: () => void;
};

export function AffordToggles({
  showTransitionAreas,
  onToggleTransitionAreas,
  showFailedCandidates,
  onToggleFailedCandidates,
  showWalls,
  onToggleWalls,
}: AffordToggleProps) {
  return (
    <div className="affords">
      <button
        type="button"
        className={`afford${showTransitionAreas ? " active" : ""}`}
        onClick={onToggleTransitionAreas}
      >
        Transition zones
      </button>
      <button
        type="button"
        className={`afford${showFailedCandidates ? " active" : ""}`}
        onClick={onToggleFailedCandidates}
      >
        Failed pieces
      </button>
      <button
        type="button"
        className={`afford${showWalls ? " active" : ""}`}
        onClick={onToggleWalls}
      >
        Walls
      </button>
    </div>
  );
}
