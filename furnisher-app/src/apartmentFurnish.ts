// Trace & Furnish → the engine's apartment-level entry point (`furnishApartment`, the code the CLI runs for the
// Building Composer): the drawn rooms become ONE request (rooms in drawing order without halls / corridors, all door
// points of the apartment, windows, kitchens' subtype / open flag), so open-kitchen detection (including the 1 cm
// geometric rule when polygons are moved), passages, kitchens before living rooms and the bar with stools all hold
// while editing. The full per-room pipeline results (`detail`) are mapped back onto the app's FurnishedRoomResult so
// the canvas, option stepping and furniture dragging keep working.
//
// Frames: a layout opened from the composer archive is drawn with y = −y_plan (north up on the y-down canvas); the
// request is built with y negated back (exact in floating point), and the results are negated again for display.

import { furnishApartment } from "@engine/apartment";
import { detectOpenKitchens, openKitchenHint, splitPassages } from "@engine/openKitchen";
import type { ApartmentRequest, ApartmentResult, RoomInput } from "@engine/apartment";
import type { PlacedFurniture, PlacementOption, StepOptions } from "@engine/types";
import type { PipelineOptions } from "@engine/index";
import type { DrawnRoom, FurnishedRoomResult, Point2D } from "./types";
import { isCirculationRoom } from "./types";

type P = [number, number];

function area(points: Point2D[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.round((Math.abs(a) / 2) * 1000) / 1000;
}

export type ApartmentRun = {
  request: Omit<ApartmentRequest, "rooms"> & { rooms: (RoomInput & { area: number })[] };
  /** room ids of the request's rooms, in request order */
  roomIds: string[];
};

/** The apartment request of the drawn rooms. `flipY`: the rooms are drawn with y = −y_engine. */
export function buildApartmentRequest(
  rooms: DrawnRoom[],
  opts: { flipY: boolean; aptType: number | null; flexibleKitchen: boolean; selections?: Record<string, number[]> },
): ApartmentRun {
  const s = opts.flipY ? -1 : 1;
  const pt = (p: Point2D): P => [p.x, s * p.y];
  const furnishable = rooms.filter((r) => !isCirculationRoom(r.type) && r.points.length >= 3);
  // every door point of the apartment: the imported ones as imported (in their order, repeats kept, as the request
  // had them), then the others once each (a drawn door is usually stored on both rooms it joins)
  const doors: { p: P; order: number }[] = [];
  const seen = new Set<string>();
  for (const r of rooms) {
    r.doors.forEach((d, i) => {
      const order = r.doorOrder?.[i];
      if (order === undefined) return;
      const p = pt(d);
      seen.add(`${p[0]},${p[1]}`);
      doors.push({ p, order });
    });
  }
  for (const r of rooms) {
    r.doors.forEach((d, i) => {
      if (r.doorOrder?.[i] !== undefined) return;
      const p = pt(d);
      const k = `${p[0]},${p[1]}`;
      if (seen.has(k)) return;
      seen.add(k);
      doors.push({ p, order: Number.POSITIVE_INFINITY });
    });
  }
  doors.sort((a, b) => a.order - b.order);
  const request: ApartmentRun["request"] = {
    rooms: furnishable.map((r) => ({
      name: r.type,
      polygon: r.points.map(pt),
      windows: r.windows.map(pt),
      area: area(r.points),
      ...(r.subtype ? { subtype: r.subtype } : {}),
      ...(r.open === true || r.open === false ? { open: r.open } : {}),
    })),
    doors: doors.map((d) => d.p),
    ...(opts.aptType !== null ? { aptType: opts.aptType } : {}),
    ...(opts.flexibleKitchen ? { flexibleKitchen: true } : {}),
  };
  const sel = furnishable.map((r) => opts.selections?.[r.id] ?? []);
  if (sel.some((x) => x.some((v) => v !== 0))) {
    request.selections = sel;
    request.selectionMode = "flat";
  }
  return { request, roomIds: furnishable.map((r) => r.id) };
}

/** Where the drawn apartment has no wall: every open kitchen's openings (both rooms' sides) and the door points
 *  lying on them (passages: no door leaf), decided by the engine's own rule (engine/openKitchen.ts) on the drawn
 *  outlines, so the drawn walls follow what the furnisher assumes. Works in the drawing's frame (the rule doesn't
 *  depend on orientation). */
export function kitchenOpenings(rooms: DrawnRoom[]): { segments: [Point2D, Point2D][]; passages: Point2D[] } {
  const pt = (p: Point2D): P => [p.x, p.y];
  const back = (q: P): Point2D => ({ x: q[0], y: q[1] });
  const list = rooms.filter((r) => !isCirculationRoom(r.type) && r.points.length >= 3);
  const out = { segments: [] as [Point2D, Point2D][], passages: [] as Point2D[] };
  let info;
  try {
    info = detectOpenKitchens(list.map((r) => ({
      name: r.type,
      polygon: r.points.map(pt),
      hint: r.type === "Kitchen" ? openKitchenHint(r.type, r.subtype, r.open) : undefined,
    })));
  } catch {
    return out;
  }
  const doors = rooms.flatMap((r) => r.doors.map(pt));
  info.forEach((o) => {
    if (!o.openSegments.length) return;
    for (const [a, b] of o.openSegments) out.segments.push([back(a), back(b)]);
    for (const p of splitPassages(doors, o.openSegments, o.gap).passages) out.passages.push(back(p));
  });
  return out;
}

/** The composer's apartment score of a result (area-weighted, E10 furnish.score_row / furn2.report_of). */
export function apartmentScore(run: ApartmentRun, result: ApartmentResult): { score: number; complete: boolean } {
  let w = 0;
  let a = 0;
  let complete = true;
  run.request.rooms.forEach((r, i) => {
    const rm = result.rooms[i];
    if (!rm) return;
    w += (rm.score ?? 0) * r.area;
    a += r.area;
    complete = complete && !rm.error && rm.steps.length > 0 && rm.steps.every((st) => st.optionCount >= 1);
  });
  return { score: a ? Math.round((w / a) * 100) / 100 : 0, complete };
}

const flipPts = (list: readonly P[]): P[] => list.map(([x, y]) => [x, -y]);

function flipPlaced(p: PlacedFurniture): PlacedFurniture {
  return {
    ...p,
    transformedGeometry: p.transformedGeometry.map((g) => ({ ...g, points: flipPts(g.points) })),
    transformedBbox: flipPts(p.transformedBbox),
    transformedSmallBbox: flipPts(p.transformedSmallBbox),
    wallSegment: flipPts(p.wallSegment) as [P, P],
    smallCutout: flipPts(p.smallCutout),
    largeCutout: flipPts(p.largeCutout),
    ...(p.modules ? { modules: p.modules.map((m) => ({ footprint: flipPts(m.footprint), clearance: flipPts(m.clearance) })) } : {}),
  };
}

const flipOption = (o: PlacementOption): PlacementOption => ({ ...o, placed: flipPlaced(o.placed) });

/** Run the apartment and map it onto the app's per-room results. */
export function furnishDrawnApartment(
  rooms: DrawnRoom[],
  opts: {
    flipY: boolean;
    aptType: number | null;
    flexibleKitchen: boolean;
    selections?: Record<string, number[]>;
    /** the app's customised library / placement order; omitted when nothing is customised (= the CLI's) */
    pipeline?: Pick<PipelineOptions, "library" | "pipeline">;
  },
): { run: ApartmentRun; result: ApartmentResult; furnished: FurnishedRoomResult[]; score: number; complete: boolean } {
  const run = buildApartmentRequest(rooms, opts);
  const result = furnishApartment(run.request, { detail: true, ...(opts.pipeline ?? {}) });
  const furnished: FurnishedRoomResult[] = result.rooms.map((rm, i) => {
    const det = result.detail?.rooms[i] ?? null;
    const warnings = [...new Set([...(rm.error ? [rm.error] : []), ...rm.warnings])];
    if (!det) return { roomId: run.roomIds[i], roomName: rm.name as FurnishedRoomResult["roomName"], steps: [], warnings };
    let steps: StepOptions[] = det.result.steps.map((st) => ({ ...st }));
    // the bar (and its stools) is drawn into the kitchen step's geometry
    if (rm.bar && steps[0]?.selected) {
      const sel = steps[0].selected;
      steps[0] = { ...steps[0], selected: { ...sel, placed: { ...sel.placed, transformedGeometry: rm.steps[0].geometry } } };
    }
    if (opts.flipY) {
      steps = steps.map((st) => ({ ...st, allOptions: st.allOptions.map(flipOption), selected: st.selected ? flipOption(st.selected) : null }));
    }
    return { roomId: run.roomIds[i], roomName: rm.name as FurnishedRoomResult["roomName"], steps, warnings };
  });
  return { run, result, furnished, ...apartmentScore(run, result) };
}

/** The rooms of a composer archive layout for Trace & Furnish, in the request's frame (y up): the request's rooms in
 *  request order (cell polygons, windows, subtype / open), then the drawing's other rooms (corridors); each door
 *  point on the first room whose outline it lies on, with its index in the request's door list. */
export function archiveLayoutRooms(layout: {
  request: { rooms: { name: string; polygon: P[]; windows?: P[]; subtype?: string | null; open?: boolean | null }[]; doors?: P[] };
  request_chars: string[];
  draw: { rooms: { key: string; type: string; rings: P[][] }[] };
}) {
  const known = ["Bedroom", "Living room", "Kitchen", "Bathroom", "WC", "Children", "Hall", "Corridor"];
  const typeOf = (name: string) => (known.includes(name) ? name : "Corridor") as DrawnRoom["type"];
  const pt = (q: P): Point2D => ({ x: q[0], y: q[1] });
  type In = { type: DrawnRoom["type"]; points: Point2D[]; doors: Point2D[]; doorOrder: number[]; windows: Point2D[]; subtype: string | null; open: boolean | null };
  const req: In[] = layout.request.rooms.map((r) => ({
    type: typeOf(r.name), points: r.polygon.map(pt), doors: [], doorOrder: [], windows: (r.windows ?? []).map(pt),
    subtype: r.subtype ?? null, open: r.open ?? null,
  }));
  const inReq = new Set(layout.request_chars);
  const others: In[] = layout.draw.rooms
    .filter((r) => !inReq.has(r.key))
    .map((r) => ({ type: typeOf(r.type), points: (r.rings[0] ?? []).map(pt), doors: [], doorOrder: [], windows: [], subtype: r.type, open: null }));
  const all = [...req, ...others];
  const onBoundary = (p: Point2D, poly: Point2D[]) =>
    poly.some((a, i) => {
      const b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= 0.01;
    });
  (layout.request.doors ?? []).forEach((d, i) => {
    const p = pt(d);
    const host = all.find((r) => onBoundary(p, r.points)) ?? all[0];
    host.doors.push(p);
    host.doorOrder.push(i);
  });
  return all;
}
