// The plan of the current composer layout: rooms, walls with thickness (exterior 0.30 m, interior 0.10 m, centred on
// the grid line), open runs dashed, doors as the composer's canvas draws them, windows, the engine's furniture (bar
// and stools included), room names with the engine's score and the composer's stored score. Plan metres, y up: the
// geometry is drawn inside a y-flipped group; text is placed outside it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { planWalls } from "./composerDraw";
import type { XY } from "./composerDraw";
import type { ArchiveState } from "./useArchive";

export type ArchiveShow = { furniture: boolean; clearances: boolean; openings: boolean; labels: boolean };

const ROOM_FILL: Record<string, string> = {
  "Living room": "#788C5D", Studio: "#788C5D", Bedroom: "#5E84A8", Children: "#CBA13F", Kitchen: "#C2873F",
  "Open kitchen": "#C2873F", Bathroom: "#5F9B95", WC: "#9A7AA0", Corridor: "#A79C88",
};

const path = (pts: XY[], closed = true) => (pts.length ? `M ${pts.map((p) => `${p[0]} ${p[1]}`).join(" L ")}${closed ? " Z" : ""}` : "");
const ringsPath = (rings: XY[][]) => rings.map((r) => path(r)).join(" ");
const segsPath = (segs: { a: XY; b: XY }[]) => segs.map((s) => `M ${s.a[0]} ${s.a[1]} L ${s.b[0]} ${s.b[1]}`).join(" ");

function fmt(v: number | null | undefined, d = 1) {
  return v === null || v === undefined ? "–" : v.toFixed(d);
}

export function ArchiveCanvas({ state, show }: { state: ArchiveState; show: ArchiveShow }) {
  const { layout, walls, furnished, wallMode, selectedRoom, setSelectedRoom } = state;
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<{ cx: number; cy: number; span: number } | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 600 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // fit on every new layout (screen y = -plan y)
  const box = useMemo(() => {
    if (!layout) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of layout.draw.rooms) for (const ring of r.rings) for (const [x, y] of ring) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { x0, y0, x1, y1 };
  }, [layout]);
  useEffect(() => {
    if (box) setView({ cx: (box.x0 + box.x1) / 2, cy: -(box.y0 + box.y1) / 2, span: Math.max(box.x1 - box.x0, box.y1 - box.y0) + 2.2 });
  }, [box]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => (v ? { ...v, span: Math.min(80, Math.max(2, v.span * (e.deltaY > 0 ? 1.12 : 0.89))) } : v));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const pw = useMemo(() => (layout ? planWalls(layout.draw) : null), [layout]);
  const charToReq = useMemo(() => new Map((layout?.request_chars ?? []).map((c, i) => [c, i])), [layout]);

  if (!layout || !walls || !pw || !view) {
    return <div ref={wrap} className="arch-canvas" />;
  }

  const aspect = size.w / Math.max(1, size.h);
  const vw = aspect >= 1 ? view.span * aspect : view.span;
  const vh = aspect >= 1 ? view.span : view.span / aspect;
  const vb = `${view.cx - vw / 2} ${view.cy - vh / 2} ${vw} ${vh}`;
  const px = vw / size.w; // metres per screen pixel

  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setView((v) => (v ? { ...v, cx: d.cx - (e.clientX - d.x) * px, cy: d.cy - (e.clientY - d.y) * px } : v));
  };
  const onUp = () => {
    drag.current = null;
  };

  const res = furnished?.result;
  const storedBy = new Map((layout.stored?.rooms ?? []).map((r) => [r.char, r]));

  return (
    <div ref={wrap} className="arch-canvas">
      <svg
        className="arch-svg"
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        <g transform="scale(1 -1)">
          {/* rooms */}
          {layout.draw.rooms.map((r) => {
            const ri = charToReq.get(r.key);
            return (
              <path
                key={r.key}
                d={ringsPath(r.rings)}
                fill={ROOM_FILL[r.type] ?? "#999"}
                fillOpacity={selectedRoom !== null && ri === selectedRoom ? 0.32 : 0.16}
                fillRule="evenodd"
                className="arch-room"
                onClick={() => setSelectedRoom(ri ?? null)}
              />
            );
          })}

          {/* furnishing boundary actually sent (inset mode) */}
          {wallMode === "inset" && furnished &&
            furnished.request.rooms.map((r, i) => <path key={i} d={path(r.polygon as XY[])} className="arch-inset" strokeWidth={px * 1.2} />)}

          {/* engine door clearances, passages and opening sides */}
          {res && show.clearances &&
            res.rooms.flatMap((rm, i) => rm.doors.map((d, j) => <path key={`c${i}-${j}`} d={path(d.rect as XY[])} className="arch-clearance" />))}
          {res && show.openings &&
            res.rooms.flatMap((rm, i) => (rm.openSegments ?? []).map((s, j) => (
              <line key={`o${i}-${j}`} x1={s[0][0]} y1={s[0][1]} x2={s[1][0]} y2={s[1][1]} className="arch-openseg" strokeWidth={px * 5} />
            )))}
          {res && show.openings &&
            res.rooms.map((rm, i) => rm.bar ? <path key={`z${i}`} d={path(rm.bar.stoolZone as XY[])} className="arch-stoolzone" /> : null)}
          {res && show.openings &&
            res.rooms.flatMap((rm, i) => (rm.extension?.zones ?? []).map((z, j) => <path key={`e${i}-${j}`} d={path(z as XY[])} className="arch-stoolzone" />))}

          {/* furniture */}
          {res && show.furniture && (
            <g className="arch-furniture">
              {res.rooms.flatMap((rm, i) =>
                rm.steps.flatMap((s, j) =>
                  s.geometry.map((g, k) => (
                    <path key={`${i}-${j}-${k}`} d={path(g.points as XY[], g.closed)} className={g.closed ? "closed" : "open"} />
                  )),
                ),
              )}
            </g>
          )}

          {/* walls with thickness, door and window openings cut */}
          <path d={walls.surface.map((poly) => ringsPath(poly)).join(" ")} className="arch-wall" fillRule="evenodd" />
          {pw.open.length > 0 && (
            <path d={segsPath(pw.open)} className="arch-open" strokeWidth={px * 1.4} strokeDasharray={`${px * 6} ${px * 4}`} />
          )}

          {/* windows */}
          {walls.windows.map((w, i) => {
            const off = (p: XY, s: number): XY => [p[0] + w.inward[0] * s, p[1] + w.inward[1] * s];
            const h = w.t / 2;
            return (
              <g key={i} className="arch-window" strokeWidth={px * 1}>
                <line x1={off(w.a, h)[0]} y1={off(w.a, h)[1]} x2={off(w.b, h)[0]} y2={off(w.b, h)[1]} />
                <line x1={w.a[0]} y1={w.a[1]} x2={w.b[0]} y2={w.b[1]} />
                <line x1={off(w.a, -h)[0]} y1={off(w.a, -h)[1]} x2={off(w.b, -h)[0]} y2={off(w.b, -h)[1]} />
              </g>
            );
          })}

          {/* doors as the composer's canvas draws them */}
          {walls.doors.map((d, i) => {
            const m: XY = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
            const ar = 0.22;
            const tip: XY = [m[0] + d.inward[0] * 0.05, m[1] + d.inward[1] * 0.05];
            const base: XY = [m[0] - d.inward[0] * (ar + 0.12), m[1] - d.inward[1] * (ar + 0.12)];
            const t: XY = [(d.b[0] - d.a[0]) / d.width, (d.b[1] - d.a[1]) / d.width];
            return (
              <g key={i} className={d.entrance ? "arch-door entrance" : "arch-door"}>
                <line x1={d.a[0]} y1={d.a[1]} x2={d.leaf[0]} y2={d.leaf[1]} strokeWidth={px * (d.entrance ? 2 : 1.4)} />
                <path d={`M ${d.leaf[0]} ${d.leaf[1]} A ${d.width} ${d.width} 0 0 ${d.sweep} ${d.b[0]} ${d.b[1]}`} strokeWidth={px * 0.9} className="swing" />
                {d.entrance && (
                  <path
                    className="arrow"
                    d={path([tip, [base[0] + t[0] * 0.12, base[1] + t[1] * 0.12], [base[0] - t[0] * 0.12, base[1] - t[1] * 0.12]])}
                  />
                )}
              </g>
            );
          })}
        </g>

        {/* labels (not flipped) */}
        {show.labels &&
          layout.draw.rooms.map((r) => {
            const ri = charToReq.get(r.key);
            const rm = ri !== undefined ? res?.rooms[ri] : undefined;
            const st = storedBy.get(r.key);
            const fs = Math.min(0.32, Math.max(0.16, px * 11));
            const engine = rm ? (rm.error ? "error" : fmt(rm.score)) : ri === undefined ? "" : "…";
            const stored = st && st.score !== null && st.score !== undefined ? fmt(st.score) : "";
            const differs = rm && st && rm.score !== null && st.score !== null && st.score !== undefined && Math.abs((rm.score ?? 0) - st.score) >= 0.05;
            return (
              <g key={r.key} className="arch-label">
                <text x={r.label[0]} y={-r.label[1] - fs * 0.35} fontSize={fs}>{r.name}</text>
                {ri !== undefined && (
                  <text x={r.label[0]} y={-r.label[1] + fs * 0.95} fontSize={fs * 0.9} className={differs ? "arch-label-score differs" : "arch-label-score"}>
                    {engine}{stored !== "" ? ` · ${stored}` : ""}
                  </text>
                )}
              </g>
            );
          })}
      </svg>
    </div>
  );
}
