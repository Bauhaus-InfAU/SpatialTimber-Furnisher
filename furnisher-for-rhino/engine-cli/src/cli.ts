// ─── Furnisher CLI ──────────────────────────────────────────────────────────
//
// Headless bridge between the Grasshopper plugin and the TypeScript furnisher
// engine. Reads ONE JSON request on stdin, runs the engine, writes ONE JSON
// response on stdout. All geometry is in metres, the engine's native unit.
//
// This deliberately mirrors the app's `toEngineRooms` / `inferApartmentType`
// logic so the plugin produces the same layouts the React app does.

// The engine emits many `[placer] ...` debug lines via console.log. stdout is
// our JSON channel, and a flood of these on stderr can fill the OS pipe buffer
// and stall the parent process, so we silence them entirely. Genuine errors are
// thrown (and surfaced via the JSON `error` field), not logged, so nothing is lost.
console.log = () => {};
console.debug = () => {};
console.info = () => {};

import { runRoomPipelineAt } from "../../../furnisher-engine/src/engine/index";
import type { RoomName, Point2D } from "../../../furnisher-engine/src/layout/types";

// ─── Request / response shapes (the wire contract with the C# plugin) ─────────

interface RoomInput {
  name: string;          // a RoomName, e.g. "Bedroom", "Children 1"
  polygon: Point2D[];    // closed ring, last point NOT repeated
  windows?: Point2D[];
}

interface Request {
  rooms: RoomInput[];
  doors?: Point2D[];
  aptType?: number;
  /**
   * "flat" (default): selections[room] = [flatIdx0, flatIdx1, ...]
   * "variant-position": selections[room] = [vi0, pos0, vi1, pos1, ...]
   *   where vi = variant index (shape), pos = position within that variant.
   */
  selectionMode?: "flat" | "variant-position";
  selections?: number[][];
}

interface VariantGroup {
  variantIndex: number;   // which variant shape (0-based)
  startFlatIndex: number; // first index in the flat allOptions array
  count: number;          // how many positions this shape has
}

interface StepOut {
  furnitureName: string;
  optionCount: number;     // total variant×position options (flat scroll range)
  selectedIndex: number;   // flat index chosen (-1 if none placeable)
  variantGroups: VariantGroup[]; // breakdown by shape, e.g. [{vi:0,start:0,count:8},...]
  selectedVariant: number; // which variant group is active (-1 if none)
  selectedPosition: number; // position within that variant group (-1 if none)
  geometry: { closed: boolean; points: Point2D[] }[];
  bbox: Point2D[];
  smallBbox: Point2D[];
}

interface RoomOut {
  name: string;
  steps: StepOut[];
  warnings: string[];
}

// ─── App-mirrored helpers ─────────────────────────────────────────────────────

const ADJACENT_DOOR_THRESHOLD = 0.4; // metres — matches the app

function polygonSignedArea(pts: Point2D[]): number {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** Engine wants CCW winding (positive signed area); reverse if needed. */
function normalizePolygon(pts: Point2D[]): Point2D[] {
  return polygonSignedArea(pts) < 0 ? [...pts].reverse() : pts;
}

function distPointToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distPointToPolygon(p: Point2D, poly: Point2D[]): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = distPointToSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (d < min) min = d;
  }
  return min;
}

/** Resolve a layer/room label to an engine RoomName. Children get numbered. */
const VALID_ROOM_NAMES = new Set<string>([
  "Bedroom", "Living room", "Bathroom", "WC", "Kitchen",
  "Children 1", "Children 2", "Children 3", "Children 4",
]);

function resolveRoomName(raw: string, childCounter: { n: number }): RoomName {
  // Strip an optional leading layer-number prefix ("01 Bedroom" → "Bedroom").
  const name = (raw ?? "").replace(/^\s*\d+[\s._-]*/, "").trim();
  if (/^children$/i.test(name)) {
    childCounter.n++;
    return `Children ${Math.min(4, childCounter.n)}` as RoomName;
  }
  // Canonicalise capitalisation for the known names.
  for (const valid of VALID_ROOM_NAMES) {
    if (valid.toLowerCase() === name.toLowerCase()) return valid as RoomName;
  }
  if (/^children\s*\d+$/i.test(name)) {
    const n = parseInt(name.replace(/\D+/g, ""), 10) || 1;
    return `Children ${Math.min(4, n)}` as RoomName;
  }
  // Fall back to the raw string; the engine will warn if it can't match.
  return name as RoomName;
}

/** Mirrors the app's inferApartmentType. */
function inferApartmentType(names: RoomName[]): number {
  const isSleeping = (n: string) => n === "Bedroom" || n.startsWith("Children");
  const hasSleeping = names.some(isSleeping);
  const qualifying = names.filter(
    (n) => n === "Living room" || n === "Bedroom" || n.startsWith("Children"),
  ).length;
  const min = hasSleeping ? 2 : 1;
  return Math.min(4, Math.max(min, qualifying || min));
}

// ─── Variant group builder ────────────────────────────────────────────────────

import type { PlacementOption } from "../../../furnisher-engine/src/engine/types";

/** Group allOptions by variantIndex, preserving order. */
function buildVariantGroups(allOptions: PlacementOption[]): VariantGroup[] {
  const groups: VariantGroup[] = [];
  for (let i = 0; i < allOptions.length; i++) {
    const vi = allOptions[i].variantIndex;
    const last = groups[groups.length - 1];
    if (last && last.variantIndex === vi) {
      last.count++;
    } else {
      groups.push({ variantIndex: vi, startFlatIndex: i, count: 1 });
    }
  }
  return groups;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function processRequest(req: Request) {
  const childCounter = { n: 0 };
  const allDoors = req.doors ?? [];

  const engineRooms = req.rooms.map((r) => {
    const name = resolveRoomName(r.name, childCounter);
    const polygon = normalizePolygon(r.polygon);
    // Assign every door that lies near this room's boundary (app behaviour).
    const doors = allDoors.filter(
      (d) => distPointToPolygon(d, polygon) <= ADJACENT_DOOR_THRESHOLD,
    );
    return { name, polygon, doors, windows: r.windows ?? [] };
  });

  const aptType =
    req.aptType ?? inferApartmentType(engineRooms.map((r) => r.name));

  const roomsOut: RoomOut[] = engineRooms.map((er, roomIdx) => {
    const room = {
      name: er.name,
      polygon: er.polygon,
      ...(er.doors.length ? { doors: er.doors } : {}),
      ...(er.windows.length ? { windows: er.windows } : {}),
    };

    // The caller may send either flat indices or [variantIndex, positionIndex] pairs.
    // Detect pairs: if a selections entry has two values, treat as [vi, pos].
    // We resolve to flat indices for the engine.
    const rawSel = req.selections?.[roomIdx] ?? [];
    const flatSelections: number[] = rawSel; // starts as flat; replaced below if pairs given

    // First pass: run with flat selections to get variant groups, then if caller
    // sent pairs we resolve them and re-run once.
    let result = runRoomPipelineAt(room, aptType, flatSelections);

    // If caller sent pairs ([vi, pos] per step), resolve to flat and re-run.
    if (req.selectionMode === "variant-position") {
      const resolvedFlat: number[] = result.steps.map((s, i) => {
        const vi = rawSel[i * 2] ?? 0;
        const pos = rawSel[i * 2 + 1] ?? 0;
        const groups = buildVariantGroups(s.allOptions);
        const group = groups.find(g => g.variantIndex === vi) ?? groups[0];
        if (!group) return 0;
        return Math.min(group.startFlatIndex + pos, group.startFlatIndex + group.count - 1);
      });
      result = runRoomPipelineAt(room, aptType, resolvedFlat);
    }

    const steps: StepOut[] = result.steps.map((s) => {
      const groups = buildVariantGroups(s.allOptions);
      let selVariant = -1;
      let selPos = -1;
      if (s.selectedIndex >= 0) {
        const g = groups.find(
          g => s.selectedIndex >= g.startFlatIndex &&
               s.selectedIndex < g.startFlatIndex + g.count,
        );
        if (g) {
          selVariant = g.variantIndex;
          selPos = s.selectedIndex - g.startFlatIndex;
        }
      }
      return {
        furnitureName: s.furnitureName,
        optionCount: s.allOptions.length,
        selectedIndex: s.selectedIndex,
        variantGroups: groups,
        selectedVariant: selVariant,
        selectedPosition: selPos,
        geometry: s.selected ? s.selected.placed.transformedGeometry : [],
        bbox: s.selected ? s.selected.placed.transformedBbox : [],
        smallBbox: s.selected ? s.selected.placed.transformedSmallBbox : [],
      };
    });

    return { name: er.name, steps, warnings: result.warnings };
  });

  return { aptType, rooms: roomsOut };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

(async () => {
  try {
    const raw = await readStdin();
    // Strip a leading UTF-8 BOM if the caller prepended one.
    const req: Request = JSON.parse(raw.replace(/^﻿/, ""));
    const out = processRequest(req);
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    );
    process.exitCode = 1;
  }
})();
