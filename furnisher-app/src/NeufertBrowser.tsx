import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

// ─── Bundle record types (JSONL, produced outside the app) ────────────────────

export type NeufertRoomRecord = {
  name: string;
  polygon: [number, number][];
  windows?: [number, number][];
  subtype?: string;
  area?: number;
};

export type NeufertMeta = {
  score?: number | null;
  aptType?: number | null;
  nrooms?: number | null;
  totalArea?: number | null;
  nDuplicates?: number | null;
  nFailedRooms?: number | null;
};

export type NeufertContextArea = {
  subtype: string;
  polygon: [number, number][];
};

export type NeufertRecord = {
  id: string;
  apartment_id: string;
  rooms: NeufertRoomRecord[];
  doors?: [number, number][];
  /** Non-furnishable areas (corridors etc.) — display-only. Missing on old bundles. */
  context?: NeufertContextArea[];
  /** Wall thickness polygons (closed rings, metres, canonical frame) — display-only. Missing on old bundles. */
  walls?: [number, number][][];
  meta?: NeufertMeta;
};

type SortMode = "id" | "score-asc" | "score-desc" | "area-asc" | "area-desc";
type SizeFilter = "all" | 1 | 2 | 3 | 4 | 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtInt(n: number) {
  return n.toLocaleString("en-US");
}

function truncateId(id: string) {
  return id.length > 20 ? `${id.slice(0, 10)}…${id.slice(-7)}` : id;
}

function nullableNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Compare with nulls sorting last regardless of direction. */
function cmpNullable(a: number | null, b: number | null, dir: 1 | -1) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

const PARSE_CHUNK = 2500;

// ─── Component ────────────────────────────────────────────────────────────────

export function NeufertBrowser({
  onLoadApartment,
}: {
  onLoadApartment: (record: NeufertRecord) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<NeufertRecord[] | null>(null);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters
  const [sizeFilter, setSizeFilter] = useState<SizeFilter>("all");
  const [areaMin, setAreaMin] = useState("");
  const [areaMax, setAreaMax] = useState("");
  const [sort, setSort] = useState<SortMode>("id");

  // Selection
  const [index, setIndex] = useState(1); // 1-based within the filtered list
  const [indexInput, setIndexInput] = useState("1");
  const [hasSelected, setHasSelected] = useState(false);
  const [idQuery, setIdQuery] = useState("");
  const [idNotFound, setIdNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  // ── Parsing ─────────────────────────────────────────────────────────────────

  function handlePickClick() {
    fileRef.current?.click();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setLoading(true);
    setLoadError(null);
    const reader = new FileReader();
    reader.addEventListener("error", () => {
      setLoading(false);
      setLoadError("Could not read the file.");
    });
    reader.addEventListener("load", () => {
      void parseBundle(String(reader.result));
    });
    reader.readAsText(file);
  }

  async function parseBundle(text: string) {
    try {
      const lines = text.split(/\r?\n/);
      let li = 0;
      while (li < lines.length && !lines[li].trim()) li++;
      if (li >= lines.length) throw new Error("The file is empty.");

      let header: unknown;
      try {
        header = JSON.parse(lines[li]);
      } catch {
        throw new Error("Line 1 is not valid JSON — expected a bundle header.");
      }
      const h = header as { type?: unknown; source?: unknown };
      if (!h || h.type !== "neufert-bundle") {
        throw new Error('Not a Neufert bundle (header must have "type": "neufert-bundle").');
      }
      li++;

      const parsed: NeufertRecord[] = [];
      for (let start = li; start < lines.length; start += PARSE_CHUNK) {
        const end = Math.min(lines.length, start + PARSE_CHUNK);
        for (let i = start; i < end; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          let rec: unknown;
          try {
            rec = JSON.parse(line);
          } catch {
            throw new Error(`Line ${i + 1} is not valid JSON.`);
          }
          const r = rec as NeufertRecord;
          if (!r || typeof r.id !== "string" || !Array.isArray(r.rooms)) {
            throw new Error(`Line ${i + 1} is not an apartment record.`);
          }
          parsed.push(r);
        }
        // Yield to the event loop so the "Loading…" state stays responsive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!parsed.length) throw new Error("The bundle contains no apartments.");

      setRecords(parsed);
      setSource(typeof h.source === "string" ? h.source : "");
      setSizeFilter("all");
      setAreaMin("");
      setAreaMax("");
      setSort("id");
      setIndex(1);
      setIndexInput("1");
      setHasSelected(false);
      setIdQuery("");
      setIdNotFound(false);
    } catch (error) {
      setRecords(null);
      setSource("");
      setLoadError(error instanceof Error ? error.message : "Failed to parse the bundle.");
    } finally {
      setLoading(false);
    }
  }

  // ── Filtering + sorting ─────────────────────────────────────────────────────

  const areaMinNum = areaMin.trim() === "" ? null : Number(areaMin);
  const areaMaxNum = areaMax.trim() === "" ? null : Number(areaMax);

  const filtered = useMemo(() => {
    if (!records) return [];
    const result = records.filter((r) => {
      const nrooms = nullableNum(r.meta?.nrooms);
      if (sizeFilter !== "all") {
        if (nrooms === null) return false;
        if (sizeFilter === 5 ? nrooms < 5 : nrooms !== sizeFilter) return false;
      }
      const area = nullableNum(r.meta?.totalArea);
      if (areaMinNum !== null || areaMaxNum !== null) {
        if (area === null) return false;
        if (areaMinNum !== null && !Number.isNaN(areaMinNum) && area < areaMinNum) return false;
        if (areaMaxNum !== null && !Number.isNaN(areaMaxNum) && area > areaMaxNum) return false;
      }
      return true;
    });

    if (sort !== "id") {
      const dir: 1 | -1 = sort === "score-asc" || sort === "area-asc" ? 1 : -1;
      const key = sort === "score-asc" || sort === "score-desc"
        ? (r: NeufertRecord) => nullableNum(r.meta?.score)
        : (r: NeufertRecord) => nullableNum(r.meta?.totalArea);
      result.sort((a, b) => cmpNullable(key(a), key(b), dir) || a.id.localeCompare(b.id));
    } else {
      result.sort((a, b) => a.id.localeCompare(b.id));
    }
    return result;
  }, [records, sizeFilter, areaMinNum, areaMaxNum, sort]);

  // Filter changes reset the index to 1 — and re-load the first match only if
  // the user has already loaded something from the browser.
  const filterKey = `${sizeFilter}|${areaMinNum}|${areaMaxNum}|${sort}`;
  const filterKeyRef = useRef(filterKey);
  useEffect(() => {
    if (filterKeyRef.current === filterKey) return;
    filterKeyRef.current = filterKey;
    setIndex(1);
    setIndexInput("1");
    setIdNotFound(false);
    if (hasSelected && filtered.length > 0) onLoadApartment(filtered[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // ── Selection ───────────────────────────────────────────────────────────────

  const count = filtered.length;
  const clampedIndex = count > 0 ? Math.min(index, count) : 1;
  const current = count > 0 ? filtered[clampedIndex - 1] : null;

  function select(rawIndex: number) {
    if (count === 0) return;
    const wrapped = ((((rawIndex - 1) % count) + count) % count) + 1;
    setIndex(wrapped);
    setIndexInput(String(wrapped));
    setHasSelected(true);
    setCopied(false);
    onLoadApartment(filtered[wrapped - 1]);
  }

  function commitIndexInput() {
    const n = parseInt(indexInput, 10);
    if (Number.isNaN(n)) {
      setIndexInput(String(clampedIndex));
      return;
    }
    select(Math.min(Math.max(n, 1), count));
  }

  function handleIdQueryKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    const q = idQuery.trim().toLowerCase();
    if (!q) return;
    const at = filtered.findIndex(
      (r) => r.id.toLowerCase().includes(q) || r.apartment_id.toLowerCase().includes(q),
    );
    if (at === -1) {
      setIdNotFound(true);
    } else {
      setIdNotFound(false);
      select(at + 1);
    }
  }

  function handleCopyId() {
    if (!current) return;
    void navigator.clipboard?.writeText(current.id).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1400);
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const meta = current?.meta;
  const score = nullableNum(meta?.score);
  const totalArea = nullableNum(meta?.totalArea);
  const nrooms = nullableNum(meta?.nrooms);
  const nDuplicates = nullableNum(meta?.nDuplicates);
  const nFailedRooms = nullableNum(meta?.nFailedRooms);

  const sizeOptions: Array<{ value: SizeFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: 1, label: "1r" },
    { value: 2, label: "2r" },
    { value: 3, label: "3r" },
    { value: 4, label: "4r" },
    { value: 5, label: "5r" },
  ];

  return (
    <div className={`pipeline-step${open ? " open" : ""}`}>
      <button className="step-header" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="step-number">◈</span>
        <span className="step-title">Dataset browser</span>
        <span className="step-meta">{records ? fmtInt(records.length) : "optional"}</span>
        <span className="step-toggle">{open ? "∧" : "∨"}</span>
      </button>

      {open && (
        <div className="step-body">
          <p className="step-description">Optional — browse Neufert 4.0 apartments instead of tracing a plan.</p>

          <div>
            <button className="step-btn primary wide" type="button" onClick={handlePickClick} disabled={loading}>
              {loading ? "Loading…" : "Load bundle…"}
            </button>
            <input
              ref={fileRef}
              className="file-input"
              type="file"
              accept=".jsonl"
              onChange={handleFileChange}
            />
            {loadError ? <div className="add-form-error nf-error">{loadError}</div> : null}
            {records ? (
              <div className="nf-loaded-note">
                <span className="mono">{fmtInt(records.length)}</span> apartments loaded
                {source ? <span className="nf-source"> · {source}</span> : null}
              </div>
            ) : null}
          </div>

          {records && (
            <>
              {/* ── Filters ── */}
              <div className="nf-filter-row">
                <span className="apt-type-label">Size</span>
                <div className="nf-size-buttons">
                  {sizeOptions.map((opt) => (
                    <button
                      key={String(opt.value)}
                      type="button"
                      className={`nf-size-btn${sizeFilter === opt.value ? " active" : ""}`}
                      onClick={() => setSizeFilter(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="nf-filter-row">
                <span className="apt-type-label">Area</span>
                <input
                  className="nf-num-input"
                  type="number"
                  min="0"
                  placeholder="min"
                  value={areaMin}
                  onChange={(e) => setAreaMin(e.target.value)}
                />
                <span className="nf-range-sep">–</span>
                <input
                  className="nf-num-input"
                  type="number"
                  min="0"
                  placeholder="max"
                  value={areaMax}
                  onChange={(e) => setAreaMax(e.target.value)}
                />
                <span className="nf-unit">m²</span>
              </div>

              <div className="nf-filter-row">
                <span className="apt-type-label">Sort</span>
                <select className="nf-select" value={sort} onChange={(e) => setSort(e.target.value as SortMode)}>
                  <option value="id">id</option>
                  <option value="score-asc">score ↑</option>
                  <option value="score-desc">score ↓</option>
                  <option value="area-asc">area ↑</option>
                  <option value="area-desc">area ↓</option>
                </select>
              </div>

              <div className="nf-match-count">
                <span className="mono">{fmtInt(count)}</span> of <span className="mono">{fmtInt(records.length)}</span> match
              </div>

              {/* ── Stepper ── */}
              {count > 0 && current && (
                <>
                  <div className="nf-stepper">
                    <button type="button" className="variant-nav-btn" title="Previous apartment" onClick={() => select(clampedIndex - 1)}>◀</button>
                    <span className="nf-index-group">
                      <input
                        className="nf-index-input"
                        type="text"
                        inputMode="numeric"
                        value={indexInput}
                        onChange={(e) => setIndexInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") commitIndexInput(); }}
                        onBlur={commitIndexInput}
                      />
                      <span className="nf-index-total">of {fmtInt(count)}</span>
                    </span>
                    <button type="button" className="variant-nav-btn" title="Next apartment" onClick={() => select(clampedIndex + 1)}>▶</button>
                    <button
                      type="button"
                      className="nf-random-btn"
                      onClick={() => select(1 + Math.floor(Math.random() * count))}
                    >
                      Random
                    </button>
                  </div>

                  <div className="nf-goto-row">
                    <input
                      className="add-name-input nf-goto-input"
                      type="text"
                      placeholder="go to id…"
                      value={idQuery}
                      onChange={(e) => { setIdQuery(e.target.value); setIdNotFound(false); }}
                      onKeyDown={handleIdQueryKeyDown}
                    />
                    {idNotFound ? <div className="add-form-error nf-error">not found in current filter</div> : null}
                  </div>

                  {/* ── Current apartment card ── */}
                  <div className="nf-card">
                    <button
                      type="button"
                      className="nf-card-id"
                      title={`${current.id} (click to copy)`}
                      onClick={handleCopyId}
                    >
                      {truncateId(current.id)}
                      {copied ? <span className="nf-copied">copied</span> : null}
                    </button>
                    <div className="nf-card-meta">
                      <span className="nf-card-stat">score <b className="mono">{score !== null ? score.toFixed(1) : "—"}</b></span>
                      <span className="nf-card-stat">area <b className="mono">{totalArea !== null ? `${totalArea.toFixed(1)} m²` : "—"}</b></span>
                      <span className="nf-card-stat">rooms <b className="mono">{nrooms !== null ? nrooms : "—"}</b></span>
                      {nDuplicates !== null && nDuplicates > 1 ? (
                        <span className="nf-card-stat">×{nDuplicates} in dataset</span>
                      ) : null}
                    </div>
                    {nFailedRooms !== null && nFailedRooms > 0 ? (
                      <div className="nf-card-warn">
                        {nFailedRooms} room{nFailedRooms !== 1 ? "s" : ""} failed in batch run
                      </div>
                    ) : null}
                    <button type="button" className="step-btn primary wide" onClick={() => select(clampedIndex)}>
                      Show on canvas
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
