// ─── Apartment JSON (shell only) ──────────────────────────────────────────────
// Parses an uploaded apartment description that carries the APARTMENT SHELL —
// the outer contour plus its entrance door and windows — with no rooms. The
// rooms are then traced by hand inside the loaded contour.
//
// Minimal accepted document (metres, y downward on screen):
//
//   {
//     "id": "A4",
//     "units": "meters",
//     "outline":  [ { "x": 0, "y": 0 }, … ],
//     "door":     { "midpoint": { "x": 5.725, "y": 6.25 }, "width": 0.9 },
//     "windows": [ { "midpoint": { "x": 1.75,  "y": 0    }, "width": 1.5 } ]
//   }
//
// Tolerated variations: `outline` may also be called `contour`, `polygon` or
// `points`, and its points may be `[x, y]` tuples; the closing point may repeat
// the first or not. `door` may be a list (`doors`). Opening midpoints may be
// called `position` or `point`. `units` may be m / cm / mm. `wallThickness`
// (metres) and `yUp` (flip the y axis on import) are optional.

import type { Point2D } from "./types";

export type ApartmentOpening = { point: Point2D; width: number };

export type ParsedApartment = {
  id: string | null;
  /** Open ring — the repeated closing vertex is stripped. */
  outline: Point2D[];
  doors: ApartmentOpening[];
  windows: ApartmentOpening[];
  /** Metres, when the document states one — otherwise null and the outer-wall
   *  thickness from the Walls settings applies. */
  wallThickness: number | null;
};

export const DEFAULT_DOOR_WIDTH = 0.9;
export const DEFAULT_WINDOW_WIDTH = 1.5;

const UNIT_SCALE: Record<string, number> = {
  m: 1, meter: 1, meters: 1, metre: 1, metres: 1,
  cm: 0.01, centimeter: 0.01, centimeters: 0.01, centimetre: 0.01, centimetres: 0.01,
  mm: 0.001, millimeter: 0.001, millimeters: 0.001, millimetre: 0.001, millimetres: 0.001,
};

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readPoint(raw: unknown): Point2D | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const [x, y] = raw;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
    return null;
  }
  if (isRecord(raw)) {
    const { x, y } = raw;
    if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y };
    }
  }
  return null;
}

function readOpening(raw: unknown, fallbackWidth: number): ApartmentOpening | null {
  if (!isRecord(raw)) {
    // A bare point is still a usable opening — it just takes the default width.
    const p = readPoint(raw);
    return p ? { point: p, width: fallbackWidth } : null;
  }
  const point = readPoint(raw.midpoint ?? raw.position ?? raw.point ?? raw.center ?? raw);
  if (!point) return null;
  const width = typeof raw.width === "number" && raw.width > 0 ? raw.width : fallbackWidth;
  return { point, width };
}

function asList(raw: unknown): unknown[] {
  if (raw == null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** Parse an uploaded apartment shell. Throws an Error with a message meant to be
 *  shown to the user when the document can't be used. */
export function parseApartmentJson(text: string): ParsedApartment {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("Apartment JSON: the file is not valid JSON.");
  }
  if (!isRecord(doc)) throw new Error("Apartment JSON: expected a single apartment object.");

  const unitsRaw = typeof doc.units === "string" ? doc.units.trim().toLowerCase() : "meters";
  const unit = UNIT_SCALE[unitsRaw];
  if (unit === undefined) {
    throw new Error(`Apartment JSON: unknown units "${doc.units}" — use meters, centimeters or millimeters.`);
  }
  const flipY = doc.yUp === true ? -1 : 1;
  const scalePt = (p: Point2D): Point2D => ({ x: p.x * unit, y: p.y * unit * flipY });

  const outlineRaw = doc.outline ?? doc.contour ?? doc.polygon ?? doc.points;
  if (!Array.isArray(outlineRaw)) {
    throw new Error("Apartment JSON: missing an `outline` array of contour points.");
  }
  const outline: Point2D[] = [];
  for (const raw of outlineRaw) {
    const p = readPoint(raw);
    if (!p) throw new Error("Apartment JSON: every outline point needs numeric x and y.");
    outline.push(scalePt(p));
  }
  // Drop a repeated closing vertex (and any duplicate consecutive points).
  const ring: Point2D[] = [];
  for (const p of outline) {
    const prev = ring[ring.length - 1];
    if (prev && Math.abs(prev.x - p.x) < 1e-9 && Math.abs(prev.y - p.y) < 1e-9) continue;
    ring.push(p);
  }
  while (
    ring.length > 1 &&
    Math.abs(ring[0].x - ring[ring.length - 1].x) < 1e-9 &&
    Math.abs(ring[0].y - ring[ring.length - 1].y) < 1e-9
  ) {
    ring.pop();
  }
  if (ring.length < 3) {
    throw new Error("Apartment JSON: the outline needs at least 3 distinct points.");
  }

  const doors: ApartmentOpening[] = [];
  for (const raw of [...asList(doc.door), ...asList(doc.doors), ...asList(doc.entrance), ...asList(doc.entrances)]) {
    const o = readOpening(raw, DEFAULT_DOOR_WIDTH);
    if (o) doors.push({ point: scalePt(o.point), width: o.width * unit });
  }

  const windows: ApartmentOpening[] = [];
  for (const raw of [...asList(doc.window), ...asList(doc.windows)]) {
    const o = readOpening(raw, DEFAULT_WINDOW_WIDTH);
    if (o) windows.push({ point: scalePt(o.point), width: o.width * unit });
  }

  const wallThickness =
    typeof doc.wallThickness === "number" && doc.wallThickness > 0
      ? doc.wallThickness * unit
      : null;

  return {
    id: typeof doc.id === "string" ? doc.id : null,
    outline: ring,
    doors,
    windows,
    wallThickness,
  };
}
