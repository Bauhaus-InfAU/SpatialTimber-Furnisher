import { useState, useEffect } from "react";
import type { CSSProperties } from "react";
import { ROOM_TOOLS } from "./types";
import type { BackgroundImage, DrawnRoom, FurnishedRoomResult, RoomToolId, ToolId, PipelineConfig, PipelineStepConfig, CustomFurnitureDef } from "./types";
import { defaultLibrary, defaultPipeline, findFurnitureByName } from "@library";
import type { FurnitureVariant, FurnitureCategory } from "@library";

type SidebarProps = {
  rooms: DrawnRoom[];
  furnishedRooms: FurnishedRoomResult[];
  selectedTool: ToolId;
  lastRoomTool: RoomToolId;
  backgroundImages: BackgroundImage[];
  drawMode: "rectangle" | "lines";
  orthoMode: boolean;
  aptType: number;
  pipelineConfig: PipelineConfig;
  onSelectTool: (tool: ToolId) => void;
  onUploadClick: () => void;
  onReset: () => void;
  onFurnish: () => void;
  showTransitionAreas: boolean;
  onToggleTransitionAreas: () => void;
  onSetDrawMode: (mode: "rectangle" | "lines") => void;
  onToggleOrtho: () => void;
  onSetAptType: (type: number | null) => void;
  onUpdateRoomSteps: (section: string, steps: PipelineStepConfig[]) => void;
  onImageSelect: (id: string) => void;
  onImageDelete: (id: string) => void;
  onImageUpdate: (id: string, patch: Partial<BackgroundImage>) => void;
};

// ─── Pipeline step card ───────────────────────────────────────────────────────

type StepProps = {
  number: string;
  title: string;
  meta?: string;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
};

function PipelineStep({ number, title, meta, open, onToggle, children }: StepProps) {
  return (
    <div className={`pipeline-step${open ? " open" : ""}`}>
      <button className="step-header" type="button" onClick={onToggle}>
        <span className="step-number">{number}</span>
        <span className="step-title">{title}</span>
        {meta ? <span className="step-meta">{meta}</span> : null}
        <span className="step-toggle">{open ? "∧" : "∨"}</span>
      </button>
      {open && children ? <div className="step-body">{children}</div> : null}
    </div>
  );
}

// ─── Draw mode icons ──────────────────────────────────────────────────────────

function IconRect() {
  return (
    <svg width="9" height="9" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <rect x="1" y="2.5" width="11" height="8" rx="1" />
    </svg>
  );
}

function IconLines() {
  return (
    <svg width="9" height="9" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="1,9 3,1 9,2 12,7 7,12" />
    </svg>
  );
}

// ─── Reference image list ─────────────────────────────────────────────────────

function ImageListSection({
  backgroundImages,
  selectedTool,
  onUploadClick,
  onSelectTool,
  onImageSelect,
  onImageDelete,
  onImageUpdate,
}: {
  backgroundImages: BackgroundImage[];
  selectedTool: ToolId;
  onUploadClick: () => void;
  onSelectTool: (tool: ToolId) => void;
  onImageSelect: (id: string) => void;
  onImageDelete: (id: string) => void;
  onImageUpdate: (id: string, patch: Partial<BackgroundImage>) => void;
}) {
  return (
    <>
      <button className="step-btn primary wide" type="button" onClick={onUploadClick}>
        Upload floor plan image
      </button>

      {backgroundImages.length > 0 && (
        <div className="image-list">
          {backgroundImages.map((img) => (
            <div key={img.id} className={`image-list-item${img.selected ? " selected" : ""}`}>
              <div className="image-list-item-header" onClick={() => onImageSelect(img.id)}>
                <span className="image-list-name">{img.name}</span>
                <button
                  type="button"
                  className="step-icon-btn danger"
                  title="Delete image"
                  onClick={(e) => { e.stopPropagation(); onImageDelete(img.id); }}
                >
                  ✕
                </button>
              </div>
              {img.selected && (
                <div className="image-item-controls">
                  <label className="image-item-slider-row">
                    <span>Scale</span>
                    <input type="range" min="0.2" max="4" step="0.05" value={img.scale}
                      onChange={(e) => onImageUpdate(img.id, { scale: Number(e.target.value) })} />
                  </label>
                  <label className="image-item-slider-row">
                    <span>Rotate</span>
                    <input type="range" min="-180" max="180" step="1" value={img.rotation}
                      onChange={(e) => onImageUpdate(img.id, { rotation: Number(e.target.value) })} />
                  </label>
                  <label className="image-item-slider-row">
                    <span>Opacity</span>
                    <input type="range" min="0" max="1" step="0.05" value={img.opacity}
                      onChange={(e) => onImageUpdate(img.id, { opacity: Number(e.target.value) })} />
                  </label>
                  <button
                    type="button"
                    className={`image-scale2d-btn${selectedTool === "scale2d" ? " active" : ""}`}
                    onClick={() => { onSelectTool("scale2d"); onImageSelect(img.id); }}
                  >
                    Scale 2D
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Variant geometry helpers ─────────────────────────────────────────────────

function getVariantDimensions(variant: FurnitureVariant) {
  const bigPts  = variant.bboxBig.points  as [number, number][];
  const smallPts = variant.bboxSmall.points as [number, number][];
  const bigW  = Math.max(...bigPts.map((p) => p[0]))  - Math.min(...bigPts.map((p) => p[0]));
  const bigD  = Math.max(...bigPts.map((p) => p[1]))  - Math.min(...bigPts.map((p) => p[1]));
  const smallW = Math.max(...smallPts.map((p) => p[0])) - Math.min(...smallPts.map((p) => p[0]));
  const smallD = Math.max(...smallPts.map((p) => p[1])) - Math.min(...smallPts.map((p) => p[1]));
  return { bigW, bigD, smallW, smallD };
}

function scaleVariantLocal(variant: FurnitureVariant, sx: number, sy: number): FurnitureVariant {
  const sp = (p: [number, number]): [number, number] => [p[0] * sx, p[1] * sy];
  return {
    linePlacement: { points: (variant.linePlacement.points as [number, number][]).map(sp) },
    bboxBig:   { ...variant.bboxBig,   points: (variant.bboxBig.points   as [number, number][]).map(sp) },
    bboxSmall: { ...variant.bboxSmall, points: (variant.bboxSmall.points as [number, number][]).map(sp) },
    geometry: variant.geometry.map((g) => ({ closed: g.closed, points: (g.points as [number, number][]).map(sp) })),
  };
}

// ─── Furniture preview SVG ────────────────────────────────────────────────────

const PREVIEW_BASE_W = 88;
const PREVIEW_MAX_H  = 120;
const PREVIEW_MIN_H  = 32;

function FurniturePreviewSvg({ variant }: { variant: FurnitureVariant }) {
  const allPts = [
    ...variant.bboxBig.points,
    ...variant.bboxSmall.points,
    ...variant.geometry.flatMap((g) => g.points),
  ] as [number, number][];

  if (!allPts.length) return null;

  const pad  = 0.08;
  const xs   = allPts.map((p) => p[0]);
  const ys   = allPts.map((p) => p[1]);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad;
  const maxY = Math.max(...ys) + pad;
  const vbW  = Math.max(maxX - minX, 0.1);
  const vbH  = Math.max(maxY - minY, 0.1);
  const pixelH = Math.min(Math.max((vbH / vbW) * PREVIEW_BASE_W, PREVIEW_MIN_H), PREVIEW_MAX_H);

  function polyPts(pts: unknown[]) {
    return (pts as [number, number][]).map((p) => `${p[0]},${p[1]}`).join(" ");
  }
  function pathD(pts: unknown[], closed: boolean) {
    const ps = pts as [number, number][];
    if (!ps.length) return "";
    const [f, ...rest] = ps;
    return [`M ${f[0]} ${f[1]}`, ...rest.map((p) => `L ${p[0]} ${p[1]}`), closed ? "Z" : ""].join(" ");
  }

  const sw    = vbW * 0.022;
  const dashL = vbW * 0.06;
  const dashG = vbW * 0.035;

  return (
    <svg className="furniture-preview-svg" viewBox={`${minX} ${minY} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet" style={{ height: `${pixelH}px` }}>
      <polygon points={polyPts(variant.bboxBig.points)} fill="none" stroke="#C2C0B6" strokeWidth={sw} strokeDasharray={`${dashL} ${dashG}`} />
      <polygon points={polyPts(variant.bboxSmall.points)} fill="rgba(20,20,19,0.05)" stroke="#6f6c63" strokeWidth={sw} />
      {variant.geometry.map((geo, i) => (
        <path key={i} d={pathD(geo.points, geo.closed)} fill={geo.closed ? "rgba(217,119,87,0.12)" : "none"} stroke="#2b2a28" strokeWidth={sw * 0.85} />
      ))}
      <line
        x1={(variant.linePlacement.points[0] as [number, number])[0]}
        y1={(variant.linePlacement.points[0] as [number, number])[1]}
        x2={(variant.linePlacement.points[variant.linePlacement.points.length - 1] as [number, number])[0]}
        y2={(variant.linePlacement.points[variant.linePlacement.points.length - 1] as [number, number])[1]}
        stroke="#D97757" strokeWidth={sw * 1.5}
      />
    </svg>
  );
}

function CustomPreviewSvg({ def }: { def: CustomFurnitureDef }) {
  const { bigWidth, bigDepth, smallWidth, smallDepth, smallOffsetX, smallOffsetY } = def;
  if (bigWidth <= 0 || bigDepth <= 0) return null;
  const pad    = 0.08;
  const vbW    = bigWidth  + pad * 2;
  const vbH    = bigDepth  + pad * 2;
  const pixelH = Math.min(Math.max((vbH / vbW) * PREVIEW_BASE_W, PREVIEW_MIN_H), PREVIEW_MAX_H);
  const sw     = vbW * 0.022;
  const dashL  = vbW * 0.06;
  const dashG  = vbW * 0.035;
  return (
    <svg className="furniture-preview-svg" viewBox={`${-pad} ${-pad} ${vbW} ${vbH}`}
      preserveAspectRatio="xMidYMid meet" style={{ height: `${pixelH}px` }}>
      <rect x={0} y={0} width={bigWidth} height={bigDepth} fill="none" stroke="#C2C0B6" strokeWidth={sw} strokeDasharray={`${dashL} ${dashG}`} />
      {smallWidth > 0 && smallDepth > 0 && (
        <rect x={smallOffsetX} y={smallOffsetY} width={smallWidth} height={smallDepth} fill="rgba(217,119,87,0.10)" stroke="#6f6c63" strokeWidth={sw} />
      )}
      <line x1={0} y1={0} x2={bigWidth} y2={0} stroke="#D97757" strokeWidth={sw * 1.5} />
    </svg>
  );
}

// ─── Add-step form ────────────────────────────────────────────────────────────

function AddStepForm({
  section, aptType, onAdd, onCancel,
}: {
  section: string; aptType: number;
  onAdd: (step: PipelineStepConfig) => void; onCancel: () => void;
}) {
  const [tab, setTab]          = useState<"library" | "custom">("library");
  const [libName, setLibName]   = useState("");
  const [libError, setLibError] = useState("");
  const [custom, setCustom]     = useState<CustomFurnitureDef>({
    name: "", bigWidth: 1.0, bigDepth: 1.0, smallWidth: 0.6, smallDepth: 0.6, smallOffsetX: 0.2, smallOffsetY: 0.0,
  });
  const category = sectionToCategory(section);

  function handleAddLibrary() {
    const name = libName.trim();
    if (!name) { setLibError("Enter a furniture name."); return; }
    const entry = findFurnitureByName(defaultLibrary, aptType, category, name);
    if (!entry) { setLibError(`"${name}" not found in library for this room.`); return; }
    onAdd({ id: crypto.randomUUID(), names: [name], variantIndex: 0 });
  }
  function handleAddCustom() {
    if (!custom.name.trim() || custom.bigWidth <= 0 || custom.bigDepth <= 0) return;
    onAdd({ id: crypto.randomUUID(), names: [custom.name.trim()], custom, variantIndex: 0 });
  }
  function setField(field: keyof CustomFurnitureDef, value: string | number) {
    setCustom((c) => ({ ...c, [field]: value }));
  }

  return (
    <div className="add-step-form">
      <div className="add-step-tabs">
        <button type="button" className={`add-tab-btn${tab === "library" ? " active" : ""}`} onClick={() => setTab("library")}>From library</button>
        <button type="button" className={`add-tab-btn${tab === "custom" ? " active" : ""}`} onClick={() => setTab("custom")}>Custom</button>
      </div>
      {tab === "library" ? (
        <div className="add-tab-content">
          <input className="add-name-input" type="text" placeholder="Furniture name…" value={libName}
            onChange={(e) => { setLibName(e.target.value); setLibError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") handleAddLibrary(); }} autoFocus />
          {libError ? <div className="add-form-error">{libError}</div> : null}
          <div className="add-form-actions">
            <button type="button" className="add-form-btn primary" onClick={handleAddLibrary}>Add</button>
            <button type="button" className="add-form-btn secondary" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="add-tab-content">
          <input className="add-name-input" type="text" placeholder="Name…" value={custom.name}
            onChange={(e) => setField("name", e.target.value)} autoFocus />
          <div className="custom-form-section-label">Transition boundary</div>
          <div className="custom-form-row">
            <label>W <input type="number" className="custom-num-input" min="0.1" step="0.1" value={custom.bigWidth}  onChange={(e) => setField("bigWidth",  parseFloat(e.target.value) || 0)} /> m</label>
            <label>D <input type="number" className="custom-num-input" min="0.1" step="0.1" value={custom.bigDepth}  onChange={(e) => setField("bigDepth",  parseFloat(e.target.value) || 0)} /> m</label>
          </div>
          <div className="custom-form-section-label">Furniture boundary</div>
          <div className="custom-form-row">
            <label>W <input type="number" className="custom-num-input" min="0.1" step="0.1" value={custom.smallWidth}  onChange={(e) => setField("smallWidth",  parseFloat(e.target.value) || 0)} /> m</label>
            <label>D <input type="number" className="custom-num-input" min="0.1" step="0.1" value={custom.smallDepth}  onChange={(e) => setField("smallDepth",  parseFloat(e.target.value) || 0)} /> m</label>
          </div>
          <div className="custom-form-row">
            <label>X off <input type="number" className="custom-num-input" step="0.05" value={custom.smallOffsetX} onChange={(e) => setField("smallOffsetX", parseFloat(e.target.value) || 0)} /> m</label>
            <label>Y off <input type="number" className="custom-num-input" step="0.05" value={custom.smallOffsetY} onChange={(e) => setField("smallOffsetY", parseFloat(e.target.value) || 0)} /> m</label>
          </div>
          <CustomPreviewSvg def={custom} />
          <div className="add-form-actions">
            <button type="button" className="add-form-btn primary" onClick={handleAddCustom} disabled={!custom.name.trim() || custom.bigWidth <= 0}>Add</button>
            <button type="button" className="add-form-btn secondary" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sectionToCategory(section: string): FurnitureCategory {
  if (section === "Living room") return "Livingroom";
  return section as FurnitureCategory;
}

function effectiveSteps(section: string, config: PipelineConfig): PipelineStepConfig[] {
  if (config.roomOverrides[section]) return config.roomOverrides[section];
  return (defaultPipeline[section] ?? []).map((names, i) => ({
    id: `default-${section}-${i}-${names.join(",")}`,
    names,
    variantIndex: 0,
  }));
}

function stepsMatchDefaults(section: string, steps: PipelineStepConfig[]): boolean {
  const dflt = defaultPipeline[section] ?? [];
  if (steps.length !== dflt.length) return false;
  return steps.every((s, i) => JSON.stringify(s.names) === JSON.stringify(dflt[i]) && s.variantIndex === 0 && !s.custom && !s.sizeOverride);
}

const SECTION_ORDER = ["Bedroom", "Living room", "Kitchen", "Bathroom", "WC", "Children"];

const ROOM_ICONS: Record<string, string> = {
  "Bedroom": "Bed",
  "Living room": "Liv",
  "Kitchen": "Kit",
  "Bathroom": "Bath",
  "WC": "WC",
  "Children": "Child",
};

function getActiveSections(rooms: DrawnRoom[]): string[] {
  const seen = new Set<string>();
  for (const r of rooms) seen.add(r.type === "Children" ? "Children" : (r.type as string));
  return SECTION_ORDER.filter((s) => seen.has(s));
}

function NumInput({ value, onChange, readonly = false }: { value: number; onChange?: (v: number) => void; readonly?: boolean; }) {
  const [localVal, setLocalVal] = useState(() => value.toFixed(2));
  useEffect(() => { setLocalVal(value.toFixed(2)); }, [value]);
  if (readonly) return <span className="size-readonly">{value.toFixed(2)}</span>;
  return (
    <input className="size-dim-input" type="number" min="0.1" step="0.05" value={localVal}
      onChange={(e) => setLocalVal(e.target.value)}
      onBlur={() => {
        const v = parseFloat(localVal);
        if (!isNaN(v) && v > 0) { onChange?.(v); setLocalVal(v.toFixed(2)); }
        else setLocalVal(value.toFixed(2));
      }} />
  );
}

// ─── Room section panel ───────────────────────────────────────────────────────

function RoomSectionPanel({
  section, aptType, pipelineConfig, onUpdateRoomSteps,
}: {
  section: string; aptType: number; pipelineConfig: PipelineConfig;
  onUpdateRoomSteps: (section: string, steps: PipelineStepConfig[]) => void;
}) {
  const [open, setOpen]           = useState(false);
  const [addFormAt, setAddFormAt] = useState<number | null>(null);

  const category     = sectionToCategory(section);
  const steps        = effectiveSteps(section, pipelineConfig);
  const isCustomized = !!pipelineConfig.roomOverrides[section] && !stepsMatchDefaults(section, steps);

  function commit(newSteps: PipelineStepConfig[]) { onUpdateRoomSteps(section, newSteps); }

  function handleDeleteStep(idx: number)        { commit(steps.filter((_, i) => i !== idx)); }
  function handleMoveStep(idx: number, dir: -1 | 1) {
    const ni = idx + dir;
    if (ni < 0 || ni >= steps.length) return;
    const next = [...steps]; [next[idx], next[ni]] = [next[ni], next[idx]]; commit(next);
  }
  function handleChangeVariant(idx: number, delta: number) {
    const step  = steps[idx];
    const entry = findFurnitureByName(defaultLibrary, aptType, category, step.names[0]);
    const total = entry?.pieces[0]?.variants.length ?? 1;
    const newVI = ((step.variantIndex + delta) % total + total) % total;
    commit(steps.map((s, i) => i === idx ? { ...s, variantIndex: newVI } : s));
  }
  function handleResizeLibraryStep(idx: number, override: { bigWidth: number; bigDepth: number; smallWidth?: number; smallDepth?: number }) {
    commit(steps.map((s, i) => i === idx ? { ...s, sizeOverride: override } : s));
  }
  function handleResizeCustomStep(idx: number, fields: Partial<CustomFurnitureDef>) {
    const step = steps[idx];
    if (!step.custom) return;
    commit(steps.map((s, i) => i === idx ? { ...s, custom: { ...s.custom!, ...fields } } : s));
  }
  function handleAddStep(step: PipelineStepConfig) {
    const at = addFormAt ?? steps.length;
    commit([...steps.slice(0, at), step, ...steps.slice(at)]);
    setAddFormAt(null);
  }
  function handleResetToDefaults() {
    commit((defaultPipeline[section] ?? []).map((names, i) => ({
      id: `default-${section}-${i}-${names.join(",")}`,
      names, variantIndex: 0,
    })));
  }

  return (
    <div className="room-section-panel">
      <button type="button" className="room-section-header" onClick={() => setOpen((v) => !v)}>
        <span className="room-section-icon">{ROOM_ICONS[section] ?? "◻"}</span>
        <span className="room-section-name">{section}</span>
        <span className="room-section-count">{steps.length} item{steps.length !== 1 ? "s" : ""}</span>
        <span className="room-section-toggle">{open ? "∧" : "∨"}</span>
      </button>

      {open && (
        <div className="room-section-body">
          {addFormAt === 0 ? (
            <AddStepForm section={section} aptType={aptType} onAdd={handleAddStep} onCancel={() => setAddFormAt(null)} />
          ) : (
            <button type="button" className="add-step-btn" onClick={() => setAddFormAt(0)}>+</button>
          )}

          {steps.map((step, idx) => {
            const entry        = step.custom ? null : findFurnitureByName(defaultLibrary, aptType, category, step.names[0]);
            const variantTotal = entry?.pieces[0]?.variants.length ?? 1;
            const rawVariant   = step.custom ? null : (entry?.pieces[0]?.variants[step.variantIndex] ?? entry?.pieces[0]?.variants[0] ?? null);
            const origDims     = rawVariant ? getVariantDimensions(rawVariant) : null;
            const effBigW  = step.sizeOverride?.bigWidth  ?? origDims?.bigW ?? 1;
            const effBigD  = step.sizeOverride?.bigDepth ?? origDims?.bigD ?? 1;
            const sx       = origDims && origDims.bigW > 0 ? effBigW / origDims.bigW : 1;
            const sy       = origDims && origDims.bigD > 0 ? effBigD / origDims.bigD : 1;
            const displayVariant = rawVariant && (Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001)
              ? scaleVariantLocal(rawVariant, sx, sy) : rawVariant;
            const effSmallW = origDims ? origDims.smallW * sx : null;
            const effSmallD = origDims ? origDims.smallD * sy : null;

            return (
              <div key={step.id}>
                <div className="furniture-step-header">
                  <div className="furniture-step-info">
                    <span className="furniture-step-name">{step.names[0]}</span>
                    {!step.custom && variantTotal > 1 && (
                      <span className="furniture-step-variant">
                        <button type="button" className="variant-arrow" onClick={() => handleChangeVariant(idx, -1)}>◀</button>
                        <span className="variant-count">v{step.variantIndex + 1}/{variantTotal}</span>
                        <button type="button" className="variant-arrow" onClick={() => handleChangeVariant(idx, 1)}>▶</button>
                      </span>
                    )}
                    {step.custom && <span className="furniture-step-badge">custom</span>}
                    {!step.custom && !entry && <span className="furniture-step-badge warn">not found</span>}
                  </div>
                  <div className="furniture-step-actions">
                    <button type="button" className="step-icon-btn" title="Move up"   onClick={() => handleMoveStep(idx, -1)} disabled={idx === 0}>↑</button>
                    <button type="button" className="step-icon-btn" title="Move down" onClick={() => handleMoveStep(idx, 1)}  disabled={idx === steps.length - 1}>↓</button>
                    <button type="button" className="step-icon-btn danger" title="Delete" onClick={() => handleDeleteStep(idx)}>✕</button>
                  </div>
                </div>

                {(displayVariant || step.custom) && (
                  <div className="furniture-step-detail">
                    <div className="furniture-step-preview-col">
                      {displayVariant && <FurniturePreviewSvg variant={displayVariant} />}
                      {step.custom    && <CustomPreviewSvg def={step.custom} />}
                    </div>
                    <div className="furniture-step-sizes">
                      {!step.custom && origDims && (
                        <>
                          <div className="size-row">
                            <span className="size-label">Full</span>
                            <NumInput value={effBigW} onChange={(v) => handleResizeLibraryStep(idx, { ...step.sizeOverride, bigWidth: v, bigDepth: effBigD })} />
                            <span className="size-sep">×</span>
                            <NumInput value={effBigD} onChange={(v) => handleResizeLibraryStep(idx, { ...step.sizeOverride, bigWidth: effBigW, bigDepth: v })} />
                            <span className="size-unit">m</span>
                          </div>
                          <div className="size-row">
                            <span className="size-label">Furn.</span>
                            <NumInput value={step.sizeOverride?.smallWidth ?? effSmallW!}
                              onChange={(v) => handleResizeLibraryStep(idx, { ...step.sizeOverride, bigWidth: effBigW, bigDepth: effBigD, smallWidth: v, smallDepth: step.sizeOverride?.smallDepth ?? effSmallD! })} />
                            <span className="size-sep">×</span>
                            <NumInput value={step.sizeOverride?.smallDepth ?? effSmallD!}
                              onChange={(v) => handleResizeLibraryStep(idx, { ...step.sizeOverride, bigWidth: effBigW, bigDepth: effBigD, smallWidth: step.sizeOverride?.smallWidth ?? effSmallW!, smallDepth: v })} />
                            <span className="size-unit">m</span>
                          </div>
                        </>
                      )}
                      {step.custom && (
                        <>
                          <div className="size-row">
                            <span className="size-label">Full</span>
                            <NumInput value={step.custom.bigWidth}  onChange={(v) => handleResizeCustomStep(idx, { bigWidth: v })} />
                            <span className="size-sep">×</span>
                            <NumInput value={step.custom.bigDepth}  onChange={(v) => handleResizeCustomStep(idx, { bigDepth: v })} />
                            <span className="size-unit">m</span>
                          </div>
                          <div className="size-row">
                            <span className="size-label">Furn.</span>
                            <NumInput value={step.custom.smallWidth}  onChange={(v) => handleResizeCustomStep(idx, { smallWidth: v })} />
                            <span className="size-sep">×</span>
                            <NumInput value={step.custom.smallDepth}  onChange={(v) => handleResizeCustomStep(idx, { smallDepth: v })} />
                            <span className="size-unit">m</span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {addFormAt === idx + 1 ? (
                  <AddStepForm section={section} aptType={aptType} onAdd={handleAddStep} onCancel={() => setAddFormAt(null)} />
                ) : (
                  <button type="button" className="add-step-btn" onClick={() => setAddFormAt(idx + 1)}>+</button>
                )}
              </div>
            );
          })}

          {isCustomized && (
            <button type="button" className="reset-defaults-btn" onClick={handleResetToDefaults}>
              Reset to defaults
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

export function Sidebar({
  rooms, furnishedRooms, selectedTool, backgroundImages,
  drawMode, orthoMode, aptType, pipelineConfig,
  onSelectTool, onUploadClick, onReset, onFurnish,
  showTransitionAreas, onToggleTransitionAreas,
  onSetDrawMode, onToggleOrtho, onSetAptType, onUpdateRoomSteps,
  onImageSelect, onImageDelete, onImageUpdate,
}: SidebarProps) {
  const [openSteps, setOpenSteps] = useState<Set<number>>(new Set([1]));

  const isFurnished   = furnishedRooms.length > 0;
  const doorCount     = rooms.reduce((sum, r) => sum + r.doors.length, 0);
  const windowCount   = rooms.reduce((sum, r) => sum + r.windows.length, 0);

  function toggleStep(n: number) {
    setOpenSteps((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  }


  const activeSections = getActiveSections(rooms);
  const aptTypeLabel   = (n: number) => n >= 5 ? "5+" : String(n);
  const overrideLabel  = pipelineConfig.aptTypeOverride !== null
    ? `Type ${aptTypeLabel(aptType)}`
    : `Type ${aptTypeLabel(aptType)} (auto)`;

  // Readiness note shown under the primary action
  const furnishNote = rooms.length === 0
    ? "Upload a floor plan and draw your rooms."
    : isFurnished
    ? "Explore and adjust the placement."
    : `${rooms.length} room${rooms.length > 1 ? "s" : ""} ready for furnishing.`;

  return (
    <aside className="sidebar" aria-label="Design pipeline">
      <div className="sidebar-header">
        <div className="rail-eyebrow"><b>·</b> Pipeline</div>
        <div className="sidebar-subtitle">Trace your plan, then check the furniture fits.</div>
      </div>

      <div className="furnish-card">
        <button className="furnish-button" type="button" onClick={onFurnish} disabled={rooms.length === 0}>
          <svg className="furnish-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3Z" />
          </svg>
          Furnish apartment
        </button>
        <div className="furnish-note">{furnishNote}</div>
        {isFurnished && (
          <div className="affords">
            <button
              type="button"
              className={`afford${showTransitionAreas ? " active" : ""}`}
              onClick={onToggleTransitionAreas}
            >
              Transition zones
            </button>
          </div>
        )}
      </div>

      <div className="pipeline-steps">
        <div className="pipeline-steps-frame">
        {/* ── 01 Add plan ── */}
        <PipelineStep
          number="01"
          title="Add plan"
          meta={backgroundImages.length > 0 ? `${backgroundImages.length} image${backgroundImages.length > 1 ? "s" : ""}` : undefined}
          open={openSteps.has(1)}
          onToggle={() => toggleStep(1)}
        >
          <p className="step-description">Upload a floor plan image and set the real-world scale.</p>
          <ImageListSection
            backgroundImages={backgroundImages}
            selectedTool={selectedTool}
            onUploadClick={onUploadClick}
            onSelectTool={onSelectTool}
            onImageSelect={onImageSelect}
            onImageDelete={onImageDelete}
            onImageUpdate={onImageUpdate}
          />
        </PipelineStep>

        {/* ── 02 Trace rooms ── */}
        <PipelineStep
          number="02"
          title="Trace rooms"
          meta={rooms.length > 0 ? `${rooms.length} room${rooms.length > 1 ? "s" : ""} · ${doorCount} door${doorCount !== 1 ? "s" : ""}` : undefined}
          open={openSteps.has(2)}
          onToggle={() => toggleStep(2)}
        >
          <p className="step-description">Draw and label the rooms in your apartment.</p>

          <div className="room-chips">
            {ROOM_TOOLS.map((tool) => (
              <button
                key={tool.id}
                className={`room-chip${selectedTool === tool.id ? " active" : ""}`}
                type="button"
                style={{ "--chip-color": tool.color } as CSSProperties}
                onClick={() => onSelectTool(tool.id)}
              >
                {tool.chipLabel}
              </button>
            ))}
            <button type="button" className="room-chip-reset" onClick={onReset}>Reset</button>
          </div>

          <div className="draw-controls">
            <div className="draw-mode-group">
              <button type="button" className={`draw-mode-btn${drawMode === "rectangle" ? " active" : ""}`}
                title="Rectangle mode" onClick={() => onSetDrawMode("rectangle")}>
                <IconRect /> Rectangle
              </button>
              <button type="button" className={`draw-mode-btn${drawMode === "lines" ? " active" : ""}`}
                title="Free shape mode" onClick={() => onSetDrawMode("lines")}>
                <IconLines /> Free shape
              </button>
            </div>
            <div className={`ortho-inline${orthoMode ? " active" : ""}`}>
              <span className="ortho-label">Orthogonal</span>
              <button type="button" className={`ortho-toggle${orthoMode ? " active" : ""}`}
                onClick={onToggleOrtho} title="Constrain to right angles" aria-pressed={orthoMode} />
            </div>
          </div>


          <button className={`step-btn primary wide${selectedTool === "doors" ? " active" : ""}`}
            type="button" onClick={() => onSelectTool("doors")}>
            Place doors{doorCount > 0 ? ` (${doorCount})` : ""}
          </button>
          <button className={`step-btn primary wide${selectedTool === "windows" ? " active" : ""}`}
            type="button" onClick={() => onSelectTool("windows")}>
            Place windows{windowCount > 0 ? ` (${windowCount})` : ""}
          </button>
        </PipelineStep>

        {/* ── 03 Choose furniture ── */}
        <PipelineStep
          number="03"
          title="Choose furniture"
          meta={overrideLabel}
          open={openSteps.has(3)}
          onToggle={() => toggleStep(3)}
        >
          <p className="step-description">Set up the furniture recipes for each room.</p>

          <div className="apt-type-row">
            <span className="apt-type-label">Type</span>
            <div className="apt-type-buttons">
              {[1, 2, 3, 4, 5].map((t) => (
                <button key={t} type="button"
                  className={`apt-type-btn${aptType === t ? " active" : ""}`}
                  title={pipelineConfig.aptTypeOverride === t ? "Click to clear override" : `Set apartment type ${t === 5 ? "5+" : t}`}
                  onClick={() => onSetAptType(pipelineConfig.aptTypeOverride === t ? null : t)}>
                  {t === 5 ? "5+" : t}
                </button>
              ))}
            </div>
            {pipelineConfig.aptTypeOverride !== null && (
              <span className="apt-type-override-badge">override</span>
            )}
          </div>

          {activeSections.length === 0 ? (
            <p className="step-description">Draw rooms first to configure furniture.</p>
          ) : (
            <div className="room-sections-list">
              {activeSections.map((section) => (
                <RoomSectionPanel key={section} section={section} aptType={aptType}
                  pipelineConfig={pipelineConfig} onUpdateRoomSteps={onUpdateRoomSteps} />
              ))}
            </div>
          )}
        </PipelineStep>
        </div>
      </div>
    </aside>
  );
}
