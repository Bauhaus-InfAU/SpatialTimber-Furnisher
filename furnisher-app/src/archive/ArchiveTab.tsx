// The "Composer archive" rail panel: filters, prev / next (also the arrow keys), the current layout's ids, the
// engine's apartment and room scores beside the composer's stored scores (old engine), warnings, the wall mode and
// the per-step option stepping of a selected room.
import { useEffect, useState } from "react";
import type { ArchiveState, ArchiveSort, OpenFilter } from "./useArchive";
import type { ArchiveShow } from "./ArchiveCanvas";
import type { ArchiveLayout } from "./types";

const TYPES = ["all", "1r", "2r", "3r", "4r", "5r"];
const EXPORT_CMD =
  "C:\\Work\\SpatialTimber-Building_Composer\\.venv\\Scripts\\python.exe furnisher-app\\tools\\export_composer_archive.py";

/** The composer's interior explorer (stc serve; static/interiors/app.js reads brief, preset and pl from the URL) at
 *  this placement: its release brief with that brief's release preset (explorer meta `default_preset`) when the layout
 *  belongs to A40-3S or B30-3S, else all placements ("*", the explorer's base preset). */
const COMPOSER_EXPLORER = "http://127.0.0.1:8765/interiors/";
const RELEASE_PRESET: Record<string, string> = { "A40-3S": "release-A40-3S-v1.0", "B30-3S": "release-B30-3S-v1.0" };
function composerUrl(layout: ArchiveLayout): string {
  const brief = layout.briefs.map((b) => b.brief).find((b) => b in RELEASE_PRESET);
  const q = new URLSearchParams(brief ? { brief, preset: RELEASE_PRESET[brief], pl: layout.pl_id } : { brief: "*", pl: layout.pl_id });
  return `${COMPOSER_EXPLORER}?${q.toString()}`;
}

function fmt(v: number | null | undefined, d = 1) {
  return v === null || v === undefined ? "–" : v.toFixed(d);
}

function Delta({ a, b }: { a: number | null | undefined; b: number | null | undefined }) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const d = a - b;
  if (Math.abs(d) < 0.05) return <span className="arch-delta same">=</span>;
  return <span className={`arch-delta ${d > 0 ? "up" : "down"}`}>{d > 0 ? "+" : ""}{d.toFixed(1)}</span>;
}

export function ArchiveTab({
  hidden,
  state,
  show,
  onShow,
  onOpenInTrace,
}: {
  hidden: boolean;
  state: ArchiveState;
  onOpenInTrace: (layout: ArchiveLayout) => void;
  show: ArchiveShow;
  onShow: (patch: Partial<ArchiveShow>) => void;
}) {
  const { index, loading, loadError, filters, setFilters, rows, pos, go, goTo, current, layout, furnished, busy, furnishError } = state;
  const [posInput, setPosInput] = useState("1");
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => setPosInput(String(pos + 1)), [pos, rows.length]);

  // ← / → (and PageUp / PageDown) scroll through the list while this tab is shown
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); go(1); }
      if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); go(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, go]);

  const briefs = index ? [...new Set(index.layouts.flatMap((r) => r.briefs))].sort() : [];
  const res = furnished?.result;
  const stored = layout?.stored ?? null;
  const storedBy = new Map((stored?.rooms ?? []).map((r) => [r.char, r]));
  const sel = state.selectedRoom;
  const selRoom = sel !== null && res ? res.rooms[sel] : null;

  return (
    <aside className="sidebar explore-tab" aria-label="Composer archive" hidden={hidden}>
      <div className="sidebar-header">
        <div className="rail-eyebrow"><b>·</b> Composer archive</div>
        <div className="sidebar-subtitle">
          Building Composer archive layouts, furnished by this engine exactly as the composer requests them
          (one apartment-level call, CLI defaults). Stored score = the archive's furn measure (old engine).
        </div>
      </div>

      <div className="explore-scroll">
        {!index ? (
          <div className="explore-empty">
            <button className="step-btn primary wide" type="button" onClick={() => void state.loadIndex()} disabled={loading}>
              {loading ? "Loading…" : "Load composer archive"}
            </button>
            {loadError ? <div className="add-form-error nf-error">{loadError}</div> : null}
            <p className="step-description">
              The dataset is read from <span className="mono">public/archive/composer/</span>. Export it with the
              composer's Python:
            </p>
            <code className="arch-cmd">{EXPORT_CMD}</code>
          </div>
        ) : (
          <div className="nf-browser">
            <div className="explore-loaded-note">
              <span className="mono">{index.n.toLocaleString("en-US")}</span> layouts · exported {index.created.slice(0, 16).replace("T", " ")}
              <button type="button" className="explore-reload" onClick={() => void state.loadIndex()} disabled={loading}>reload</button>
            </div>

            <div className="nf-filter-row">
              <span className="apt-type-label">Type</span>
              <div className="nf-size-buttons">
                {TYPES.map((t) => (
                  <button key={t} type="button" className={`nf-size-btn${filters.aptType === t ? " active" : ""}`} onClick={() => setFilters({ aptType: t })}>
                    {t === "all" ? "All" : t}
                  </button>
                ))}
              </div>
            </div>
            <div className="nf-filter-row">
              <span className="apt-type-label">Open kitchen</span>
              <div className="nf-size-buttons">
                {(["all", "yes", "no"] as OpenFilter[]).map((o) => (
                  <button key={o} type="button" className={`nf-size-btn${filters.open === o ? " active" : ""}`} onClick={() => setFilters({ open: o })}>
                    {o === "all" ? "All" : o === "yes" ? "Yes" : "No"}
                  </button>
                ))}
              </div>
            </div>
            <div className="nf-filter-row">
              <span className="apt-type-label">Brief</span>
              <select className="nf-select" value={filters.brief} onChange={(e) => setFilters({ brief: e.target.value })}>
                <option value="all">all</option>
                {briefs.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
              <span className="apt-type-label arch-gap">Sort</span>
              <select className="nf-select" value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value as ArchiveSort })}>
                <option value="id">id</option>
                <option value="stored-asc">stored score ↑</option>
                <option value="stored-desc">stored score ↓</option>
                <option value="area-asc">area ↑</option>
                <option value="area-desc">area ↓</option>
              </select>
            </div>
            <label className="arch-check">
              <input type="checkbox" checked={filters.hideUnfurnished} onChange={() => setFilters({ hideUnfurnished: !filters.hideUnfurnished })} />
              hide layouts the studio would not furnish ({index.layouts.filter((r) => r.studio === false).length})
            </label>
            <div className="nf-filter-row">
              <span className="apt-type-label">Stored score</span>
              <input className="nf-num-input" type="number" placeholder="min" value={filters.scoreMin} onChange={(e) => setFilters({ scoreMin: e.target.value })} />
              <span className="nf-range-sep">–</span>
              <input className="nf-num-input" type="number" placeholder="max" value={filters.scoreMax} onChange={(e) => setFilters({ scoreMax: e.target.value })} />
            </div>

            {rows.length === 0 ? (
              <div className="nf-match-count">no layout matches</div>
            ) : (
              <div className="nf-stepper">
                <button type="button" className="variant-nav-btn" title="Previous layout (←)" onClick={() => go(-1)}>◀</button>
                <span className="nf-index-group">
                  <input
                    className="nf-index-input"
                    type="text"
                    inputMode="numeric"
                    value={posInput}
                    onChange={(e) => setPosInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { const n = parseInt(posInput, 10); if (!Number.isNaN(n)) goTo(n - 1); } }}
                    onBlur={() => setPosInput(String(pos + 1))}
                  />
                  <span className="nf-index-total">/ {rows.length.toLocaleString("en-US")}</span>
                </span>
                <button type="button" className="variant-nav-btn" title="Next layout (→)" onClick={() => go(1)}>▶</button>
                <button type="button" className="nf-random-btn" onClick={() => goTo(Math.floor(Math.random() * rows.length))}>Random</button>
              </div>
            )}

            {current && (
              <div className="nf-card arch-card">
                <div className="arch-ids mono" title={layout ? `pl_id ${layout.pl_id}\ndrawing ${layout.hash}\ndrawn ${layout.drawn_hash}\nshape ${layout.shape_id}` : ""}>
                  <b>{current.aptType}</b> ·{" "}
                  <button
                    type="button"
                    className="arch-copy"
                    title={layout ? `${layout.pl_id} (click to copy the full pl_id)` : ""}
                    onClick={() => {
                      if (!layout) return;
                      void navigator.clipboard?.writeText(layout.pl_id).then(() => {
                        setCopied(layout.pl_id);
                        window.setTimeout(() => setCopied(null), 1400);
                      });
                    }}
                  >
                    pl {current.id}{copied && layout && copied === layout.pl_id ? " · copied" : ""}
                  </button>
                  {layout ? <> · sym {layout.sym} · drawing {layout.hash.slice(0, 10)}</> : null}
                </div>
                {layout && layout.briefs.length > 0 && (
                  <div className="arch-sub">
                    {layout.briefs.map((b) => `${b.brief}${b.record ? ` ${b.record}` : ""}`).join(", ")} · shape {layout.shape_id.slice(0, 10)}
                  </div>
                )}
                <div className="arch-scores">
                  <div className="arch-score-box">
                    <span className="arch-score-label">engine now</span>
                    <span className="arch-score-value mono">{busy && !furnished ? "…" : fmt(furnished?.score, 2)}</span>
                    {furnished && <span className="arch-score-note">{furnished.complete ? "complete" : "incomplete"} · {furnished.ms} ms</span>}
                  </div>
                  <div className="arch-score-box stored">
                    <span className="arch-score-label">composer stored</span>
                    <span className="arch-score-value mono">{fmt(stored?.score, 2)}</span>
                    <span className="arch-score-note">{stored ? (stored.complete ? "complete" : "incomplete") : "none"} · old engine</span>
                  </div>
                  <Delta a={furnished?.score} b={stored?.score} />
                </div>
                {layout && (
                  <div className="arch-sub">
                    request {layout.request_sha256.slice(0, 10)} · {layout.request.rooms.length} rooms · {layout.request.doors?.length ?? 0} door points ·{" "}
                    {current.sameAsFurn ? "same request as the stored score" : "request differs from the stored one (open kitchen / extra door points)"}
                    {layout.request_path.startsWith("studio") ? "" : ` · ${layout.request_path}`}
                  </div>
                )}
                {current.studio === false && (
                  <div className="arch-badge" title={current.studioWhy ?? ""}>
                    entrance spans two rooms (no entrance room) — the studio would not furnish this layout; the archive's furn2 request is shown
                  </div>
                )}
                {layout && (
                  <a className="arch-link" href={composerUrl(layout)} target="_blank" rel="noopener noreferrer"
                    title="The composer's interior explorer at this placement (the composer server must be running on 127.0.0.1:8765)">
                    Open in composer ↗
                  </a>
                )}
                {layout && (
                  <button type="button" className="step-btn primary wide" onClick={() => onOpenInTrace(layout)}>
                    Edit in Trace &amp; Furnish
                  </button>
                )}
                {busy && <div className="arch-sub">furnishing…</div>}
                {furnishError && <div className="add-form-error nf-error">{furnishError}</div>}

                {res && layout && (
                  <table className="arch-rooms">
                    <thead>
                      <tr><th>room</th><th>m²</th><th>engine</th><th>stored</th><th></th></tr>
                    </thead>
                    <tbody>
                      {res.rooms.map((rm, i) => {
                        const ch = layout.request_chars[i];
                        const st = storedBy.get(ch);
                        const rq = layout.request.rooms[i];
                        const sub = rq.subtype && rq.subtype !== rq.name ? ` (${rq.subtype})` : "";
                        return (
                          <tr key={i} className={sel === i ? "sel" : ""} onClick={() => state.setSelectedRoom(sel === i ? null : i)}>
                            <td>{ch} · {rm.name}{sub}{rm.openKitchen ? " ◐" : ""}{rm.bar ? " +bar" : ""}{rm.extension ? " +worktop" : ""}</td>
                            <td className="mono">{fmt(rq.area, 1)}</td>
                            <td className="mono">{rm.error ? "err" : fmt(rm.score)}</td>
                            <td className="mono">{fmt(st?.score)}</td>
                            <td><Delta a={rm.score} b={st?.score} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {res && res.rooms.some((r) => r.warnings.length || r.error) && (
                  <ul className="arch-warnings">
                    {res.rooms.flatMap((r, i) => [
                      ...(r.error ? [<li key={`e${i}`} className="err">{r.name}: {r.error}</li>] : []),
                      ...[...new Set(r.warnings)].map((w, j) => <li key={`w${i}-${j}`}>{r.name}: {w}</li>),
                    ])}
                  </ul>
                )}
              </div>
            )}

            {selRoom && layout && (
              <div className="nf-card arch-card">
                <div className="arch-sub">
                  <b>{selRoom.name}</b> · options per step (0 = best; later steps return to their best)
                  {state.hasSelections && (
                    <button type="button" className="explore-reload" onClick={state.resetOptions}>reset</button>
                  )}
                </div>
                {selRoom.steps.map((s, si) => (
                  <div key={si} className="arch-step">
                    <span className="arch-step-name">{s.furnitureName}</span>
                    <button type="button" className="variant-nav-btn" disabled={busy || s.selectedIndex <= 0} onClick={() => state.chooseOption(sel!, si, s.selectedIndex - 1)}>◀</button>
                    <span className="mono">{s.optionCount ? `${s.selectedIndex + 1} / ${s.optionCount}` : "0 options"}</span>
                    <button type="button" className="variant-nav-btn" disabled={busy || s.selectedIndex >= s.optionCount - 1} onClick={() => state.chooseOption(sel!, si, s.selectedIndex + 1)}>▶</button>
                  </div>
                ))}
              </div>
            )}

            <div className="nf-card arch-card">
              <div className="arch-sub"><b>Room outlines sent to the engine</b></div>
              <label className="arch-check">
                <input type="radio" checked={state.wallMode === "inset"} onChange={() => state.setWallMode("inset")} />
                walls first: rooms shrunk by half the drawn wall (0.05 m interior, 0.15 m outline, open sides
                kept), then furnished, so no furniture sits under a wall
              </label>
              <label className="arch-check">
                <input type="radio" checked={state.wallMode === "parity"} onChange={() => state.setWallMode("parity")} />
                composer parity: zero-thickness cell outlines, exactly as the composer sends them today (walls drawn
                over the furniture)
              </label>
              <div className="arch-sub"><b>Show</b></div>
              <div className="arch-show">
                {([["furniture", "furniture"], ["clearances", "door clearances"], ["openings", "openings / stool zone"], ["labels", "labels"]] as [keyof ArchiveShow, string][]).map(([k, label]) => (
                  <label key={k} className="arch-check inline">
                    <input type="checkbox" checked={show[k]} onChange={() => onShow({ [k]: !show[k] })} />
                    {label}
                  </label>
                ))}
              </div>
              <div className="arch-sub">
                Walls drawn 0.30 m (outline) / 0.10 m (interior), centred on the grid line; dashed = open (no wall).
                Labels: engine score · stored score. ← → scroll.
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
