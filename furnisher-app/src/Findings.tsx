import { useMemo, useState } from "react";
import type { Cohort, NeufertRecord } from "./NeufertBrowser";

// The interactive findings from the benchmark dashboard, reduced to the two that
// are actionable in the browser: where an apartment's score sits in the overall
// distribution, and which room type made it fail. Every element here produces a
// Cohort — a named subset the browser then filters to, so a finding is something
// you can step through apartment by apartment rather than just read.

const BIN = 5;
const BIN_COUNT = 100 / BIN;

// Room types as the benchmark labels them, in the order the dashboard reports
// them (worst offender first is decided by the data, not this list).
const ROOM_LABELS: Record<string, string> = {
  "Kitchen": "Kitchens",
  "WC": "WCs",
  "Bathroom": "Bathrooms",
  "Living room": "Living rooms",
  "Bedroom": "Bedrooms",
  "Children": "Children's rooms",
};

function fmtInt(n: number) {
  return n.toLocaleString("en-US");
}

function scoreOf(rec: NeufertRecord): number | null {
  const s = rec.meta?.score;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

/** Cohort for a closed score range. `max` is inclusive only at 100 so adjacent
 *  bins never both claim the same apartment. */
function scoreCohort(min: number, max: number): Cohort {
  const inclusive = max >= 100;
  return {
    id: `score:${min}-${max}`,
    label: `Score ${min}–${max}`,
    predicate: (rec) => {
      const s = scoreOf(rec);
      if (s === null) return false;
      return s >= min && (inclusive ? s <= 100 : s < max);
    },
    sort: "score-asc",
  };
}

function failedRoomCohort(cat: string, label: string): Cohort {
  return {
    id: `failed:${cat}`,
    label: `${label} with no valid placement`,
    predicate: (rec) => (rec.meta?.perRoom ?? []).some((r) => r.cat === cat && r.score === 0),
    sort: "score-asc",
  };
}

/** Note: `meta.nFailedRooms` is 0 throughout the current bundle, so failures are
 *  read from the per-room scores (a room the engine could not furnish scores 0)
 *  rather than from that field. */
function hasFailedRoom(rec: NeufertRecord) {
  return (rec.meta?.perRoom ?? []).some((r) => r.score === 0);
}

const ANY_FAILED_COHORT: Cohort = {
  id: "failed:any",
  label: "Any room with no valid placement",
  predicate: hasFailedRoom,
  sort: "score-asc",
};

export function Findings({
  records,
  cohort,
  onPickCohort,
}: {
  records: NeufertRecord[];
  cohort: Cohort | null;
  onPickCohort: (cohort: Cohort | null) => void;
}) {
  // Hovered bin, and the bin a drag started on — a drag across bars selects the
  // spanned range. Nothing is committed until pointerup, because picking a
  // cohort loads its worst case onto the canvas.
  const [hoverBin, setHoverBin] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [rangeMin, setRangeMin] = useState("");
  const [rangeMax, setRangeMax] = useState("");

  const { bins, maxCount, scored } = useMemo(() => {
    const counts = new Array<number>(BIN_COUNT).fill(0);
    let n = 0;
    for (const rec of records) {
      const s = scoreOf(rec);
      if (s === null) continue;
      n++;
      counts[Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(s / BIN)))]++;
    }
    return { bins: counts, maxCount: Math.max(1, ...counts), scored: n };
  }, [records]);

  // Apartments holding at least one room of a type the engine could not furnish.
  const failures = useMemo(() => {
    const counts = new Map<string, number>();
    let any = 0;
    let hasPerRoom = false;
    for (const rec of records) {
      const perRoom = rec.meta?.perRoom;
      if (perRoom && perRoom.length) hasPerRoom = true;
      if (hasFailedRoom(rec)) any++;
      const seen = new Set<string>();
      for (const room of perRoom ?? []) {
        if (room.score !== 0 || seen.has(room.cat)) continue;
        seen.add(room.cat);
        counts.set(room.cat, (counts.get(room.cat) ?? 0) + 1);
      }
    }
    const rows = [...counts.entries()]
      .map(([cat, count]) => ({ cat, label: ROOM_LABELS[cat] ?? cat, count }))
      .sort((a, b) => b.count - a.count);
    return { rows, any, hasPerRoom, max: Math.max(1, ...rows.map((r) => r.count)) };
  }, [records]);

  // Bars covered by the current drag (preview only) or by the active cohort.
  const dragLo = dragFrom !== null && hoverBin !== null ? Math.min(dragFrom, hoverBin) : null;
  const dragHi = dragFrom !== null && hoverBin !== null ? Math.max(dragFrom, hoverBin) : null;

  const activeRange = useMemo(() => {
    const match = /^score:(\d+)-(\d+)$/.exec(cohort?.id ?? "");
    return match ? { min: Number(match[1]), max: Number(match[2]) } : null;
  }, [cohort?.id]);

  function binSelected(i: number) {
    if (dragLo !== null && dragHi !== null) return i >= dragLo && i <= dragHi;
    if (!activeRange) return false;
    const lo = i * BIN;
    return lo >= activeRange.min && lo < activeRange.max;
  }

  function commitDrag(endBin: number) {
    if (dragFrom === null) return;
    const lo = Math.min(dragFrom, endBin) * BIN;
    const hi = (Math.max(dragFrom, endBin) + 1) * BIN;
    setDragFrom(null);
    onPickCohort(scoreCohort(lo, hi));
  }

  function applyRangeInputs() {
    const min = rangeMin.trim() === "" ? 0 : Number(rangeMin.replace(",", "."));
    const max = rangeMax.trim() === "" ? 100 : Number(rangeMax.replace(",", "."));
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return;
    onPickCohort(scoreCohort(Math.max(0, Math.round(min)), Math.min(100, Math.round(max))));
  }

  // ── Chart geometry (viewBox units; the SVG scales to the rail width) ────────
  const W = 480;
  const H = 96;
  const PLOT_H = 74;
  const slot = W / BIN_COUNT;
  const barW = slot - 2; // 2px surface gap between bars

  // Readout: the hovered bin while pointing at the chart, otherwise a summary of
  // the selected range (not a single bin — that reads as if only one bin were
  // selected), otherwise the dataset total.
  const readout = (() => {
    const summarise = (lo: number, hi: number) => {
      let count = 0;
      for (let i = lo / BIN; i < hi / BIN; i++) count += bins[i] ?? 0;
      return { label: `${lo}–${hi}`, count, share: scored > 0 ? (count / scored) * 100 : 0 };
    };
    if (hoverBin !== null) return summarise(hoverBin * BIN, hoverBin * BIN + BIN);
    if (activeRange) return summarise(activeRange.min, activeRange.max);
    return null;
  })();

  return (
    <div className="findings">
      {/* ── Score distribution ── */}
      <div className="findings-block">
        <div className="findings-head">
          <h3 className="findings-title">Apartments by score</h3>
          <span className="findings-readout mono">
            {readout
              ? `${readout.label} · ${fmtInt(readout.count)} (${readout.share.toFixed(1)}%)`
              : `${fmtInt(scored)} scored`}
          </span>
        </div>
        <p className="findings-note">Click a bar, or drag across bars, to browse that range.</p>

        <svg
          className="findings-chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Distribution of apartment scores in bins of five"
          onPointerLeave={() => { setHoverBin(null); setDragFrom(null); }}
        >
          {bins.map((count, i) => {
            const h = count === 0 ? 0 : Math.max(2, (count / maxCount) * PLOT_H);
            const x = i * slot + 1;
            const selected = binSelected(i);
            return (
              <g key={i} className={`findings-bar${selected ? " selected" : ""}`}>
                <rect
                  className="findings-bar-fill"
                  x={x}
                  y={PLOT_H - h}
                  width={barW}
                  height={h}
                  rx="2"
                />
                {/* Full-height hit target so short bars stay clickable. */}
                <rect
                  className="findings-bar-hit"
                  x={x}
                  y="0"
                  width={barW}
                  height={PLOT_H}
                  onPointerEnter={() => setHoverBin(i)}
                  onPointerDown={() => { setDragFrom(i); setHoverBin(i); }}
                  onPointerUp={() => commitDrag(i)}
                >
                  <title>{`Score ${i * BIN}–${i * BIN + BIN}: ${fmtInt(count)} apartments`}</title>
                </rect>
              </g>
            );
          })}
          <line className="findings-axis" x1="0" y1={PLOT_H} x2={W} y2={PLOT_H} />
          {[0, 25, 50, 75, 100].map((tick) => (
            <text
              key={tick}
              className="findings-tick"
              x={Math.min(W - 8, Math.max(8, (tick / 100) * W))}
              y={H - 4}
              textAnchor={tick === 0 ? "start" : tick === 100 ? "end" : "middle"}
            >
              {tick}
            </text>
          ))}
        </svg>

        <div className="findings-controls">
          <button type="button" className="findings-chip" onClick={() => onPickCohort(scoreCohort(0, 60))}>
            under 60
          </button>
          <button type="button" className="findings-chip" onClick={() => onPickCohort(scoreCohort(0, 70))}>
            under 70
          </button>
          <button type="button" className="findings-chip" onClick={() => onPickCohort(scoreCohort(100, 100))}>
            perfect 100
          </button>
          <span className="findings-range">
            <input
              className="nf-num-input"
              type="text"
              inputMode="decimal"
              placeholder="min"
              value={rangeMin}
              onChange={(e) => setRangeMin(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyRangeInputs(); }}
              aria-label="Minimum score"
            />
            <span className="nf-range-sep">–</span>
            <input
              className="nf-num-input"
              type="text"
              inputMode="decimal"
              placeholder="max"
              value={rangeMax}
              onChange={(e) => setRangeMax(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyRangeInputs(); }}
              aria-label="Maximum score"
            />
            <button type="button" className="findings-chip" onClick={applyRangeInputs}>Apply</button>
          </span>
        </div>
      </div>

      {/* ── Failures by room type ── */}
      {failures.hasPerRoom && failures.rows.length > 0 ? (
        <div className="findings-block">
          <div className="findings-head">
            <h3 className="findings-title">Rooms with no valid placement</h3>
            <button type="button" className="findings-chip" onClick={() => onPickCohort(ANY_FAILED_COHORT)}>
              any · {fmtInt(failures.any)}
            </button>
          </div>
          <p className="findings-note">Apartments holding at least one room of that type the engine could not furnish.</p>

          <ul className="findings-rows">
            {failures.rows.map((row) => {
              const active = cohort?.id === `failed:${row.cat}`;
              return (
                <li key={row.cat}>
                  <button
                    type="button"
                    className={`findings-row${active ? " active" : ""}`}
                    onClick={() => onPickCohort(failedRoomCohort(row.cat, row.label))}
                  >
                    <span className="findings-row-label">{row.label}</span>
                    <span className="findings-row-track">
                      <span
                        className="findings-row-bar"
                        style={{ width: `${(row.count / failures.max) * 100}%` }}
                      />
                    </span>
                    <span className="findings-row-count mono">{fmtInt(row.count)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
