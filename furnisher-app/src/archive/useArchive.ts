// State of the "Composer archive" browser: the dataset (index + chunks loaded on demand), filters, the current
// layout, and its furnishing by the engine (in a worker, cached per layout / wall mode / selections, the next layout
// prefetched).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApartmentRequest } from "@engine/apartment";
import { planWalls } from "./composerDraw";
import type { XY } from "./composerDraw";
import { thickWalls, insetPolygon } from "./archiveWalls";
import type { ThickWalls } from "./archiveWalls";
import { composerScore } from "./types";
import type { ArchiveIndex, ArchiveIndexRow, ArchiveLayout, Furnished, WallMode } from "./types";
import type { FurnishJob, FurnishReply } from "./furnishWorker";

export const DATASET_URL = `${import.meta.env.BASE_URL}archive/composer/`;

export type OpenFilter = "all" | "yes" | "no";
export type ArchiveSort = "id" | "stored-asc" | "stored-desc" | "area-asc" | "area-desc";
export type ArchiveFilters = {
  aptType: string;
  open: OpenFilter;
  brief: string;
  scoreMin: string;
  scoreMax: string;
  sort: ArchiveSort;
  /** hide the layouts the studio's measure path would not furnish (no entrance room) */
  hideUnfurnished: boolean;
};

const DEFAULT_FILTERS: ArchiveFilters = { aptType: "all", open: "all", brief: "all", scoreMin: "", scoreMax: "", sort: "id", hideUnfurnished: true };

type Pending = { key: string; request: ApartmentRequest; resolve: (r: FurnishReply) => void };

/** One worker, one job at a time; the current layout jumps the queue, prefetches wait behind it. */
class FurnishQueue {
  private worker: Worker | null = null;
  private queue: Pending[] = [];
  private running: Pending | null = null;
  private inflight = new Map<string, Promise<FurnishReply>>();

  run(key: string, request: ApartmentRequest, urgent: boolean): Promise<FurnishReply> {
    const known = this.inflight.get(key);
    if (known) {
      if (urgent) {
        const i = this.queue.findIndex((p) => p.key === key);
        if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
      }
      return known;
    }
    const p = new Promise<FurnishReply>((resolve) => {
      const job = { key, request, resolve };
      if (urgent) this.queue.unshift(job);
      else this.queue.push(job);
    });
    this.inflight.set(key, p);
    p.then(() => this.inflight.delete(key));
    this.pump();
    return p;
  }

  /** Drop queued (not running) prefetches. */
  trim(keep: (key: string) => boolean) {
    const dropped = this.queue.filter((p) => !keep(p.key));
    this.queue = this.queue.filter((p) => keep(p.key));
    for (const d of dropped) {
      this.inflight.delete(d.key);
      d.resolve({ key: d.key, ok: false, error: "cancelled" });
    }
  }

  private pump() {
    if (this.running || !this.queue.length) return;
    if (!this.worker) {
      this.worker = new Worker(new URL("./furnishWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev: MessageEvent<FurnishReply>) => {
        const job = this.running;
        this.running = null;
        job?.resolve(ev.data);
        this.pump();
      };
      this.worker.onerror = (ev) => {
        const job = this.running;
        this.running = null;
        job?.resolve({ key: job.key, ok: false, error: ev.message || "worker error" });
        this.worker?.terminate();
        this.worker = null;
        this.pump();
      };
    }
    this.running = this.queue.shift()!;
    this.worker.postMessage({ key: this.running.key, request: this.running.request } satisfies FurnishJob);
  }
}

function num(s: string): number | null {
  if (s.trim() === "") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

export function filterRows(rows: ArchiveIndexRow[], f: ArchiveFilters): ArchiveIndexRow[] {
  const lo = num(f.scoreMin);
  const hi = num(f.scoreMax);
  const out = rows.filter((r) => {
    if (f.hideUnfurnished && r.studio === false) return false;
    if (f.aptType !== "all" && r.aptType !== f.aptType) return false;
    if (f.open === "yes" && !r.open) return false;
    if (f.open === "no" && r.open) return false;
    if (f.brief !== "all" && !r.briefs.includes(f.brief)) return false;
    if (lo !== null || hi !== null) {
      if (r.storedScore === null) return false;
      if (lo !== null && r.storedScore < lo) return false;
      if (hi !== null && r.storedScore > hi) return false;
    }
    return true;
  });
  const by = (key: (r: ArchiveIndexRow) => number | null, dir: 1 | -1) =>
    out.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if (x === null && y === null) return a.id.localeCompare(b.id);
      if (x === null) return 1;
      if (y === null) return -1;
      return (x - y) * dir || a.id.localeCompare(b.id);
    });
  if (f.sort === "stored-asc") by((r) => r.storedScore, 1);
  else if (f.sort === "stored-desc") by((r) => r.storedScore, -1);
  else if (f.sort === "area-asc") by((r) => r.area, 1);
  else if (f.sort === "area-desc") by((r) => r.area, -1);
  return out;
}

/** The walls drawn for a layout (and, in "inset" mode, the request pulled inside them). */
export function wallsOf(layout: ArchiveLayout): ThickWalls {
  const d = layout.draw;
  const windows = layout.request.rooms.flatMap((r) => (r.windows ?? []) as XY[]);
  return thickWalls(d, planWalls(d), windows, d.facade);
}

export function requestFor(layout: ArchiveLayout, mode: WallMode, walls: ThickWalls, selections?: number[][]): ApartmentRequest {
  const base = layout.request;
  const rooms = mode === "inset"
    ? base.rooms.map((r) => ({ ...r, polygon: insetPolygon(r.polygon as XY[], walls.uncut) }))
    : base.rooms;
  const req: ApartmentRequest = { ...base, rooms, ...(mode === "inset" ? { roomsInsideWalls: true } : {}) };
  if (selections && selections.some((s) => s.some((v) => v !== 0))) {
    req.selections = selections;
    req.selectionMode = "flat";
  }
  return req;
}

export function useArchive(active: boolean) {
  const [index, setIndex] = useState<ArchiveIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFiltersState] = useState<ArchiveFilters>(DEFAULT_FILTERS);
  const [pos, setPos] = useState(0);
  const [wallMode, setWallMode] = useState<WallMode>("inset");
  const [selections, setSelections] = useState<Record<string, number[][]>>({});
  const [layout, setLayout] = useState<ArchiveLayout | null>(null);
  const [furnished, setFurnished] = useState<Furnished | null>(null);
  const [busy, setBusy] = useState(false);
  const [furnishError, setFurnishError] = useState<string | null>(null);
  const [selectedRoom, setSelectedRoom] = useState<number | null>(null);

  const chunks = useRef(new Map<string, Promise<Map<string, ArchiveLayout>>>());
  const results = useRef(new Map<string, Furnished>());
  const queue = useRef<FurnishQueue | null>(null);
  if (!queue.current) queue.current = new FurnishQueue();

  const loadIndex = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch(`${DATASET_URL}index.json`, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = (await r.json()) as ArchiveIndex;
      if (!doc || !Array.isArray(doc.layouts)) throw new Error("not an archive index");
      chunks.current.clear();
      results.current.clear();
      setIndex(doc);
      setPos(0);
    } catch (e) {
      setLoadError(
        `No composer archive dataset at public/archive/composer/ (${e instanceof Error ? e.message : String(e)}). ` +
          "Export it first (see the command below).",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active && !index && !loading && !loadError) void loadIndex();
  }, [active, index, loading, loadError, loadIndex]);

  const rows = useMemo(() => (index ? filterRows(index.layouts, filters) : []), [index, filters]);
  const current = rows.length ? rows[Math.min(pos, rows.length - 1)] : null;

  const setFilters = useCallback((patch: Partial<ArchiveFilters>) => {
    setFiltersState((f) => ({ ...f, ...patch }));
    setPos(0);
  }, []);

  const go = useCallback((delta: number) => {
    setPos((p) => (rows.length ? (((p + delta) % rows.length) + rows.length) % rows.length : 0));
  }, [rows.length]);
  const goTo = useCallback((i: number) => setPos(Math.max(0, Math.min(rows.length - 1, i))), [rows.length]);

  const getLayout = useCallback((row: ArchiveIndexRow): Promise<ArchiveLayout | undefined> => {
    let p = chunks.current.get(row.chunk);
    if (!p) {
      p = fetch(`${DATASET_URL}${row.chunk}`)
        .then((r) => {
          if (!r.ok) throw new Error(`${row.chunk}: HTTP ${r.status}`);
          return r.json();
        })
        .then((doc: { layouts: ArchiveLayout[] }) => new Map(doc.layouts.map((l) => [l.id, l])));
      p.catch(() => chunks.current.delete(row.chunk));
      chunks.current.set(row.chunk, p);
    }
    return p.then((m) => m.get(row.id));
  }, []);

  const walls = useMemo(() => (layout ? wallsOf(layout) : null), [layout]);
  const keyOf = (id: string, mode: WallMode, sel?: number[][]) => `${id}|${mode}|${sel ? JSON.stringify(sel) : ""}`;

  const furnish = useCallback(
    async (l: ArchiveLayout, w: ThickWalls, mode: WallMode, sel: number[][] | undefined, urgent: boolean): Promise<Furnished | string> => {
      const key = keyOf(l.id, mode, sel);
      const hit = results.current.get(key);
      if (hit) return hit;
      const request = requestFor(l, mode, w, sel);
      const reply = await queue.current!.run(key, request, urgent);
      if (!reply.ok) return reply.error;
      const { score, complete } = composerScore(l.request, reply.result);
      const f: Furnished = { key, result: reply.result, score, complete, ms: reply.ms, request };
      results.current.set(key, f);
      return f;
    },
    [],
  );

  // the current layout: load, furnish, then prefetch the next one
  const currentId = current?.id ?? null;
  const sel = currentId ? selections[currentId] : undefined;
  useEffect(() => {
    if (!current) {
      setLayout(null);
      setFurnished(null);
      return;
    }
    let alive = true;
    setFurnishError(null);
    void (async () => {
      let l: ArchiveLayout | undefined;
      try {
        l = await getLayout(current);
      } catch (e) {
        if (alive) setFurnishError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!alive) return;
      if (!l) {
        setFurnishError(`layout ${current.id} is not in ${current.chunk}`);
        return;
      }
      setLayout((prev) => (prev?.id === l!.id ? prev : l!));
      const w = wallsOf(l);
      const key = keyOf(l.id, wallMode, sel);
      const hit = results.current.get(key);
      if (hit) {
        setFurnished(hit);
        setBusy(false);
      } else {
        setFurnished((f) => (f && f.key.startsWith(`${l!.id}|`) ? f : null));
        setBusy(true);
        const next = rows.length > 1 ? rows[(rows.indexOf(current) + 1) % rows.length] : null;
        queue.current!.trim((k) => k === key || (next !== null && k.startsWith(`${next.id}|`)));
        const out = await furnish(l, w, wallMode, sel, true);
        if (!alive) return;
        setBusy(false);
        if (typeof out === "string") {
          if (out !== "cancelled") setFurnishError(out);
        } else setFurnished(out);
      }
      // prefetch the next layout in the list (default selections, same wall mode)
      const next = rows.length > 1 ? rows[(rows.indexOf(current) + 1) % rows.length] : null;
      if (next && alive) {
        const nl = await getLayout(next).catch(() => undefined);
        if (nl && alive) void furnish(nl, wallsOf(nl), wallMode, selections[nl.id], false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, wallMode, JSON.stringify(sel ?? null), index]);

  useEffect(() => setSelectedRoom(null), [currentId]);

  /** Choose option `k` (0 = best) of step `stepIndex` of request room `roomIndex`; later steps go back to their best. */
  const chooseOption = useCallback(
    (roomIndex: number, stepIndex: number, k: number) => {
      if (!layout || !furnished) return;
      const n = layout.request.rooms.length;
      const base = selections[layout.id] ?? Array.from({ length: n }, () => [] as number[]);
      const room = furnished.result.rooms[roomIndex];
      const cur = room.steps.map((s) => Math.max(0, s.selectedIndex));
      const next = [...cur.slice(0, stepIndex), Math.max(0, k)];
      const all = base.map((s, i) => (i === roomIndex ? next : s));
      setSelections((m) => ({ ...m, [layout.id]: all }));
    },
    [layout, furnished, selections],
  );

  const resetOptions = useCallback(() => {
    if (!layout) return;
    setSelections((m) => {
      const { [layout.id]: _drop, ...rest } = m;
      void _drop;
      return rest;
    });
  }, [layout]);

  return {
    index, loading, loadError, loadIndex,
    filters, setFilters, rows, pos: Math.min(pos, Math.max(0, rows.length - 1)), go, goTo, current,
    layout, walls, furnished, busy, furnishError,
    wallMode, setWallMode,
    selectedRoom, setSelectedRoom,
    hasSelections: !!(layout && selections[layout.id]),
    chooseOption, resetOptions,
  };
}

export type ArchiveState = ReturnType<typeof useArchive>;
