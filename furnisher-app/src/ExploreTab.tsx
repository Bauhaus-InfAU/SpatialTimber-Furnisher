import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { NeufertBrowser, parseNeufertBundle } from "./NeufertBrowser";
import { Findings } from "./Findings";
import type { NeufertRecord, Cohort } from "./NeufertBrowser";
import { AffordToggles } from "./AffordToggles";
import type { AffordToggleProps } from "./AffordToggles";

// The "Explore dataset" tab: load the Neufert bundle once, see the interactive
// Findings (added in Phase 4), and browse cohort-scoped apartments. Picking an
// apartment feeds the shared canvas via `onLoadApartment` — the tab stays put.

function fmtInt(n: number) {
  return n.toLocaleString("en-US");
}

export function ExploreTab({
  hidden = false,
  isFurnished,
  affords,
  onLoadApartment,
}: {
  /** Kept mounted but out of view when the other tab is active, so the loaded
   *  bundle and browsing position survive a tab switch — see App. */
  hidden?: boolean;
  isFurnished: boolean;
  affords: AffordToggleProps;
  onLoadApartment: (record: NeufertRecord, opts?: { cohortActive?: boolean }) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [records, setRecords] = useState<NeufertRecord[] | null>(null);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cohort, setCohort] = useState<Cohort | null>(null);
  // Guards the async parse against landing on an unmounted tab. Must be set on
  // mount, not just at init: StrictMode runs mount → cleanup → mount in dev, so
  // an init-only `true` is flipped to false by that first cleanup and never
  // restored — which silently discarded every parsed bundle and left the button
  // stuck on "Loading…".
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

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
      parseNeufertBundle(String(reader.result))
        .then(({ records: recs, source: src }) => {
          if (!aliveRef.current) return;
          setRecords(recs);
          setSource(src);
          setCohort(null);
        })
        .catch((error: unknown) => {
          if (!aliveRef.current) return;
          setRecords(null);
          setSource("");
          setLoadError(error instanceof Error ? error.message : "Failed to parse the bundle.");
        })
        .finally(() => {
          if (aliveRef.current) setLoading(false);
        });
    });
    reader.readAsText(file);
  }

  // Wrap the load callback so an active cohort tags the load (Phase 5 uses this
  // to auto-surface the failing pieces on the canvas).
  function loadApartment(record: NeufertRecord) {
    onLoadApartment(record, { cohortActive: cohort !== null });
  }

  return (
    <aside className="sidebar explore-tab" aria-label="Explore dataset" hidden={hidden}>
      <div className="sidebar-header">
        <div className="rail-eyebrow"><b>·</b> Explore dataset</div>
        <div className="sidebar-subtitle">Browse the Neufert 4.0 benchmark and jump from a finding into the furnisher.</div>
      </div>

      <div className="explore-scroll">
        {!records ? (
          <div className="explore-empty">
            <button className="step-btn primary wide" type="button" onClick={handlePickClick} disabled={loading}>
              {loading ? "Loading…" : "Load bundle…"}
            </button>
            {loadError ? <div className="add-form-error nf-error">{loadError}</div> : null}
            <p className="step-description">
              Load the Neufert bundle (<span className="mono">neufert_apartments.jsonl</span>) to see the findings and
              browse apartments. Selecting one shows it on the canvas.
            </p>
          </div>
        ) : (
          <>
            <div className="explore-loaded-note">
              <span className="mono">{fmtInt(records.length)}</span> apartments loaded
              {source ? <span className="nf-source"> · {source}</span> : null}
              <button type="button" className="explore-reload" onClick={handlePickClick} disabled={loading}>
                {loading ? "Loading…" : "reload"}
              </button>
            </div>

            {isFurnished ? <AffordToggles {...affords} /> : null}

            <Findings records={records} cohort={cohort} onPickCohort={setCohort} />

            <NeufertBrowser
              records={records}
              cohort={cohort}
              onLoadApartment={loadApartment}
              onClearCohort={() => setCohort(null)}
            />
          </>
        )}
      </div>

      <input
        ref={fileRef}
        className="file-input"
        type="file"
        accept=".jsonl"
        onChange={handleFileChange}
      />
    </aside>
  );
}
