import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent, PointerEvent } from "react";
import { runRoomPipelineAt, getAllPlacements, placeVariantAtCorner, getDoorRectangles, subtractPolygon, subtractPolygonAll, scoreRoom } from "@engine/index";
import type { PlacedFurniture, StepOptions, PlacementOption, PlacementOptions } from "@engine/types";
import type { Room as EngineRoom, RoomName } from "@layout/types";
import type { FurnitureLibrary, FurnitureEntry, FurnitureVariant, FurnitureCategory, Pipeline } from "@library";
import { defaultLibrary, defaultPipeline, findFurnitureByName } from "@library";
import { AppHeader } from "./AppHeader";
import { ROOM_TOOLS, isRoomTool, isCirculationRoom, DEFAULT_WALL_SETTINGS } from "./types";
import type {
  WallSettings,
  ToolId,
  RoomToolId,
  FurnishableRoomId,
  Point2D,
  BackgroundImage,
  ScaleCalibration,
  DrawnRoom,
  RoomDraft,
  FurnishedRoomResult,
  PipelineConfig,
  PipelineStepConfig,
  CustomFurnitureDef,
} from "./types";
import { Sidebar } from "./Sidebar";
import { parseApartmentJson } from "./apartmentJson";
import type { ApartmentOpening } from "./apartmentJson";
import { buildWalls, wallInnerFace } from "./walls";
import type { WallAxis, WallPolygon } from "./walls";
import { ExploreTab } from "./ExploreTab";
import type { NeufertRecord } from "./NeufertBrowser";

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewerTransform = {
  metresAcross: number;
  centerX: number;
  centerY: number;
};

type EdgeDragState =
  | { kind: "edge"; edgeIndex: number; normal: Point2D; startWorld: Point2D; originalPoints: Point2D[] }
  | { kind: "vertex"; vertexIndex: number; startWorld: Point2D; originalPoints: Point2D[] }
  | {
      kind: "body";
      startWorld: Point2D;
      originalPoints: Point2D[];
      originalDoors: Point2D[];
      originalWindows: Point2D[];
    };

/** Collect all vertices that lie on the same straight wall as the given edge.
 *  Walks backward and forward along consecutive collinear segments. */
function findWallGroup(points: Point2D[], edgeIndex: number): { wallSet: Set<number>; normal: Point2D } {
  const n = points.length;
  const a = points[edgeIndex];
  const b = points[(edgeIndex + 1) % n];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001) return { wallSet: new Set([edgeIndex, (edgeIndex + 1) % n]), normal: { x: 0, y: 1 } };

  const ex = dx / len;
  const ey = dy / len;
  const normal = { x: -ey, y: ex };

  // True if segment p→q runs in the same direction as the dragged edge (within ~1°)
  function sameDir(pIdx: number, qIdx: number): boolean {
    const p = points[pIdx], q = points[qIdx];
    const sdx = q.x - p.x, sdy = q.y - p.y;
    const slen = Math.hypot(sdx, sdy);
    if (slen < 0.001) return true;
    return Math.abs(ex * sdy - ey * sdx) / slen < 0.02;
  }

  const wallSet = new Set<number>([edgeIndex, (edgeIndex + 1) % n]);

  // Extend backward
  let cur = edgeIndex;
  for (;;) {
    const prev = (cur - 1 + n) % n;
    if (wallSet.has(prev) || !sameDir(prev, cur)) break;
    wallSet.add(prev);
    cur = prev;
  }

  // Extend forward
  cur = (edgeIndex + 1) % n;
  for (;;) {
    const next = (cur + 1) % n;
    if (wallSet.has(next) || !sameDir(cur, next)) break;
    wallSet.add(next);
    cur = next;
  }

  return { wallSet, normal };
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function distance(a: Point2D, b: Point2D) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function nearestPointOnSegment(point: Point2D, a: Point2D, b: Point2D) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.000001) return { point: a, distance: distance(point, a) };
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq));
  const projected = { x: a.x + dx * t, y: a.y + dy * t };
  return { point: projected, distance: distance(point, projected) };
}

function nearestRoomEdge(point: Point2D, rooms: DrawnRoom[]) {
  // If the click is inside a specific room, only search that room's edges.
  const containingRoom = rooms.find((r) => pointInPolygon(point, r.points));
  const candidates = containingRoom ? [containingRoom] : rooms;

  let nearest: { roomId: string; point: Point2D; distance: number } | null = null;
  for (const room of candidates) {
    for (let i = 0; i < room.points.length; i++) {
      const a = room.points[i];
      const b = room.points[(i + 1) % room.points.length];
      const candidate = nearestPointOnSegment(point, a, b);
      if (!nearest || candidate.distance < nearest.distance) {
        nearest = { roomId: room.id, point: candidate.point, distance: candidate.distance };
      }
    }
  }
  return nearest;
}

function addPoint(a: Point2D, b: Point2D): Point2D {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scalePoint(p: Point2D, s: number): Point2D {
  return { x: p.x * s, y: p.y * s };
}

function normalizeVector(v: Point2D): Point2D {
  const len = Math.hypot(v.x, v.y);
  return len > 0.000001 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

function perpCounterClockwise(v: Point2D): Point2D {
  return { x: -v.y, y: v.x };
}

function pointInPolygon(point: Point2D, polygon: Point2D[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crossesY = (a.y > point.y) !== (b.y > point.y);
    const xAtY = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crossesY && point.x < xAtY) inside = !inside;
  }
  return inside;
}

function polygonSignedArea(points: Point2D[]) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function polygonCentroid(points: Point2D[]): Point2D {
  let cx = 0;
  let cy = 0;
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 0.001) {
    return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

// ─── Grid snapping ────────────────────────────────────────────────────────────
// Default step is the 625 mm timber module used throughout the project.
const DEFAULT_GRID_STEP = 0.625;
const MIN_GRID_STEP = 0.05;
const MAX_GRID_STEP = 10;

/** Snap a world point to the nearest grid vertex (grid is anchored at origin).
 *  Results are rounded to sub-mm so float dust (4.375000000000001) never reaches
 *  the dimension labels or the exported JSON. */
function snapPointToGrid(point: Point2D, step: number): Point2D {
  if (!(step > 0)) return point;
  const snap = (v: number) => Math.round((Math.round(v / step) * step) * 1e4) / 1e4;
  return { x: snap(point.x), y: snap(point.y) };
}

function constrainToOrthogonal(point: Point2D, anchor: Point2D): Point2D {
  const dx = Math.abs(point.x - anchor.x);
  const dy = Math.abs(point.y - anchor.y);
  return dx >= dy ? { x: point.x, y: anchor.y } : { x: anchor.x, y: point.y };
}

function toEnginePoint(p: Point2D): [number, number] {
  return [p.x, p.y];
}

function normalizePolygonForEngine(points: Point2D[]) {
  const normalized = polygonSignedArea(points) < 0 ? [...points].reverse() : points;
  return normalized.map(toEnginePoint);
}

function roomDoorWidth(roomType: RoomToolId) {
  return roomType === "Bathroom" || roomType === "WC" ? 0.75 : 0.9;
}

/** Hinge side along the host wall: -1 hinges at the jamb nearer wallA, +1 at the
 *  jamb nearer wallB. `null` = pick automatically (nearest wall end). */
type HingeSide = -1 | 1 | null;

function getDoorSwingGeometry(room: DrawnRoom, doorPoint: Point2D, hingeSide: HingeSide = null) {
  if (room.points.length < 2) return null;

  let wallA = room.points[0];
  let wallB = room.points[1];
  let snap = doorPoint;
  let minDistance = Infinity;

  for (let i = 0; i < room.points.length; i++) {
    const a = room.points[i];
    const b = room.points[(i + 1) % room.points.length];
    const candidate = nearestPointOnSegment(doorPoint, a, b);
    if (candidate.distance < minDistance) {
      minDistance = candidate.distance;
      wallA = a;
      wallB = b;
      snap = candidate.point;
    }
  }

  const wallDir = normalizeVector({ x: wallB.x - wallA.x, y: wallB.y - wallA.y });
  const normal = perpCounterClockwise(wallDir);
  // The leaf always swings INTO the room. Dataset door centroids can sit up to
  // ADJACENT_DOOR_THRESHOLD off the boundary (inside the wall thickness or even
  // in the corridor), so probing from the RAW point would test a spot still
  // outside the room and flip the normal outward. Probe from the point SNAPPED
  // onto the wall (reliably just inside vs. just outside), and centre the swing
  // there too so it sits on the wall.
  const probe = addPoint(snap, scalePoint(normal, 0.05));
  const inward = pointInPolygon(probe, room.points) ? normal : scalePoint(normal, -1);
  const width = roomDoorWidth(room.type);

  return doorSwingFromWall(snap, width, wallDir, inward, wallA, wallB, hingeSide);
}

/** Build a door swing hinged at the jamb nearer the closest end of its host
 *  wall, so the open leaf tucks toward the adjacent wall/corner (architectural
 *  convention). The leaf opens along `inward`. `hingeSide` overrides that choice
 *  — used to mirror the two leaves of a double door (see doubleDoorHinges). */
function doorSwingFromWall(
  doorPoint: Point2D,
  width: number,
  wallDir: Point2D,
  inward: Point2D,
  wallA: Point2D,
  wallB: Point2D,
  hingeSide: HingeSide = null,
) {
  // Hinge on the side of whichever host-wall end the door sits closer to.
  const sign = hingeSide ?? (distance(doorPoint, wallA) <= distance(doorPoint, wallB) ? -1 : 1);
  const hinge = addPoint(doorPoint, scalePoint(wallDir, (sign * width) / 2));
  // Direction from the hinge toward the far jamb (where the arc lands).
  const awDir = scalePoint(wallDir, -sign);
  const arcEnd = addPoint(hinge, scalePoint(awDir, width));
  const panelEnd = addPoint(hinge, scalePoint(inward, width));
  const cross = inward.x * awDir.y - inward.y * awDir.x;
  return { arcEnd, hinge, panelEnd, radius: width, sweepFlag: cross > 0 ? 1 : 0, doorPoint };
}

// ─── Double doors ─────────────────────────────────────────────────────────────
// Two door points sitting side by side on the same wall are one double door, not
// two independent single doors. Drawn independently they both hinge toward the
// same wall end and their leaves overlap; a double door hinges at the two OUTER
// jambs so the leaves open away from each other, mirrored about the pair's
// centre.

/** How far apart two door centres may sit and still read as one double door,
 *  as a multiple of their mean leaf width. Just over 1 allows for the small
 *  jamb gap between leaves while rejecting two genuinely separate doorways. */
const DOUBLE_DOOR_SPAN_FACTOR = 1.35;

/** Which polygon edge a door sits on, and how far along it (metres from wallA).
 *  Doors only pair up when they share a host edge. */
function doorWallRef(room: DrawnRoom, doorPoint: Point2D) {
  let wallIndex = 0;
  let best = Infinity;
  let t = 0;
  for (let i = 0; i < room.points.length; i++) {
    const a = room.points[i];
    const b = room.points[(i + 1) % room.points.length];
    const candidate = nearestPointOnSegment(doorPoint, a, b);
    if (candidate.distance < best) {
      best = candidate.distance;
      wallIndex = i;
      t = distance(a, candidate.point);
    }
  }
  return { wallIndex, t };
}

/** Per door index, the hinge side to force so that close pairs render as double
 *  doors: the lower door on the wall hinges at its wallA-side jamb, its partner
 *  at the wallB-side jamb. `null` for doors that are not part of a pair — those
 *  keep the normal nearest-corner rule. */
function doubleDoorHinges(room: DrawnRoom): HingeSide[] {
  const sides: HingeSide[] = room.doors.map(() => null);
  if (room.doors.length < 2) return sides;

  const width = roomDoorWidth(room.type);
  const maxSpan = width * DOUBLE_DOOR_SPAN_FACTOR;

  // Group door indices by host wall, ordered along that wall.
  const byWall = new Map<number, Array<{ index: number; t: number }>>();
  room.doors.forEach((door, index) => {
    const { wallIndex, t } = doorWallRef(room, door);
    const list = byWall.get(wallIndex);
    if (list) list.push({ index, t });
    else byWall.set(wallIndex, [{ index, t }]);
  });

  for (const list of byWall.values()) {
    list.sort((a, b) => a.t - b.t);
    // Greedy: pair each door with the next one along the wall when they are
    // close enough, then skip both so a third door starts a fresh pair.
    for (let i = 0; i + 1 < list.length; i++) {
      const lower = list[i];
      const upper = list[i + 1];
      if (upper.t - lower.t > maxSpan) continue;
      sides[lower.index] = -1;
      sides[upper.index] = 1;
      i++;
    }
  }
  return sides;
}

function lineLabelPosition(a: Point2D, b: Point2D, offset: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    x: (a.x + b.x) / 2 + (-dy / len) * offset,
    y: (a.y + b.y) / 2 + (dx / len) * offset,
  };
}

function formatMetres(value: number) {
  return `${value.toFixed(3)} m`;
}

// ─── Furniture drag helpers ───────────────────────────────────────────────────

type FurnitureKey = { roomId: string; stepIndex: number };

const MANUAL_IDX = -99;

function roomNameToFurnitureCategory(roomName: RoomName): FurnitureCategory {
  if (roomName === "Living room") return "Livingroom";
  if (roomName.startsWith("Children")) return "Children";
  return roomName as FurnitureCategory;
}

function distPtToSegAB(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

function getWallMidpointPt(placed: PlacedFurniture): Point2D | null {
  const [wA, wB] = placed.wallSegment as unknown as [[number, number], [number, number]];
  const sorted = (placed.transformedBbox as unknown as [number, number][])
    .map((p) => ({ pt: { x: p[0], y: p[1] }, d: distPtToSegAB(p[0], p[1], wA[0], wA[1], wB[0], wB[1]) }))
    .sort((a, b) => a.d - b.d);
  if (sorted.length < 2) return null;
  return { x: (sorted[0].pt.x + sorted[1].pt.x) / 2, y: (sorted[0].pt.y + sorted[1].pt.y) / 2 };
}

function snapToRoomWall(
  point: Point2D,
  room: DrawnRoom,
): { point: Point2D; wallA: Point2D; wallB: Point2D; inward: Point2D } | null {
  let best: { d: number; pt: Point2D; a: Point2D; b: Point2D } | null = null;
  for (let i = 0; i < room.points.length; i++) {
    const a = room.points[i];
    const b = room.points[(i + 1) % room.points.length];
    const r = nearestPointOnSegment(point, a, b);
    if (!best || r.distance < best.d) best = { d: r.distance, pt: r.point, a, b };
  }
  if (!best) return null;
  const dir = normalizeVector({ x: best.b.x - best.a.x, y: best.b.y - best.a.y });
  const n = perpCounterClockwise(dir);
  const inward = pointInPolygon(addPoint(best.pt, scalePoint(n, 0.05)), room.points) ? n : scalePoint(n, -1);
  return { point: best.pt, wallA: best.a, wallB: best.b, inward };
}

// ─── Failed-candidate helpers ──────────────────────────────────────────────────
// A "failed candidate" is a pipeline piece the engine could NOT auto-place
// (its StepOptions.selected is null / allOptions is empty). We surface it as a
// draggable footprint so the user can try to place it by hand.

type FailedCandidate = {
  roomId: string;
  stepIndex: number;
  furnitureName: string;
  variantIndex: number;
  /** Footprint geometry we construct ourselves (no engine placement exists). */
  placed: PlacedFurniture;
};

/** The longest edge of a room polygon plus its inward normal. */
function longestWallOf(points: Point2D[]): { a: Point2D; b: Point2D; inward: Point2D } | null {
  if (points.length < 2) return null;
  let bestLen = -1;
  let bi = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = distance(a, b);
    if (len > bestLen) { bestLen = len; bi = i; }
  }
  const a = points[bi];
  const b = points[(bi + 1) % points.length];
  const dir = normalizeVector({ x: b.x - a.x, y: b.y - a.y });
  const n = perpCounterClockwise(dir);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const inward = pointInPolygon(addPoint(mid, scalePoint(n, 0.05)), points) ? n : scalePoint(n, -1);
  return { a, b, inward };
}

/** Build a rigid, rectangular footprint for a piece flush against a wall,
 *  centred on the wall midpoint and extending inward — reusing the exact same
 *  placer the manual drop flow uses (placeVariantAtCorner). */
function placeCandidateAgainstWall(
  variant: FurnitureVariant,
  wall: { a: Point2D; b: Point2D; inward: Point2D },
  furnitureName: string,
): PlacedFurniture {
  const lp = variant.linePlacement.points as unknown as [number, number][];
  const cornerSrcPt: [number, number] = [(lp[0][0] + lp[1][0]) / 2, (lp[0][1] + lp[1][1]) / 2];
  const mid: [number, number] = [(wall.a.x + wall.b.x) / 2, (wall.a.y + wall.b.y) / 2];
  return placeVariantAtCorner(
    variant,
    [wall.a.x, wall.a.y], [wall.b.x, wall.b.y], [wall.inward.x, wall.inward.y],
    cornerSrcPt, mid,
    furnitureName,
  );
}

// ─── Engine adapters ──────────────────────────────────────────────────────────

function inferApartmentType(rooms: DrawnRoom[]) {
  const hasSleepingRoom = rooms.some((r) => r.type === "Bedroom" || r.type === "Children");
  const qualifyingCount = rooms.filter(
    (r) => r.type === "Living room" || r.type === "Bedroom" || r.type === "Children",
  ).length;
  const min = hasSleepingRoom ? 2 : 1;
  return Math.min(4, Math.max(min, qualifyingCount || min));
}

const ADJACENT_DOOR_THRESHOLD = 0.4; // metres

function distPointToPolygonBoundary(pt: Point2D, polygon: Point2D[]): number {
  let min = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const d = nearestPointOnSegment(pt, polygon[i], polygon[(i + 1) % polygon.length]).distance;
    if (d < min) min = d;
  }
  return min;
}

// ─── Doorway wall cutting ──────────────────────────────────────────────────────
// Cut real openings OUT of the dataset wall thickness polygons at each door so
// the wall itself has a clean gap with proper jamb ends (architectural plan look),
// instead of overlaying paper rectangles. Done once at load; the resulting rings
// render unchanged through DatasetWallLayer.

const DOOR_CUTTER_MARGIN = 0.04;  // extra width so the opening fully clears the jamb
const DOOR_CUTTER_HALF_DEPTH = 0.30; // half-depth across wall (0.6 m total, over-crosses any wall)

/** Build one door-opening cutter rectangle (as engine tuples) for a door point,
 *  aligned to the room's nearest polygon edge. Returns null for degenerate edges. */
function buildDoorCutter(room: DrawnRoom, door: Point2D, halfDepth = DOOR_CUTTER_HALF_DEPTH): [number, number][] | null {
  if (room.points.length < 2) return null;
  // Nearest room-polygon edge to the door point.
  let wallA = room.points[0];
  let wallB = room.points[1];
  let minDistance = Infinity;
  for (let i = 0; i < room.points.length; i++) {
    const a = room.points[i];
    const b = room.points[(i + 1) % room.points.length];
    const candidate = nearestPointOnSegment(door, a, b);
    if (candidate.distance < minDistance) {
      minDistance = candidate.distance;
      wallA = a;
      wallB = b;
    }
  }
  const wallDir = normalizeVector({ x: wallB.x - wallA.x, y: wallB.y - wallA.y });
  if (wallDir.x === 0 && wallDir.y === 0) return null;
  const n = perpCounterClockwise(wallDir);
  const halfW = (roomDoorWidth(room.type) + DOOR_CUTTER_MARGIN) / 2;
  const along = scalePoint(wallDir, halfW);
  const across = scalePoint(n, halfDepth);
  // Corners: door ± wallDir*(width/2) ± n*halfDepth.
  const corners = [
    addPoint(addPoint(door, along), across),
    addPoint(addPoint(door, scalePoint(along, -1)), across),
    addPoint(addPoint(door, scalePoint(along, -1)), scalePoint(across, -1)),
    addPoint(addPoint(door, along), scalePoint(across, -1)),
  ];
  return corners.map(toEnginePoint);
}

/** Build one window-opening cutter rectangle (as engine tuples) for a window
 *  point, aligned to the room's nearest polygon edge. Mirrors buildDoorCutter
 *  but uses the given real window width (+ the same small margin) for the
 *  along-wall span. Returns null for degenerate edges. */
function buildWindowCutter(room: DrawnRoom, windowPt: Point2D, width: number, halfDepth = DOOR_CUTTER_HALF_DEPTH): [number, number][] | null {
  if (room.points.length < 2) return null;
  // Nearest room-polygon edge to the window point.
  let wallA = room.points[0];
  let wallB = room.points[1];
  let minDistance = Infinity;
  for (let i = 0; i < room.points.length; i++) {
    const a = room.points[i];
    const b = room.points[(i + 1) % room.points.length];
    const candidate = nearestPointOnSegment(windowPt, a, b);
    if (candidate.distance < minDistance) {
      minDistance = candidate.distance;
      wallA = a;
      wallB = b;
    }
  }
  const wallDir = normalizeVector({ x: wallB.x - wallA.x, y: wallB.y - wallA.y });
  if (wallDir.x === 0 && wallDir.y === 0) return null;
  const n = perpCounterClockwise(wallDir);
  const halfW = (width + DOOR_CUTTER_MARGIN) / 2;
  const along = scalePoint(wallDir, halfW);
  const across = scalePoint(n, halfDepth);
  // Corners: window ± wallDir*(width/2) ± n*halfDepth.
  const corners = [
    addPoint(addPoint(windowPt, along), across),
    addPoint(addPoint(windowPt, scalePoint(along, -1)), across),
    addPoint(addPoint(windowPt, scalePoint(along, -1)), scalePoint(across, -1)),
    addPoint(addPoint(windowPt, along), scalePoint(across, -1)),
  ];
  return corners.map(toEnginePoint);
}

/** Cut door AND window openings out of the wall thickness rings. For each wall
 *  ring, the boolean difference against all cutters yields the wall with real
 *  gaps at doorways/windows (a mid-span cut splits the ring into two — both
 *  kept). Windows use their real per-window width when available, falling back
 *  to windowWidth(type). If subtraction throws or returns nothing for a ring,
 *  that ring is kept uncut so a robustness hiccup never deletes a wall. */
function cutOpeningsInWalls(
  wallRings: Point2D[][],
  rooms: DrawnRoom[],
  entrances: EntranceDoor[] = [],
  /** Half-depth across the wall — raise it for walls thicker than the default. */
  halfDepth: number = DOOR_CUTTER_HALF_DEPTH,
): Point2D[][] {
  const cutters: [number, number][][] = [];
  for (const room of rooms) {
    for (const door of room.doors) {
      const c = buildDoorCutter(room, door, halfDepth);
      if (c) cutters.push(c);
    }
    for (let i = 0; i < room.windows.length; i++) {
      const width = room.windowWidths?.[i] ?? windowWidth(room.type);
      const c = buildWindowCutter(room, room.windows[i], width, halfDepth);
      if (c) cutters.push(c);
    }
  }
  // Apartment entrance openings — use the wall orientation baked in at load so
  // the opening lines up with the same wall the swing glyph is drawn on.
  for (const e of entrances) {
    const c = buildOpeningCutterAligned(e.point, e.width, e.wallDir, halfDepth);
    if (c) cutters.push(c);
  }
  if (!cutters.length) return wallRings;

  const gapped: Point2D[][] = [];
  for (const ring of wallRings) {
    try {
      const result = subtractPolygonAll(ring.map(toEnginePoint), cutters);
      if (result.length) {
        for (const r of result) gapped.push(r.map(([x, y]) => ({ x, y })));
      } else {
        gapped.push(ring); // subtraction erased everything — keep original
      }
    } catch {
      gapped.push(ring); // robustness fallback — keep the wall uncut
    }
  }
  return gapped;
}

// ─── Apartment entrance door ───────────────────────────────────────────────────
// The apartment entrance is an apartment-level opening (it usually gives onto the
// corridor, not a single furnishable room). It is carried separately from room
// doors so it can be drawn with a distinct glyph, and oriented to the nearest
// wall/room edge with the leaf swinging toward the apartment interior.

// Orientation (wallDir + inward normal) is baked in at load, so the wall opening
// cutter and the swing glyph always agree on the same wall.
type EntranceDoor = {
  point: Point2D;
  width: number;
  wallDir: Point2D;
  inward: Point2D;
  wallA: Point2D;
  wallB: Point2D;
};

/** Centroid of all room vertices — a stable "inside the apartment" reference. */
function apartmentInterior(rooms: DrawnRoom[]): Point2D {
  let x = 0, y = 0, n = 0;
  for (const r of rooms) for (const p of r.points) { x += p.x; y += p.y; n++; }
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}

// A wall the entrance can sit in must be at least this long — shorter edges are
// wall end-caps (which run ACROSS the wall) or corner stubs, and orienting to
// one would rotate the door ~90° off the real wall.
const ENTRANCE_MIN_WALL_EDGE = 0.4;

/** Orient an apartment-level opening to the nearest boundary edge, with the
 *  inward normal pointing toward the apartment interior. `boundaries` are the
 *  clean architectural outlines (wall faces, room + corridor polygons); short
 *  end-cap/stub edges are skipped so the door aligns ALONG the wall, not across
 *  it. Falls back to allowing any edge if every candidate was too short. */
function orientToNearestEdge(
  point: Point2D,
  boundaries: Point2D[][],
  interior: Point2D,
): { wallDir: Point2D; inward: Point2D; wallA: Point2D; wallB: Point2D; snap: Point2D } | null {
  const pick = (minLen: number) => {
    let best: { d: number; a: Point2D; b: Point2D; snap: Point2D } | null = null;
    for (const ring of boundaries) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (distance(a, b) < minLen) continue;
        const r = nearestPointOnSegment(point, a, b);
        if (!best || r.distance < best.d) best = { d: r.distance, a, b, snap: r.point };
      }
    }
    return best;
  };
  const best = pick(ENTRANCE_MIN_WALL_EDGE) ?? pick(0);
  if (!best) return null;
  const wallDir = normalizeVector({ x: best.b.x - best.a.x, y: best.b.y - best.a.y });
  if (wallDir.x === 0 && wallDir.y === 0) return null;
  const n = perpCounterClockwise(wallDir);
  const toInt = { x: interior.x - best.snap.x, y: interior.y - best.snap.y };
  const inward = n.x * toInt.x + n.y * toInt.y >= 0 ? n : scalePoint(n, -1);
  return { wallDir, inward, wallA: best.a, wallB: best.b, snap: best.snap };
}

/** Build one opening cutter rectangle from an explicit wall direction (used for
 *  apartment-level entrances, where the wall alignment is computed separately). */
function buildOpeningCutterAligned(
  point: Point2D,
  width: number,
  wallDir: Point2D,
  halfDepth = DOOR_CUTTER_HALF_DEPTH,
): [number, number][] | null {
  if (wallDir.x === 0 && wallDir.y === 0) return null;
  const n = perpCounterClockwise(wallDir);
  const halfW = (width + DOOR_CUTTER_MARGIN) / 2;
  const along = scalePoint(wallDir, halfW);
  const across = scalePoint(n, halfDepth);
  const corners = [
    addPoint(addPoint(point, along), across),
    addPoint(addPoint(point, scalePoint(along, -1)), across),
    addPoint(addPoint(point, scalePoint(along, -1)), scalePoint(across, -1)),
    addPoint(addPoint(point, along), scalePoint(across, -1)),
  ];
  return corners.map(toEnginePoint);
}

/** Swing glyph geometry for an apartment entrance — same hinge-near-closest-wall
 *  rule as interior doors, opening toward the apartment interior. */
function getEntranceSwingGeometry(e: EntranceDoor) {
  return doorSwingFromWall(e.point, e.width, e.wallDir, e.inward, e.wallA, e.wallB);
}

function EntranceLayer({ entrances }: { entrances: EntranceDoor[] }) {
  if (!entrances.length) return null;
  return (
    <g className="apartment-entrance-layer" style={{ pointerEvents: "none" }}>
      {entrances.map((e, i) => {
        const g = getEntranceSwingGeometry(e);
        return (
          <g key={i} className="apartment-entrance">
            <line x1={g.hinge.x} y1={g.hinge.y} x2={g.panelEnd.x} y2={g.panelEnd.y} />
            <path
              className="entrance-arc"
              d={`M ${g.panelEnd.x} ${g.panelEnd.y} A ${g.radius} ${g.radius} 0 0 ${g.sweepFlag} ${g.arcEnd.x} ${g.arcEnd.y}`}
            />
            <circle className="entrance-hinge" cx={g.hinge.x} cy={g.hinge.y} r="0.05" />
          </g>
        );
      })}
    </g>
  );
}

// ─── Shared-door display ownership ─────────────────────────────────────────────
// When a physical door sits on a wall between two rooms, both rooms may carry a
// door point for it (esp. dataset apartments). To avoid drawing the swing twice
// in the normal view, exactly one room "owns" the drawing, chosen by room type.
// Higher priority (lower index) wins; ties broken deterministically by room id.
// Circulation last: a hall/corridor door is drawn by the room it opens into.
const ROOM_DOOR_PRIORITY: RoomToolId[] = ["Bedroom", "Living room", "Kitchen", "Bathroom", "WC", "Children", "Hall", "Corridor"];

function roomDoorPriority(type: RoomToolId): number {
  const i = ROOM_DOOR_PRIORITY.indexOf(type);
  return i === -1 ? ROOM_DOOR_PRIORITY.length : i;
}

/** For every room, a boolean per door point: true if this room should paint that
 *  door's swing in the normal (non-transition) view. A door shared with another
 *  room (door point within ADJACENT_DOOR_THRESHOLD) is owned by the single
 *  highest-priority room among the sharers; unshared doors are always owned. */
function computeDoorOwnership(rooms: DrawnRoom[]): Map<string, boolean[]> {
  const ownership = new Map<string, boolean[]>();
  for (const room of rooms) {
    const owned = room.doors.map((door) => {
      let bestType = roomDoorPriority(room.type);
      let bestId = room.id;
      for (const other of rooms) {
        if (other.id === room.id) continue;
        const shares = other.doors.some((od) => distance(od, door) <= ADJACENT_DOOR_THRESHOLD);
        if (!shares) continue;
        const otherType = roomDoorPriority(other.type);
        if (otherType < bestType || (otherType === bestType && other.id < bestId)) {
          bestType = otherType;
          bestId = other.id;
        }
      }
      return bestId === room.id;
    });
    ownership.set(room.id, owned);
  }
  return ownership;
}

/** Rooms handed to the placement engine. Circulation spaces are dropped — they
 *  have no RoomName / furniture recipes — but the full room list is still used
 *  for door and window adjacency, so a door onto the hall keeps constraining the
 *  room it opens into. */
function toEngineRooms(rooms: DrawnRoom[]) {
  let childIndex = 0;
  return rooms
    .filter((r): r is DrawnRoom & { type: FurnishableRoomId } => !isCirculationRoom(r.type))
    .map((room) => {
    let name: RoomName;
    if (room.type === "Children") {
      childIndex++;
      name = `Children ${Math.min(4, childIndex)}` as RoomName;
    } else {
      name = room.type;
    }

    // Own doors + doors from adjacent rooms whose center is within the threshold
    const ownDoors = room.doors.map(toEnginePoint);
    const adjacentDoors: [number, number][] = [];
    for (const other of rooms) {
      if (other.id === room.id) continue;
      for (const door of other.doors) {
        if (distPointToPolygonBoundary(door, room.points) <= ADJACENT_DOOR_THRESHOLD) {
          adjacentDoors.push(toEnginePoint(door));
        }
      }
    }
    const allDoors = [...ownDoors, ...adjacentDoors];

    // Own windows + windows from adjacent rooms on shared walls
    const ownWindows = room.windows.map(toEnginePoint);
    const adjacentWindows: [number, number][] = [];
    for (const other of rooms) {
      if (other.id === room.id) continue;
      for (const win of other.windows) {
        if (distPointToPolygonBoundary(win, room.points) <= ADJACENT_DOOR_THRESHOLD) {
          adjacentWindows.push(toEnginePoint(win));
        }
      }
    }
    const allWindows = [...ownWindows, ...adjacentWindows];

    return {
      roomId: room.id,
      room: {
        name,
        polygon: normalizePolygonForEngine(room.points),
        ...(allDoors.length > 0 ? { doors: allDoors } : {}),
        ...(allWindows.length > 0 ? { windows: allWindows } : {}),
      } satisfies EngineRoom,
    };
  });
}

// ─── Template JSON export ─────────────────────────────────────────────────────
// Writes a traced apartment in the floorplan-generator template format:
// metres, { x, y } points, rectilinear open rings wound CCW, room ids as
// readable type slugs. Doors that connect two rooms go to `doors` (from/to);
// doors with no second room (apartment entrances) go to `entrances`, since the
// template format's from/to must both be room ids.

const TEMPLATE_ROOM_TYPE: Record<RoomToolId, string> = {
  "Bedroom": "bedroom",
  "Living room": "living",
  "Kitchen": "kitchen",
  "Bathroom": "bathroom",
  "WC": "wc",
  "Children": "bedroom",
  "Hall": "hall",
  "Corridor": "corridor",
};

type TemplatePoint = { x: number; y: number };

type TemplateApartment = {
  id: string;
  name: string;
  rooms: Array<{ id: string; type: string; polygon: TemplatePoint[] }>;
  doors?: Array<{ from: string; to: string; position: TemplatePoint; width: number }>;
  windows?: Array<{ room: string; position: TemplatePoint; width: number }>;
  entrances?: Array<{ room: string; position: TemplatePoint; width: number }>;
};

/** Sub-mm rounding — keeps grid-snapped coordinates exact and readable. */
function round4(value: number) {
  return Math.round(value * 1e4) / 1e4;
}

function templatePoint(p: Point2D): TemplatePoint {
  return { x: round4(p.x), y: round4(p.y) };
}

/** Open ring (no repeated first vertex), wound CCW like normalizePolygonForEngine. */
function templatePolygon(points: Point2D[]): TemplatePoint[] {
  const ring = [...points];
  while (
    ring.length > 1 &&
    Math.abs(ring[0].x - ring[ring.length - 1].x) < 1e-6 &&
    Math.abs(ring[0].y - ring[ring.length - 1].y) < 1e-6
  ) {
    ring.pop();
  }
  const oriented = polygonSignedArea(ring) < 0 ? ring.reverse() : ring;
  return oriented.map(templatePoint);
}

/** Readable, stable ids: one room of a type keeps the bare slug, several get
 *  suffixes in trace order (bedroom-1, bedroom-2, …). */
function buildTemplateRoomIds(rooms: DrawnRoom[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const room of rooms) {
    const slug = TEMPLATE_ROOM_TYPE[room.type];
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const used = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const room of rooms) {
    const slug = TEMPLATE_ROOM_TYPE[room.type];
    if ((counts.get(slug) ?? 0) === 1) {
      ids.set(room.id, slug);
    } else {
      const n = (used.get(slug) ?? 0) + 1;
      used.set(slug, n);
      ids.set(room.id, `${slug}-${n}`);
    }
  }
  return ids;
}

function buildTemplateApartment(rooms: DrawnRoom[], id: string, name: string): TemplateApartment {
  const ids = buildTemplateRoomIds(rooms);

  const doors: NonNullable<TemplateApartment["doors"]> = [];
  const entrances: NonNullable<TemplateApartment["entrances"]> = [];
  const seenDoors = new Set<string>();

  for (const room of rooms) {
    const roomId = ids.get(room.id)!;
    for (const door of room.doors) {
      // The same physical door is usually stored on both rooms it connects.
      // Nearest qualifying room wins, so a door near a corner where three rooms
      // meet still pairs with the one it actually sits on.
      let partner: DrawnRoom | null = null;
      let partnerDist = Infinity;
      for (const other of rooms) {
        if (other.id === room.id) continue;
        const d = distPointToPolygonBoundary(door, other.points);
        if (d <= ADJACENT_DOOR_THRESHOLD && d < partnerDist) {
          partner = other;
          partnerDist = d;
        }
      }
      const pos = templatePoint(door);
      if (!partner) {
        const key = `entrance:${roomId}:${pos.x},${pos.y}`;
        if (seenDoors.has(key)) continue;
        seenDoors.add(key);
        entrances.push({ room: roomId, position: pos, width: roomDoorWidth(room.type) });
        continue;
      }
      const partnerId = ids.get(partner.id)!;
      const pair = [roomId, partnerId].sort().join("↔");
      const key = `door:${pair}:${pos.x},${pos.y}`;
      if (seenDoors.has(key)) continue;
      seenDoors.add(key);
      // Narrower of the two rooms' door widths — a bathroom door stays 0.75.
      const width = Math.min(roomDoorWidth(room.type), roomDoorWidth(partner.type));
      doors.push({ from: roomId, to: partnerId, position: pos, width });
    }
  }

  const windows: NonNullable<TemplateApartment["windows"]> = [];
  for (const room of rooms) {
    const roomId = ids.get(room.id)!;
    room.windows.forEach((win, i) => {
      windows.push({
        room: roomId,
        position: templatePoint(win),
        width: room.windowWidths?.[i] ?? windowWidth(room.type),
      });
    });
  }

  return {
    id,
    name,
    rooms: rooms.map((room) => ({
      id: ids.get(room.id)!,
      type: TEMPLATE_ROOM_TYPE[room.type],
      polygon: templatePolygon(room.points),
    })),
    ...(doors.length > 0 ? { doors } : {}),
    ...(windows.length > 0 ? { windows } : {}),
    ...(entrances.length > 0 ? { entrances } : {}),
  };
}

/** "3r-20260727-1432" — habitable-room count in the library's Nr convention
 *  plus a timestamp, so repeated exports never collide. */
function buildTemplateId(rooms: DrawnRoom[], now: Date) {
  const habitable = rooms.filter(
    (r) => r.type === "Bedroom" || r.type === "Living room" || r.type === "Children",
  ).length;
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `${Math.max(1, habitable)}r-${stamp}`;
}

function downloadTemplateJson(rooms: DrawnRoom[]) {
  const now = new Date();
  const id = buildTemplateId(rooms, now);
  const template = buildTemplateApartment(rooms, id, `Traced apartment ${id}`);
  const blob = new Blob([`${JSON.stringify(template, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function roomFingerprint(room: DrawnRoom) {
  return `${room.type}:${room.points.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join("|")}`;
}

function dedupeRooms(rooms: DrawnRoom[]) {
  const seen = new Set<string>();
  return rooms.filter((room) => {
    const fp = roomFingerprint(room);
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
}

// Stable string describing everything that affects a furnish result: room
// identity, type, and rounded geometry (points/doors/windows) plus the pipeline
// config. Deliberately EXCLUDES furnishedRooms so writing furniture cannot
// re-trigger the auto-furnish effect (which would loop).
//
// Each room's geometry is normalised relative to its own first vertex, so the
// signature captures SHAPE only, not absolute position. Moving a whole room
// (translation) therefore leaves the signature unchanged → the memoised value
// stays equal → the auto-furnish effect does not re-run. The placement is kept
// and translated along with the room (see handleMoveRoom). Reshaping a room
// (vertex/edge drag) does change the normalised geometry → re-furnish as usual.
function computeLayoutSignature(rooms: DrawnRoom[], config: PipelineConfig): string {
  const r = (n: number) => n.toFixed(2);
  const rel = (list: Point2D[], ox: number, oy: number) =>
    list.map((p) => `${r(p.x - ox)},${r(p.y - oy)}`).join("|");
  const roomsSig = rooms
    .map((room) => {
      const o = room.points[0] ?? { x: 0, y: 0 };
      return `${room.id}:${room.type}:${rel(room.points, o.x, o.y)}:${rel(room.doors, o.x, o.y)}:${rel(room.windows, o.x, o.y)}`;
    })
    .join(";");
  return `${roomsSig}#${JSON.stringify(config)}`;
}

// ─── Placement translation (keep furniture when a room is only moved) ──────────
// A placement is stored in absolute coordinates. When a room is translated (not
// reshaped) we shift its existing placement by the same delta instead of
// re-running the pipeline, so the furniture layout is preserved exactly.

function translatePlaced(p: PlacedFurniture, dx: number, dy: number): PlacedFurniture {
  const t = (pt: readonly [number, number]): [number, number] => [pt[0] + dx, pt[1] + dy];
  const tl = (list: readonly [number, number][]): [number, number][] => list.map(t);
  return {
    ...p,
    transformedGeometry: p.transformedGeometry.map((g) => ({ ...g, points: tl(g.points) })),
    transformedBbox: tl(p.transformedBbox),
    transformedSmallBbox: tl(p.transformedSmallBbox),
    wallSegment: [t(p.wallSegment[0]), t(p.wallSegment[1])],
    smallCutout: tl(p.smallCutout),
    largeCutout: tl(p.largeCutout),
  };
}

function translateOption(o: PlacementOption, dx: number, dy: number): PlacementOption {
  return { ...o, placed: translatePlaced(o.placed, dx, dy) };
}

function translateStep(s: StepOptions, dx: number, dy: number): StepOptions {
  return {
    ...s,
    allOptions: s.allOptions.map((o) => translateOption(o, dx, dy)),
    selected: s.selected ? translateOption(s.selected, dx, dy) : null,
  };
}

function translateFurnishedRoom(r: FurnishedRoomResult, dx: number, dy: number): FurnishedRoomResult {
  if (dx === 0 && dy === 0) return r;
  return { ...r, steps: r.steps.map((s) => translateStep(s, dx, dy)) };
}

// ─── Pipeline builder helpers ─────────────────────────────────────────────────

function sectionToCategory(section: string): FurnitureCategory {
  if (section === "Living room") return "Livingroom";
  return section as FurnitureCategory;
}

function buildCustomPipeline(config: PipelineConfig): Pipeline {
  const result = { ...defaultPipeline };
  for (const [section, steps] of Object.entries(config.roomOverrides)) {
    result[section] = steps.map((s) => s.names);
  }
  return result;
}

function libraryEntryWithVariant(entry: FurnitureEntry, variantIndex: number): FurnitureEntry {
  const piece = entry.pieces[0];
  if (!piece || !piece.variants[variantIndex]) return entry;
  return {
    ...entry,
    id: `${entry.id}-v${variantIndex}`,
    pieces: [{ ...piece, variants: [piece.variants[variantIndex]] }],
  };
}

function scaleVariant(variant: FurnitureVariant, sx: number, sy: number): FurnitureVariant {
  const sp = (p: [number, number]): [number, number] => [p[0] * sx, p[1] * sy];
  return {
    linePlacement: { points: (variant.linePlacement.points as [number, number][]).map(sp) },
    bboxBig:   { ...variant.bboxBig,   points: (variant.bboxBig.points   as [number, number][]).map(sp) },
    bboxSmall: { ...variant.bboxSmall, points: (variant.bboxSmall.points as [number, number][]).map(sp) },
    geometry: variant.geometry.map((g) => ({ closed: g.closed, points: (g.points as [number, number][]).map(sp) })),
  };
}

function scaleLibraryEntry(entry: FurnitureEntry, sizeOverride: { bigWidth: number; bigDepth: number; smallWidth?: number; smallDepth?: number }): FurnitureEntry {
  return {
    ...entry,
    pieces: entry.pieces.map((piece) => ({
      ...piece,
      variants: piece.variants.map((variant) => {
        const bigPts = variant.bboxBig.points as [number, number][];
        const origW = Math.max(...bigPts.map((p) => p[0])) - Math.min(...bigPts.map((p) => p[0]));
        const origD = Math.max(...bigPts.map((p) => p[1])) - Math.min(...bigPts.map((p) => p[1]));
        const sx = origW > 0 ? sizeOverride.bigWidth  / origW : 1;
        const sy = origD > 0 ? sizeOverride.bigDepth / origD : 1;
        let scaled = scaleVariant(variant, sx, sy);

        if (sizeOverride.smallWidth !== undefined && sizeOverride.smallDepth !== undefined) {
          const sPts = scaled.bboxSmall.points as [number, number][];
          const sMinX = Math.min(...sPts.map((p) => p[0]));
          const sMaxX = Math.max(...sPts.map((p) => p[0]));
          const sMinY = Math.min(...sPts.map((p) => p[1]));
          const sMaxY = Math.max(...sPts.map((p) => p[1]));
          const sCurW = sMaxX - sMinX;
          const sCurD = sMaxY - sMinY;
          const sCx = (sMinX + sMaxX) / 2;
          const sCy = (sMinY + sMaxY) / 2;
          const ssx = sCurW > 0 ? sizeOverride.smallWidth  / sCurW : 1;
          const ssy = sCurD > 0 ? sizeOverride.smallDepth / sCurD : 1;
          const sc = (pts: [number, number][]): [number, number][] =>
            pts.map(([x, y]) => [sCx + (x - sCx) * ssx, sCy + (y - sCy) * ssy]);
          scaled = {
            ...scaled,
            bboxSmall: { ...scaled.bboxSmall, width: sizeOverride.smallWidth, height: sizeOverride.smallDepth, points: sc(sPts) },
            geometry: scaled.geometry.map((g) => ({ ...g, points: sc(g.points as [number, number][]) })),
          };
        }

        return scaled;
      }),
    })),
  };
}

function buildCustomEntry(
  def: CustomFurnitureDef,
  aptType: number,
  category: FurnitureCategory,
): FurnitureEntry {
  const { bigWidth, bigDepth, smallWidth, smallDepth, smallOffsetX, smallOffsetY } = def;
  const bboxBigPoints: [number, number][] = [
    [0, 0], [bigWidth, 0], [bigWidth, bigDepth], [0, bigDepth],
  ];
  const bboxSmallPoints: [number, number][] = [
    [smallOffsetX, smallOffsetY],
    [smallOffsetX + smallWidth, smallOffsetY],
    [smallOffsetX + smallWidth, smallOffsetY + smallDepth],
    [smallOffsetX, smallOffsetY + smallDepth],
  ];
  const variant: FurnitureVariant = {
    linePlacement: { points: [[0, 0], [bigWidth, 0]] },
    bboxBig: { origin: [0, 0], width: bigWidth, height: bigDepth, rotation: 0, points: bboxBigPoints },
    bboxSmall: { origin: [smallOffsetX, smallOffsetY], width: smallWidth, height: smallDepth, rotation: 0, points: bboxSmallPoints },
    geometry: [{ closed: true, points: bboxSmallPoints }],
  };
  const pid = `custom-${def.name}-${aptType}`;
  return {
    id: pid,
    apartmentType: aptType,
    category,
    furnitureName: def.name,
    pieces: [{ id: pid, name: def.name, apartmentType: aptType, category, furnitureName: def.name, importance: 1, score: 1, variants: [variant] }],
  };
}

function buildCustomLibrary(config: PipelineConfig, aptType: number): FurnitureLibrary {
  const extra: FurnitureEntry[] = [];
  for (const [section, steps] of Object.entries(config.roomOverrides)) {
    const category = sectionToCategory(section);
    for (const step of steps) {
      if (step.custom) {
        extra.push(buildCustomEntry(step.custom, aptType, category));
      } else if ((step.variantIndex > 0 || step.sizeOverride) && step.names[0]) {
        const base = findFurnitureByName(defaultLibrary, aptType, category, step.names[0]);
        if (base) {
          let entry: FurnitureEntry = step.variantIndex > 0 ? libraryEntryWithVariant(base, step.variantIndex) : base;
          if (step.sizeOverride) entry = scaleLibraryEntry(entry, step.sizeOverride);
          extra.push({ ...entry, id: `${entry.id}-override` });
        }
      }
    }
  }
  return { ...defaultLibrary, furniture: [...extra, ...defaultLibrary.furniture] };
}

// ─── SVG helpers ─────────────────────────────────────────────────────────────

function pointsToPath(points: Point2D[], closed: boolean) {
  if (!points.length) return "";
  const [first, ...rest] = points;
  return [`M ${first.x} ${first.y}`, ...rest.map((p) => `L ${p.x} ${p.y}`), closed ? "Z" : ""].join(" ");
}

function edgeAngleDeg(a: Point2D, b: Point2D): number {
  let angle = Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
  if (angle >= 90) angle -= 180;
  if (angle < -90) angle += 180;
  return angle;
}

const EDGE_LABEL_OFFSET = 0.2;
const EDGE_LABEL_MIN_LENGTH = 0.35;

function EdgeLabels({
  points,
  closed,
  isDraft,
  color,
}: {
  points: Point2D[];
  closed: boolean;
  isDraft: boolean;
  color: string;
}) {
  const edgeCount = closed ? points.length : points.length - 1;
  if (edgeCount < 1) return null;

  return (
    <>
      {Array.from({ length: edgeCount }, (_, i) => {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const len = distance(a, b);
        if (len < EDGE_LABEL_MIN_LENGTH) return null;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const edgeLen = Math.hypot(dx, dy);
        // CCW perpendicular — for a CCW polygon this points inward
        const nx = -dy / edgeLen;
        const ny = dx / edgeLen;
        // For finished closed rooms, verify the normal points inward and flip if not
        let ox = nx;
        let oy = ny;
        if (closed && !isDraft) {
          const testPt: Point2D = { x: (a.x + b.x) / 2 + nx * 0.05, y: (a.y + b.y) / 2 + ny * 0.05 };
          if (!pointInPolygon(testPt, points)) { ox = -nx; oy = -ny; }
        }
        const lx = (a.x + b.x) / 2 + ox * EDGE_LABEL_OFFSET;
        const ly = (a.y + b.y) / 2 + oy * EDGE_LABEL_OFFSET;
        const angle = edgeAngleDeg(a, b);

        return (
          <text
            key={i}
            className={`edge-label${isDraft ? " draft" : ""}`}
            x={lx}
            y={ly}
            fill={isDraft ? color : undefined}
            transform={`rotate(${angle}, ${lx}, ${ly})`}
          >
            {len.toFixed(3)}m
          </text>
        );
      })}
    </>
  );
}

function RoomLabel({ room }: { room: DrawnRoom }) {
  if (room.points.length < 3) return null;
  const centroid = polygonCentroid(room.points);
  const area = Math.abs(polygonSignedArea(room.points));

  return (
    <g className="room-label" style={{ color: room.color }}>
      <text className="room-label-name" x={centroid.x} y={centroid.y - 0.22} textAnchor="middle" dominantBaseline="central">
        {room.type.toUpperCase()}
      </text>
      <text className="room-label-area" x={centroid.x} y={centroid.y + 0.22} textAnchor="middle" dominantBaseline="central">
        {area.toFixed(1)} m²
      </text>
    </g>
  );
}

// ─── Dataset context areas (corridors etc. — display-only) ───────────────────

type DatasetContextArea = { subtype: string; points: Point2D[] };

function DatasetContextLayer({ areas }: { areas: DatasetContextArea[] }) {
  if (!areas.length) return null;
  return (
    <g className="dataset-context-layer" style={{ pointerEvents: "none" }}>
      {areas.map((area, i) => {
        const centroid = polygonCentroid(area.points);
        return (
          <g key={i}>
            <path className="dataset-context-poly" d={pointsToPath(area.points, true)} />
            <text
              className="dataset-context-label"
              x={centroid.x}
              y={centroid.y}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {area.subtype.toLowerCase()}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// ─── Dataset walls (thickness polygons — display-only) ───────────────────────
// Filled wall-thickness rings translated into the same frame as the rooms. Drawn
// filled so real wall thickness — and the GAPS where two rooms meet with no wall
// (open-plan) — read directly. Non-interactive (pointer-events:none) so it never
// intercepts furniture/room/handle pointer events regardless of stacking order.

function DatasetWallLayer({ walls }: { walls: Point2D[][] }) {
  if (!walls.length) return null;
  return (
    <g className="dataset-wall-layer" style={{ pointerEvents: "none" }}>
      {walls.map((ring, i) => (
        <path key={i} className="dataset-wall" d={pointsToPath(ring, true)} />
      ))}
    </g>
  );
}

// ─── Generated walls (offset from the traced axes — see walls.ts) ────────────
// One path per wall body, each carrying its outer ring plus any holes, so the
// evenodd fill rule leaves the enclosed rooms empty. Same paint as the dataset
// walls, so a traced plan and a dataset plan read identically.

function GeneratedWallLayer({ walls }: { walls: WallPolygon[] }) {
  if (!walls.length) return null;
  return (
    <g className="dataset-wall-layer" style={{ pointerEvents: "none" }}>
      {walls.map((poly, i) => (
        <path
          key={i}
          className="dataset-wall"
          fillRule="evenodd"
          d={poly.map((ring) => pointsToPath(ring, true)).join(" ")}
        />
      ))}
    </g>
  );
}

// ─── Uploaded apartment shell (contour + its windows) ────────────────────────
// An apartment JSON carries the shell only: the outer contour, its entrance
// door and its windows. Rooms are traced by hand inside it afterwards, so the
// contour is display-only — it never takes part in furnishing. Its wall bands
// go through the same DatasetWallLayer, and its entrance through EntranceLayer.

type ApartmentShell = {
  outline: Point2D[];
  /** Openings already snapped onto their contour edge, so the wall bands can be
   *  rebuilt whenever the wall settings change without re-reading the file. */
  doors: EntranceDoor[];
  windows: EntranceDoor[];
};

function ApartmentShellLayer({ shell, showOutline }: { shell: ApartmentShell | null; showOutline: boolean }) {
  if (!shell) return null;
  return (
    <g className="apartment-shell-layer" style={{ pointerEvents: "none" }}>
      {/* With outer walls on, the wall body already draws the contour — the bare
          axis line would only cut through its fill. */}
      {showOutline ? <path className="apartment-shell-outline" d={pointsToPath(shell.outline, true)} /> : null}
      {shell.windows.map((w, i) => {
        const g = getPolygonWindowGeometry(shell.outline, w.point, w.width);
        return g ? <WindowGlyph key={i} geometry={g} /> : null;
      })}
    </g>
  );
}

// ─── EdgeEditor ───────────────────────────────────────────────────────────────

function EdgeEditor({
  room,
  svgRef,
  onUpdate,
  onMoveRoom,
  layer,
}: {
  room: DrawnRoom;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onUpdate: (roomId: string, points: Point2D[]) => void;
  onMoveRoom: (roomId: string, points: Point2D[], doors: Point2D[], windows: Point2D[]) => void;
  layer: "body" | "handles";
}) {
  const [dragState, setDragState] = useState<EdgeDragState | null>(null);

  function worldPoint(clientX: number, clientY: number): Point2D | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const w = pt.matrixTransform(matrix.inverse());
    return { x: w.x, y: w.y };
  }

  // ── Edge midpoint drag ─────────────────────────────────────────────────────

  function handleEdgePointerDown(event: PointerEvent<SVGCircleElement>, edgeIndex: number) {
    event.stopPropagation();
    const world = worldPoint(event.clientX, event.clientY);
    if (!world) return;

    // Use the parent wall's direction for a clean perpendicular normal
    const { normal } = findWallGroup(room.points, edgeIndex);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({ kind: "edge", edgeIndex, normal, startWorld: world, originalPoints: [...room.points] });
  }

  // ── Vertex drag ────────────────────────────────────────────────────────────

  function handleVertexPointerDown(event: PointerEvent<SVGCircleElement>, vertexIndex: number) {
    event.stopPropagation();
    const world = worldPoint(event.clientX, event.clientY);
    if (!world) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({ kind: "vertex", vertexIndex, startWorld: world, originalPoints: [...room.points] });
  }

  // ── Whole-room body drag (translate points + doors + windows) ───────────────

  function handleBodyPointerDown(event: PointerEvent<SVGPathElement>) {
    event.stopPropagation();
    const world = worldPoint(event.clientX, event.clientY);
    if (!world) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      kind: "body",
      startWorld: world,
      originalPoints: [...room.points],
      originalDoors: [...room.doors],
      originalWindows: [...room.windows],
    });
  }

  // ── Shared move / up ───────────────────────────────────────────────────────

  function handlePointerMove(event: PointerEvent<SVGElement>) {
    if (!dragState) return;
    const world = worldPoint(event.clientX, event.clientY);
    if (!world) return;

    if (dragState.kind === "body") {
      const dx = world.x - dragState.startWorld.x;
      const dy = world.y - dragState.startWorld.y;
      const shift = (p: Point2D): Point2D => ({ x: p.x + dx, y: p.y + dy });
      onMoveRoom(
        room.id,
        dragState.originalPoints.map(shift),
        dragState.originalDoors.map(shift),
        dragState.originalWindows.map(shift),
      );
      return;
    }

    if (dragState.kind === "edge") {
      const offset =
        (world.x - dragState.startWorld.x) * dragState.normal.x +
        (world.y - dragState.startWorld.y) * dragState.normal.y;

      const orig = dragState.originalPoints;
      const n = orig.length;
      const ei = dragState.edgeIndex;
      const a = orig[ei];
      const b = orig[(ei + 1) % n];
      const aPrime = { x: a.x + dragState.normal.x * offset, y: a.y + dragState.normal.y * offset };
      const bPrime = { x: b.x + dragState.normal.x * offset, y: b.y + dragState.normal.y * offset };

      // Is each endpoint interior to a longer collinear wall, or is it a corner?
      const { wallSet } = findWallGroup(orig, ei);
      const aIsInterior = wallSet.has((ei - 1 + n) % n);
      const bIsInterior = wallSet.has((ei + 2) % n);

      // Build new polygon: interior endpoints keep original + get a new inserted vertex;
      // corner endpoints are simply moved (no new vertex, no congestion).
      const newPoints: Point2D[] = [];
      for (let k = 0; k < n; k++) {
        if (k === ei) {
          if (aIsInterior) { newPoints.push(orig[k]); newPoints.push(aPrime); }
          else              { newPoints.push(aPrime); }
        } else if (k === (ei + 1) % n) {
          if (bIsInterior) { newPoints.push(bPrime); newPoints.push(orig[k]); }
          else             { newPoints.push(bPrime); }
        } else {
          newPoints.push(orig[k]);
        }
      }
      onUpdate(room.id, newPoints);
    } else {
      const dx = world.x - dragState.startWorld.x;
      const dy = world.y - dragState.startWorld.y;
      const newPoints = dragState.originalPoints.map((p, i) =>
        i === dragState.vertexIndex ? { x: p.x + dx, y: p.y + dy } : p,
      );
      onUpdate(room.id, newPoints);
    }
  }

  function handlePointerUp(event: PointerEvent<SVGElement>) {
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragState(null);
  }

  // ── Click on edge to insert vertex ─────────────────────────────────────────

  function handleEdgeClick(event: MouseEvent<SVGLineElement>, edgeIndex: number) {
    event.stopPropagation();
    if (dragState) return;
    const world = worldPoint(event.clientX, event.clientY);
    if (!world) return;

    const a = room.points[edgeIndex];
    const b = room.points[(edgeIndex + 1) % room.points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 0.0001) return;

    const t = Math.max(0.05, Math.min(0.95, ((world.x - a.x) * dx + (world.y - a.y) * dy) / lengthSq));
    const inserted = { x: a.x + dx * t, y: a.y + dy * t };

    onUpdate(room.id, [
      ...room.points.slice(0, edgeIndex + 1),
      inserted,
      ...room.points.slice(edgeIndex + 1),
    ]);
  }

  // The editor is split into two stacked layers so the room's edge/vertex
  // handles can paint ABOVE the furniture layer (a vertex under a piece stays
  // grabbable) while the room-body translate surface stays BELOW it (furniture
  // remains selectable/draggable, empty floor still moves the room).
  //   layer="body"    → background: only the .room-body-drag translate surface
  //   layer="handles" → foreground: outline + edge hit-areas + edge/vertex handles
  // Each layer keeps its own dragState, which is coherent because a pointer
  // capture keeps every event of a given drag on the element that started it,
  // so a drag never spans the two layers.
  if (layer === "body") {
    // Background layer (BELOW furniture): the room-body translate surface, the
    // outline, and the WIDE (0.3 m) edge hit-areas. These must sit below the
    // furniture layer — otherwise the wide hit-bands along the walls swallow
    // clicks on furniture placed against those walls (and a click there would
    // insert a vertex, wiping the room's furniture). Only the small grab
    // handles go in the foreground layer so a vertex under a piece stays
    // grabbable without blocking furniture selection.
    return (
      <g className="edge-editor">
        <path
          className="room-body-drag"
          d={pointsToPath(room.points, true)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={handleBodyPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
        <path className="edge-editor-outline" d={pointsToPath(room.points, true)} stroke={room.color} />
        {/* Invisible wide hit-areas — click anywhere on an edge to add a vertex */}
        {room.points.map((_, i) => {
          const a = room.points[i];
          const b = room.points[(i + 1) % room.points.length];
          return (
            <line
              key={`hit-${i}`}
              className="edge-hit-area"
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              onClick={(e) => handleEdgeClick(e, i)}
            />
          );
        })}
      </g>
    );
  }

  return (
    <g className="edge-editor">
      {/* Edge midpoint handles */}
      {room.points.map((_, i) => {
        const a = room.points[i];
        const b = room.points[(i + 1) % room.points.length];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const isActive = dragState?.kind === "edge" && dragState.edgeIndex === i;
        return (
          <circle
            key={`edge-${i}`}
            className={`edge-handle${isActive ? " active" : ""}`}
            cx={mx} cy={my} r="0.09"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => handleEdgePointerDown(e, i)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />
        );
      })}

      {/* Vertex handles */}
      {room.points.map((pt, i) => {
        const isActive = dragState?.kind === "vertex" && dragState.vertexIndex === i;
        return (
          <circle
            key={`vert-${i}`}
            className={`vertex-handle${isActive ? " active" : ""}`}
            cx={pt.x} cy={pt.y} r="0.08"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => handleVertexPointerDown(e, i)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />
        );
      })}
    </g>
  );
}

// ─── SVG sub-components ───────────────────────────────────────────────────────

function ScaleCalibrationLayer({ calibration }: { calibration: ScaleCalibration }) {
  const { p1, p2, cursor } = calibration;
  if (!p1) return null;

  const previewPoint = p2 ? cursor : null;
  const lockedLabel = p2 ? lineLabelPosition(p1, p2, -0.35) : null;
  const previewLabel = previewPoint ? lineLabelPosition(p1, previewPoint, 0.35) : null;

  return (
    <g className="scale-calibration-layer">
      <circle className="calibration-point" cx={p1.x} cy={p1.y} r="0.12" />
      {p2 ? (
        <>
          <line className="calibration-line locked" x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} />
          <circle className="calibration-point" cx={p2.x} cy={p2.y} r="0.12" />
          <text className="calibration-label" x={lockedLabel?.x} y={lockedLabel?.y}>
            {formatMetres(distance(p1, p2))}
          </text>
        </>
      ) : null}
      {previewPoint ? (
        <>
          <line className="calibration-line preview" x1={p1.x} y1={p1.y} x2={previewPoint.x} y2={previewPoint.y} />
          <circle className="calibration-point preview" cx={previewPoint.x} cy={previewPoint.y} r="0.1" />
          <text className="calibration-label preview" x={previewLabel?.x} y={previewLabel?.y}>
            {formatMetres(distance(p1, previewPoint))}
          </text>
        </>
      ) : null}
    </g>
  );
}

function FurniturePreview({ pieces }: { pieces: PlacedFurniture[] }) {
  if (!pieces.length) return null;
  return (
    <g className="furniture-preview">
      {pieces.map((piece, i) => (
        <g key={`${piece.name}-${i}`}>
          {piece.transformedGeometry.map((geom, j) => (
            <path
              key={`${piece.name}-${i}-${j}`}
              d={pointsToPath(geom.points.map(([x, y]) => ({ x, y })), geom.closed)}
              className={geom.closed ? "closed" : "open"}
            />
          ))}
        </g>
      ))}
    </g>
  );
}

function DoorSwing({
  room,
  ownedDoors,
  showAll,
  entrancePoints,
}: {
  room: DrawnRoom;
  ownedDoors: boolean[];
  showAll: boolean;
  entrancePoints: Point2D[];
}) {
  if (!room.doors.length) return null;
  const hingeSides = doubleDoorHinges(room);
  return (
    <>
      {room.doors.map((doorPoint, i) => {
        // The door SWING glyph (arc + panel) is drawn once per physical door,
        // by the owning room, in BOTH views — so Transition Zones never adds a
        // duplicate door. The clearance ZONE is drawn per room in transition
        // view so both sides of a shared door are visible.
        // A door that coincides with the apartment entrance is drawn by
        // EntranceLayer instead (distinct glyph); suppress the plain glyph here
        // to avoid a double swing, but keep its clearance zone.
        const isEntrance = entrancePoints.some((e) => distance(e, doorPoint) < 0.05);
        const drawGlyph = ownedDoors[i] && !isEntrance;
        const drawZone = showAll;
        if (!drawGlyph && !drawZone) return null;
        const geometry = getDoorSwingGeometry(room, doorPoint, hingeSides[i]);
        if (!geometry) return null;
        const { arcEnd, hinge, radius, sweepFlag, panelEnd } = geometry;
        // Door clearance/transition area = a door-width square reaching from the
        // doorway INTO THE ROOM INTERIOR (the passage/approach zone furniture
        // must keep clear). Note the leaf may swing the OTHER way (into a
        // corridor); the swing arc already shows that side, so we always draw
        // this square toward the room's interior, not the swing side. Direction
        // is taken toward the room centroid so it's correct regardless of swing.
        const w = radius;
        const wallDir = { x: (arcEnd.x - hinge.x) / w, y: (arcEnd.y - hinge.y) / w };
        const dc = { x: (hinge.x + arcEnd.x) / 2, y: (hinge.y + arcEnd.y) / 2 };
        const nrm = perpCounterClockwise(wallDir);
        const cx = room.points.reduce((s, p) => s + p.x, 0) / room.points.length;
        const cy = room.points.reduce((s, p) => s + p.y, 0) / room.points.length;
        const roomInward = (nrm.x * (cx - dc.x) + nrm.y * (cy - dc.y)) >= 0 ? nrm : { x: -nrm.x, y: -nrm.y };
        const t0 = { x: dc.x - wallDir.x * (w / 2), y: dc.y - wallDir.y * (w / 2) };
        const t1 = { x: dc.x + wallDir.x * (w / 2), y: dc.y + wallDir.y * (w / 2) };
        const t2 = { x: t1.x + roomInward.x * w, y: t1.y + roomInward.y * w };
        const t3 = { x: t0.x + roomInward.x * w, y: t0.y + roomInward.y * w };
        return (
          <g key={i} className="room-door">
            {drawZone && (
              <path
                className="door-transition-area"
                d={pointsToPath([t0, t1, t2, t3], true)}
              />
            )}
            {drawGlyph && (
              <>
                <line x1={hinge.x} y1={hinge.y} x2={panelEnd.x} y2={panelEnd.y} />
                <path
                  className="door-arc"
                  d={`M ${panelEnd.x} ${panelEnd.y} A ${radius} ${radius} 0 0 ${sweepFlag} ${arcEnd.x} ${arcEnd.y}`}
                />
                <circle className="door-hinge" cx={hinge.x} cy={hinge.y} r="0.035" />
                <circle className="door-center" cx={doorPoint.x} cy={doorPoint.y} r="0.05" />
              </>
            )}
          </g>
        );
      })}
    </>
  );
}

function windowWidth(roomType: RoomToolId): number {
  return roomType === "Bathroom" || roomType === "WC" || roomType === "Kitchen" ? 1.0 : 1.5;
}

/** Window glyph geometry against any closed boundary — a room polygon or the
 *  uploaded apartment contour. The reveal is drawn toward the polygon interior. */
function getPolygonWindowGeometry(polygon: Point2D[], windowPt: Point2D, width: number) {
  if (polygon.length < 2) return null;
  let wallA = polygon[0], wallB = polygon[1];
  let minDist = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const d = nearestPointOnSegment(windowPt, a, b).distance;
    if (d < minDist) { minDist = d; wallA = a; wallB = b; }
  }
  const dir = normalizeVector({ x: wallB.x - wallA.x, y: wallB.y - wallA.y });
  const snap = nearestPointOnSegment(windowPt, wallA, wallB).point;
  const half = width / 2;
  const start = { x: snap.x - dir.x * half, y: snap.y - dir.y * half };
  const end   = { x: snap.x + dir.x * half, y: snap.y + dir.y * half };
  const normal = perpCounterClockwise(dir);
  const inward = pointInPolygon(addPoint(snap, scalePoint(normal, 0.05)), polygon)
    ? normal : scalePoint(normal, -1);
  const REVEAL = 0.14;
  return { start, end, snap, inward, reveal: REVEAL };
}

function getWindowGeometry(room: DrawnRoom, windowPt: Point2D, width?: number) {
  return getPolygonWindowGeometry(room.points, windowPt, width ?? windowWidth(room.type));
}

type WindowGeometry = NonNullable<ReturnType<typeof getPolygonWindowGeometry>>;

function WindowGlyph({ geometry }: { geometry: WindowGeometry }) {
  const { start, end, snap, inward, reveal } = geometry;
  const inner = (p: Point2D) => addPoint(p, scalePoint(inward, -reveal));
  return (
    <g className="room-window">
      <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="window-outer" />
      <line x1={inner(start).x} y1={inner(start).y} x2={inner(end).x} y2={inner(end).y} className="window-inner" />
      <line x1={start.x} y1={start.y} x2={inner(start).x} y2={inner(start).y} className="window-jamb" />
      <line x1={end.x} y1={end.y} x2={inner(end).x} y2={inner(end).y} className="window-jamb" />
      <circle className="window-center" cx={snap.x} cy={snap.y} r="0.08" />
    </g>
  );
}

function WindowDisplay({ room }: { room: DrawnRoom }) {
  if (!room.windows.length) return null;
  return (
    <>
      {room.windows.map((winPt, i) => {
        const g = getWindowGeometry(room, winPt, room.windowWidths?.[i] ?? windowWidth(room.type));
        return g ? <WindowGlyph key={i} geometry={g} /> : null;
      })}
    </>
  );
}

function RoomLayer({
  draft,
  drawMode,
  furnishedRooms,
  rooms,
  selectedRoomId,
  selectable,
  showTransitionAreas,
  entrancePoints,
  onSelectRoom,
}: {
  draft: RoomDraft | null;
  drawMode: "rectangle" | "lines";
  furnishedRooms: FurnishedRoomResult[];
  rooms: DrawnRoom[];
  selectedRoomId: string | null;
  selectable: boolean;
  showTransitionAreas: boolean;
  entrancePoints: Point2D[];
  onSelectRoom: (id: string) => void;
}) {
  const furnishedByRoomId = new Map(furnishedRooms.map((r) => [r.roomId, r]));
  const doorOwnership = useMemo(() => computeDoorOwnership(rooms), [rooms]);

  const isRectPreview =
    drawMode === "rectangle" &&
    draft !== null &&
    draft.points.length === 1 &&
    draft.cursor !== null &&
    (Math.abs(draft.cursor.x - draft.points[0].x) > 0.01 || Math.abs(draft.cursor.y - draft.points[0].y) > 0.01);

  const draftDisplayPoints: Point2D[] = (() => {
    if (!draft) return [];
    if (isRectPreview) {
      const a = draft.points[0];
      const c = draft.cursor!;
      return [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }];
    }
    return [...draft.points, ...(draft.cursor ? [draft.cursor] : [])];
  })();

  return (
    <g className="room-layer">
      {rooms.map((room) => (
        <g key={room.id} className={`drawn-room${room.id === selectedRoomId ? " selected" : ""}`}>
          <path
            d={pointsToPath(room.points, true)}
            fill={room.color}
            stroke={room.color}
            style={{ cursor: selectable ? "pointer" : undefined }}
            onClick={selectable ? (e) => { e.stopPropagation(); onSelectRoom(room.id); } : undefined}
          />
          <EdgeLabels points={room.points} closed={true} isDraft={false} color={room.color} />
          {room.points.map((point, index) => (
            <circle key={`${room.id}-v${index}`} cx={point.x} cy={point.y} r="0.09" stroke={room.color} />
          ))}
          <RoomLabel room={room} />
          <DoorSwing
            room={room}
            ownedDoors={doorOwnership.get(room.id) ?? []}
            showAll={showTransitionAreas}
            entrancePoints={entrancePoints}
          />
          <WindowDisplay room={room} />
          <FurniturePreview pieces={(furnishedByRoomId.get(room.id)?.steps ?? []).flatMap((s) => s.selected ? [s.selected.placed] : [])} />
        </g>
      ))}

      {draft && isRectPreview ? (
        <g className="room-draft">
          <EdgeLabels points={draftDisplayPoints} closed={true} isDraft={true} color={draft.color} />
          <path d={pointsToPath(draftDisplayPoints, true)} stroke={draft.color} />
          <circle cx={draft.points[0].x} cy={draft.points[0].y} r="0.1" stroke={draft.color} />
        </g>
      ) : draft && draftDisplayPoints.length > 1 ? (
        <g className="room-draft">
          <EdgeLabels points={draftDisplayPoints} closed={false} isDraft={true} color={draft.color} />
          <path d={pointsToPath(draftDisplayPoints, false)} stroke={draft.color} className={draft.orthogonal ? "ortho" : ""} />
          {draft.points.map((point, index) => (
            <circle
              key={`draft-v${index}`}
              className={index === 0 && draft.points.length >= 3 ? "close-target" : ""}
              cx={point.x}
              cy={point.y}
              r={index === 0 && draft.points.length >= 3 ? "0.16" : "0.1"}
              stroke={draft.color}
            />
          ))}
          {draft.cursor ? (
            <circle
              className={draft.orthogonal ? "ortho-cursor" : ""}
              cx={draft.cursor.x}
              cy={draft.cursor.y}
              r="0.1"
              stroke={draft.orthogonal ? "#D97757" : draft.color}
            />
          ) : null}
        </g>
      ) : draft && draft.points.length === 1 ? (
        <g className="room-draft">
          <circle cx={draft.points[0].x} cy={draft.points[0].y} r="0.1" stroke={draft.color} />
        </g>
      ) : null}
    </g>
  );
}

// ─── ScaleBarOverlay ─────────────────────────────────────────────────────────

function ScaleBarOverlay({ transform }: { transform: ViewerTransform }) {
  const m = transform.metresAcross;
  const left   = transform.centerX - m / 2;
  const bottom = transform.centerY + m / 2;
  const bx = Math.ceil(left) - 2;
  const by = Math.round(bottom - m * 0.045);
  const tickH    = m * 0.015;
  const sw       = m * 0.003;
  const fontSize = m * 0.025;
  return (
    <g className="scale-bar-svg" style={{ pointerEvents: "none" }}>
      <line x1={bx} y1={by} x2={bx + 1} y2={by} strokeWidth={sw} />
      <line x1={bx}     y1={by - tickH} x2={bx}     y2={by} strokeWidth={sw} />
      <line x1={bx + 1} y1={by - tickH} x2={bx + 1} y2={by} strokeWidth={sw} />
      <text x={bx + 0.5} y={by - tickH - fontSize * 0.4} textAnchor="middle" fontSize={fontSize}>1 m</text>
    </g>
  );
}

// ─── FurnitureHandles ─────────────────────────────────────────────────────────

type FurnitureDragState = {
  roomId: string;
  stepIndex: number;
  cursor: Point2D;
};

/** The wall-midpoint grab handle of the selected piece.
 *
 *  Rendered in a layer ABOVE every furniture and candidate group, never inside
 *  the group it belongs to. Each piece paints an invisible `pointer-events:all`
 *  click target over its footprint, and failed candidates in particular overlap
 *  heavily (they are the pieces that did not fit) — so a handle drawn inside its
 *  own group is swallowed by the click target of any piece that happens to come
 *  later in document order. The handle stays visible, but the pointerdown lands
 *  on the other piece and the drag never starts. */
function WallDragHandle({
  at,
  room,
  drag,
  setDrag,
  roomId,
  stepIndex,
  toWorld,
  onDrop,
}: {
  at: Point2D;
  room: DrawnRoom;
  drag: FurnitureDragState | null;
  setDrag: (next: FurnitureDragState | null | ((d: FurnitureDragState | null) => FurnitureDragState | null)) => void;
  roomId: string;
  stepIndex: number;
  toWorld: (clientX: number, clientY: number) => Point2D | null;
  onDrop: (snap: Point2D, wallA: Point2D, wallB: Point2D, inward: Point2D) => void;
}) {
  return (
    <circle
      cx={at.x} cy={at.y} r="0.13"
      className="furniture-drag-handle"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        const w = toWorld(e.clientX, e.clientY);
        if (!w) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ roomId, stepIndex, cursor: w });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const w = toWorld(e.clientX, e.clientY);
        if (w) setDrag((d) => (d ? { ...d, cursor: w } : null));
      }}
      onPointerUp={(e) => {
        if (!drag || drag.roomId !== roomId || drag.stepIndex !== stepIndex) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        const s = snapToRoomWall(drag.cursor, room);
        if (s) onDrop(s.point, s.wallA, s.wallB, s.inward);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    />
  );
}

function FurnitureHandles({
  rooms,
  furnishedRooms,
  selectedKey,
  selectedRoomId,
  isFurnishMode,
  svgRef,
  onSelect,
  onDrop,
  failedCandidates,
  showFailedCandidates,
  selectedCandidateKey,
  onSelectCandidate,
  onCandidateDrop,
}: {
  rooms: DrawnRoom[];
  furnishedRooms: FurnishedRoomResult[];
  selectedKey: FurnitureKey | null;
  selectedRoomId: string | null;
  isFurnishMode: boolean;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onSelect: (key: FurnitureKey | null) => void;
  onDrop: (roomId: string, stepIdx: number, snap: Point2D, wallA: Point2D, wallB: Point2D, inward: Point2D) => void;
  failedCandidates: FailedCandidate[];
  showFailedCandidates: boolean;
  selectedCandidateKey: FurnitureKey | null;
  onSelectCandidate: (key: FurnitureKey | null) => void;
  onCandidateDrop: (key: FurnitureKey, snap: Point2D, wallA: Point2D, wallB: Point2D, inward: Point2D) => void;
}) {
  const [drag, setDrag] = useState<FurnitureDragState | null>(null);
  // Separate drag state for failed candidates — reuses the same pointer math,
  // snapToRoomWall, wall-midpoint handle and ghost as the placed-furniture drag.
  const [candDrag, setCandDrag] = useState<FurnitureDragState | null>(null);

  function toWorld(clientX: number, clientY: number): Point2D | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const m = svg.getScreenCTM();
    if (!m) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const w = pt.matrixTransform(m.inverse());
    return { x: w.x, y: w.y };
  }

  return (
    <>
      {furnishedRooms.flatMap((rr) => {
        const room = rooms.find((r) => r.id === rr.roomId);
        if (!room) return [];
        const isActiveRoom = rr.roomId === selectedRoomId;
        return rr.steps.flatMap((step, si) => {
          if (!step.selected) return [];
          const placed = step.selected.placed;
          const isSelected = isActiveRoom && selectedKey?.roomId === rr.roomId && selectedKey?.stepIndex === si;
          const isDragging = isActiveRoom && drag?.roomId === rr.roomId && drag?.stepIndex === si;
          const snap = isDragging ? snapToRoomWall(drag!.cursor, room) : null;

          // Click target: small bbox only
          const smallPts = (placed.transformedSmallBbox as unknown as [number, number][]).map(([x, y]) => ({ x, y }));
          const smallPath = pointsToPath(smallPts, true);

          // Drag handle: midpoint of wall-side edge of bboxBig
          const handlePt = isSelected ? getWallMidpointPt(placed) : null;

          // Ghost: offset all bboxBig pts by cursor − handlePt
          const bboxPts = (placed.transformedBbox as unknown as [number, number][]).map(([x, y]) => ({ x, y }));

          return [
            <g key={`fh-${rr.roomId}-${si}`}>
              {/* transparent click target over bboxSmall — only for the selected room */}
              {isFurnishMode && isActiveRoom && (
                <path
                  d={smallPath}
                  fill="transparent"
                  stroke="none"
                  style={{ pointerEvents: "all", cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(isSelected ? null : { roomId: rr.roomId, stepIndex: si });
                  }}
                />
              )}

              {/* selection highlight on bboxSmall */}
              {isSelected && <path d={smallPath} className="furniture-selected-bbox" />}

              {/* The drag handle itself is drawn later, in the handle layer. */}

              {/* drag ghost + snap indicator */}
              {isDragging && drag && handlePt && (() => {
                const dx = drag.cursor.x - handlePt.x;
                const dy = drag.cursor.y - handlePt.y;
                const ghostPts = bboxPts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
                return (
                  <>
                    <path d={pointsToPath(ghostPts, true)} className="furniture-drag-ghost" />
                    {placed.transformedGeometry.map((geom, j) => (
                      <path
                        key={`ghost-geom-${j}`}
                        d={pointsToPath(geom.points.map(([x, y]) => ({ x: x + dx, y: y + dy })), geom.closed)}
                        className="furniture-drag-ghost-geom"
                      />
                    ))}
                    {snap && <circle cx={snap.point.x} cy={snap.point.y} r="0.09" className="furniture-snap-point" />}
                    {snap && (
                      <line x1={drag.cursor.x} y1={drag.cursor.y} x2={snap.point.x} y2={snap.point.y} className="furniture-drag-line" />
                    )}
                  </>
                );
              })()}
            </g>,
          ];
        });
      })}

      {/* Failed / unplaced candidates — draggable footprints for pieces the
          engine could not auto-place. Shown for every furnished room, not just
          the selected one. Reuses the same drag machinery as placed furniture. */}
      {showFailedCandidates && failedCandidates.flatMap((c) => {
        const room = rooms.find((r) => r.id === c.roomId);
        if (!room) return [];
        const isSelected =
          selectedCandidateKey?.roomId === c.roomId && selectedCandidateKey?.stepIndex === c.stepIndex;
        const isDragging =
          candDrag?.roomId === c.roomId && candDrag?.stepIndex === c.stepIndex;

        const smallPts = (c.placed.transformedSmallBbox as unknown as [number, number][]).map(([x, y]) => ({ x, y }));
        const smallPath = pointsToPath(smallPts, true);
        const bboxPts = (c.placed.transformedBbox as unknown as [number, number][]).map(([x, y]) => ({ x, y }));
        const labelPt = polygonCentroid(smallPts);
        const handlePt = isSelected ? getWallMidpointPt(c.placed) : null;

        return [
          <g key={`cand-${c.roomId}-${c.stepIndex}`} className={`failed-candidate${isSelected ? " selected" : ""}`}>
            {/* Symbol geometry drawn in the distinct "unplaced" style */}
            {c.placed.transformedGeometry.map((geom, j) => (
              <path
                key={`cg-${j}`}
                d={pointsToPath(geom.points.map(([x, y]) => ({ x, y })), geom.closed)}
                className={`failed-candidate-geom${geom.closed ? " closed" : ""}`}
              />
            ))}
            {/* Dashed footprint outline */}
            <path d={smallPath} className="failed-candidate-bbox" />
            {/* Piece-name label */}
            <text
              className="failed-candidate-label"
              x={labelPt.x}
              y={labelPt.y}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {c.furnitureName}
            </text>
            {/* Transparent click target for selection */}
            {isFurnishMode && (
              <path
                d={smallPath}
                fill="transparent"
                stroke="none"
                style={{ pointerEvents: "all", cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectCandidate(
                    isSelected ? null : { roomId: c.roomId, stepIndex: c.stepIndex },
                  );
                }}
              />
            )}

            {/* The drag handle itself is drawn later, in the handle layer. */}

            {/* Drag ghost + snap indicator */}
            {isDragging && candDrag && handlePt && (() => {
              const dx = candDrag.cursor.x - handlePt.x;
              const dy = candDrag.cursor.y - handlePt.y;
              const ghostPts = bboxPts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
              const snap = snapToRoomWall(candDrag.cursor, room);
              return (
                <>
                  <path d={pointsToPath(ghostPts, true)} className="furniture-drag-ghost" />
                  {c.placed.transformedGeometry.map((geom, j) => (
                    <path
                      key={`cand-ghost-geom-${j}`}
                      d={pointsToPath(geom.points.map(([x, y]) => ({ x: x + dx, y: y + dy })), geom.closed)}
                      className="furniture-drag-ghost-geom"
                    />
                  ))}
                  {snap && <circle cx={snap.point.x} cy={snap.point.y} r="0.09" className="furniture-snap-point" />}
                  {snap && (
                    <line x1={candDrag.cursor.x} y1={candDrag.cursor.y} x2={snap.point.x} y2={snap.point.y} className="furniture-drag-line" />
                  )}
                </>
              );
            })()}
          </g>,
        ];
      })}

      {/* ── Handle layer ──────────────────────────────────────────────────────
          Every grab handle, above every footprint click target. See
          WallDragHandle for why they cannot live inside their own group. */}
      <g className="furniture-handle-layer">
        {(() => {
          if (!isFurnishMode || !selectedKey || selectedKey.roomId !== selectedRoomId) return null;
          const rr = furnishedRooms.find((r) => r.roomId === selectedKey.roomId);
          const room = rooms.find((r) => r.id === selectedKey.roomId);
          const placed = rr?.steps[selectedKey.stepIndex]?.selected?.placed;
          if (!rr || !room || !placed) return null;
          const at = getWallMidpointPt(placed);
          if (!at) return null;
          return (
            <WallDragHandle
              at={at}
              room={room}
              drag={drag}
              setDrag={setDrag}
              roomId={selectedKey.roomId}
              stepIndex={selectedKey.stepIndex}
              toWorld={toWorld}
              onDrop={(snap, wallA, wallB, inward) =>
                onDrop(selectedKey.roomId, selectedKey.stepIndex, snap, wallA, wallB, inward)}
            />
          );
        })()}

        {(() => {
          if (!isFurnishMode || !showFailedCandidates || !selectedCandidateKey) return null;
          const c = failedCandidates.find(
            (x) => x.roomId === selectedCandidateKey.roomId && x.stepIndex === selectedCandidateKey.stepIndex,
          );
          const room = rooms.find((r) => r.id === selectedCandidateKey.roomId);
          if (!c || !room) return null;
          const at = getWallMidpointPt(c.placed);
          if (!at) return null;
          return (
            <WallDragHandle
              at={at}
              room={room}
              drag={candDrag}
              setDrag={setCandDrag}
              roomId={c.roomId}
              stepIndex={c.stepIndex}
              toWorld={toWorld}
              onDrop={(snap, wallA, wallB, inward) =>
                onCandidateDrop({ roomId: c.roomId, stepIndex: c.stepIndex }, snap, wallA, wallB, inward)}
            />
          );
        })()}
      </g>
    </>
  );
}

// ─── ViewerLayer ──────────────────────────────────────────────────────────────

function ViewerLayer({
  backgroundImages,
  calibration,
  furnishedRooms,
  roomDraft,
  rooms,
  selectedRoomId,
  selectedTool,
  drawMode,
  gridStep,
  transform,
  selectedFurnitureKey,
  datasetContext,
  datasetWalls,
  datasetEntrances,
  apartmentShell,
  generatedWalls,
  showWalls,
  onCalibrationClick,
  onCalibrationMove,
  onRoomClick,
  onRoomPointerMove,
  onDoorClick,
  onWindowClick,
  onMoveImage,
  onSelectRoom,
  onSelectFurniture,
  onUpdateRoom,
  onMoveRoom,
  onFurnitureDrop,
  onPan,
  showTransitionAreas,
  failedCandidates,
  showFailedCandidates,
  selectedCandidateKey,
  onSelectCandidate,
  onCandidateDrop,
}: {
  backgroundImages: BackgroundImage[];
  calibration: ScaleCalibration;
  furnishedRooms: FurnishedRoomResult[];
  roomDraft: RoomDraft | null;
  rooms: DrawnRoom[];
  selectedRoomId: string | null;
  selectedTool: ToolId;
  drawMode: "rectangle" | "lines";
  gridStep: number;
  transform: ViewerTransform;
  selectedFurnitureKey: FurnitureKey | null;
  datasetContext: DatasetContextArea[];
  datasetWalls: Point2D[][];
  datasetEntrances: EntranceDoor[];
  apartmentShell: ApartmentShell | null;
  generatedWalls: WallPolygon[];
  showWalls: boolean;
  onCalibrationClick: (point: Point2D) => void;
  onCalibrationMove: (point: Point2D) => void;
  onRoomClick: (point: Point2D) => void;
  onRoomPointerMove: (point: Point2D) => void;
  onDoorClick: (point: Point2D) => void;
  onWindowClick: (point: Point2D) => void;
  onMoveImage: (id: string, dx: number, dy: number) => void;
  onSelectRoom: (id: string | null) => void;
  onSelectFurniture: (key: FurnitureKey | null) => void;
  onUpdateRoom: (roomId: string, points: Point2D[]) => void;
  onMoveRoom: (roomId: string, points: Point2D[], doors: Point2D[], windows: Point2D[]) => void;
  onFurnitureDrop: (roomId: string, stepIdx: number, snap: Point2D, wallA: Point2D, wallB: Point2D, inward: Point2D) => void;
  onPan: (cx: number, cy: number) => void;
  showTransitionAreas: boolean;
  failedCandidates: FailedCandidate[];
  showFailedCandidates: boolean;
  selectedCandidateKey: FurnitureKey | null;
  onSelectCandidate: (key: FurnitureKey | null) => void;
  onCandidateDrop: (key: FurnitureKey, snap: Point2D, wallA: Point2D, wallB: Point2D, inward: Point2D) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewBox = `${transform.centerX - transform.metresAcross / 2} ${transform.centerY - transform.metresAcross / 2} ${transform.metresAcross} ${transform.metresAcross}`;
  const panRef = useRef<{ startClientX: number; startClientY: number; startCenterX: number; startCenterY: number } | null>(null);

  // Grid drawn at the snapping step so what you see is what you snap to. Every
  // 4th line is emphasised to keep a coarse module readable when zoomed out.
  const gridLines = useMemo(() => {
    const step = gridStep > 0 ? gridStep : DEFAULT_GRID_STEP;
    const extent = 100;
    const count = Math.min(400, Math.floor(extent / step));
    const lines = [];
    for (let i = -count; i <= count; i++) {
      const v = i * step;
      const cls = i % 4 === 0 ? "grid-major" : undefined;
      lines.push(
        <line key={`x-${i}`} className={cls} x1={v} y1={-extent} x2={v} y2={extent} />,
        <line key={`y-${i}`} className={cls} x1={-extent} y1={v} x2={extent} y2={v} />,
      );
    }
    return lines;
  }, [gridStep]);

  function eventToWorldPoint(clientX: number, clientY: number): Point2D | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const w = point.matrixTransform(matrix.inverse());
    return { x: w.x, y: w.y };
  }

  function handleSvgPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 2) return;
    event.preventDefault();
    panRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCenterX: transform.centerX,
      startCenterY: transform.centerY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("panning");
  }

  function handleSvgPointerUp(event: PointerEvent<SVGSVGElement>) {
    if (panRef.current) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      event.currentTarget.classList.remove("panning");
      panRef.current = null;
    }
  }

  function handleSvgClick(event: MouseEvent<SVGSVGElement>) {
    if (panRef.current) return; // swallow click that follows a pan gesture
    const worldPoint = eventToWorldPoint(event.clientX, event.clientY);
    if (!worldPoint) return;

    if (selectedTool === "scale2d" && backgroundImages.some((b) => b.selected)) {
      event.stopPropagation();
      onCalibrationClick(worldPoint);
      return;
    }
    if (isRoomTool(selectedTool)) {
      event.stopPropagation();
      onRoomClick(worldPoint);
      return;
    }
    if (selectedTool === "doors") {
      event.stopPropagation();
      onDoorClick(worldPoint);
      return;
    }
    if (selectedTool === "windows") {
      event.stopPropagation();
      onWindowClick(worldPoint);
      return;
    }
    // idle — deselect room and furniture on background click
    onSelectRoom(null);
    onSelectFurniture(null);
    onSelectCandidate(null);
  }

  function handleSvgPointerMove(event: PointerEvent<SVGSVGElement>) {
    if (panRef.current) {
      const svg = svgRef.current;
      if (!svg) return;
      const ppm = svg.clientWidth / transform.metresAcross;
      const dx = (event.clientX - panRef.current.startClientX) / ppm;
      const dy = (event.clientY - panRef.current.startClientY) / ppm;
      onPan(panRef.current.startCenterX - dx, panRef.current.startCenterY - dy);
      return;
    }
    const worldPoint = eventToWorldPoint(event.clientX, event.clientY);
    if (!worldPoint) return;
    if (selectedTool === "scale2d" && backgroundImages.some((b) => b.selected)) {
      onCalibrationMove(worldPoint);
      return;
    }
    if (isRoomTool(selectedTool)) onRoomPointerMove(worldPoint);
  }

  function makeImagePointerHandlers(imageId: string, isSelected: boolean) {
    return {
      onPointerDown(event: PointerEvent<SVGGElement>) {
        if (!isSelected) return; // only draggable when selected via sidebar
        if (selectedTool === "scale2d" || isRoomTool(selectedTool) || selectedTool === "doors") return;
        event.preventDefault();
        event.stopPropagation();
        const world = eventToWorldPoint(event.clientX, event.clientY);
        if (!world) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.dataset.dragPointerId = String(event.pointerId);
        event.currentTarget.dataset.dragLastX = String(world.x);
        event.currentTarget.dataset.dragLastY = String(world.y);
      },
      onPointerMove(event: PointerEvent<SVGGElement>) {
        const target = event.currentTarget;
        if (target.dataset.dragPointerId !== String(event.pointerId)) return;
        const world = eventToWorldPoint(event.clientX, event.clientY);
        const lastX = Number(target.dataset.dragLastX);
        const lastY = Number(target.dataset.dragLastY);
        if (!world || Number.isNaN(lastX) || Number.isNaN(lastY)) return;
        onMoveImage(imageId, world.x - lastX, world.y - lastY);
        target.dataset.dragLastX = String(world.x);
        target.dataset.dragLastY = String(world.y);
      },
      onPointerUp(event: PointerEvent<SVGGElement>) {
        const target = event.currentTarget;
        if (target.dataset.dragPointerId !== String(event.pointerId)) return;
        delete target.dataset.dragPointerId;
        delete target.dataset.dragLastX;
        delete target.dataset.dragLastY;
        target.releasePointerCapture(event.pointerId);
      },
    };
  }

  const isEditing = selectedTool === "scale2d" || isRoomTool(selectedTool) || selectedTool === "doors" || selectedTool === "windows";
  const selectable = !isEditing;
  const selectedRoom = selectedRoomId ? rooms.find((r) => r.id === selectedRoomId) ?? null : null;

  return (
    <svg
      ref={svgRef}
      className={isEditing ? "viewer-grid editing-geometry" : "viewer-grid"}
      viewBox={viewBox}
      aria-label="Layout drawing surface"
      onClick={handleSvgClick}
      onPointerDown={handleSvgPointerDown}
      onPointerMove={handleSvgPointerMove}
      onPointerUp={handleSvgPointerUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <g className="grid-lines">{gridLines}</g>
      {backgroundImages.map((img) => {
        const handlers = makeImagePointerHandlers(img.id, img.selected ?? false);
        return (
          <g
            key={img.id}
            className={["background-image", img.selected ? "selected" : ""].filter(Boolean).join(" ")}
            transform={`translate(${img.x} ${img.y}) rotate(${img.rotation}) scale(${img.scale})`}
            opacity={img.opacity}
            onPointerDown={handlers.onPointerDown}
            onPointerMove={handlers.onPointerMove}
            onPointerUp={handlers.onPointerUp}
            onPointerCancel={handlers.onPointerUp}
          >
            <image
              href={img.src}
              x={-img.width / 2}
              y={-img.height / 2}
              width={img.width}
              height={img.height}
              preserveAspectRatio="none"
            />
            <rect
              className="background-image-frame"
              x={-img.width / 2}
              y={-img.height / 2}
              width={img.width}
              height={img.height}
            />
          </g>
        );
      })}
      <DatasetContextLayer areas={datasetContext} />
      {selectedTool === "scale2d" ? <ScaleCalibrationLayer calibration={calibration} /> : null}
      <RoomLayer
        draft={roomDraft}
        drawMode={drawMode}
        furnishedRooms={furnishedRooms}
        rooms={rooms}
        selectedRoomId={selectedRoomId}
        selectable={selectable}
        showTransitionAreas={showTransitionAreas}
        entrancePoints={datasetEntrances.map((e) => e.point)}
        onSelectRoom={onSelectRoom}
      />
      {showWalls ? <DatasetWallLayer walls={datasetWalls} /> : null}
      {showWalls ? <GeneratedWallLayer walls={generatedWalls} /> : null}
      <ApartmentShellLayer shell={apartmentShell} showOutline={!generatedWalls.length} />
      <EntranceLayer entrances={datasetEntrances} />
      {selectedRoom && selectable ? (
        <EdgeEditor room={selectedRoom} svgRef={svgRef} onUpdate={onUpdateRoom} onMoveRoom={onMoveRoom} layer="body" />
      ) : null}
      {(() => {
        const furnitureHandlesEl = (
          <FurnitureHandles
            rooms={rooms}
            furnishedRooms={furnishedRooms}
            selectedKey={selectedFurnitureKey}
            selectedRoomId={selectedRoomId}
            isFurnishMode={selectedTool === "furnish"}
            svgRef={svgRef}
            onSelect={onSelectFurniture}
            onDrop={onFurnitureDrop}
            failedCandidates={failedCandidates}
            showFailedCandidates={showFailedCandidates}
            selectedCandidateKey={selectedCandidateKey}
            onSelectCandidate={onSelectCandidate}
            onCandidateDrop={onCandidateDrop}
          />
        );
        const roomHandlesEl = selectedRoom && selectable ? (
          <EdgeEditor room={selectedRoom} svgRef={svgRef} onUpdate={onUpdateRoom} onMoveRoom={onMoveRoom} layer="handles" />
        ) : null;
        // Whichever selection is active wins the top layer (its drag points take
        // priority): a selected furniture piece's handle beats the room's
        // vertex/edge handles; with only a room selected, the room handles win.
        const furnitureSelected = selectedFurnitureKey != null;
        return furnitureSelected
          ? <>{roomHandlesEl}{furnitureHandlesEl}</>
          : <>{furnitureHandlesEl}{roomHandlesEl}</>;
      })()}
      {showTransitionAreas && (
        <g className="transition-areas-overlay" style={{ pointerEvents: "none" }}>
          {furnishedRooms.flatMap((rr) =>
            rr.steps.flatMap((step, si) =>
              step.selected ? [
                <path
                  key={`ta-${rr.roomId}-${si}`}
                  d={pointsToPath(
                    (step.selected.placed.transformedBbox as unknown as [number, number][]).map(([x, y]) => ({ x, y })),
                    true,
                  )}
                  className="transition-area-bbox"
                />,
              ] : [],
            ),
          )}
        </g>
      )}
      <ScaleBarOverlay transform={transform} />
    </svg>
  );
}

// ─── Variant control panel ────────────────────────────────────────────────────

function VariantStepRow({
  step,
  onChange,
}: {
  step: StepOptions;
  onChange: (newIndex: number) => void;
}) {
  const { furnitureName, allOptions, selectedIndex, selected } = step;

  if (selectedIndex === MANUAL_IDX && selected !== null) {
    return (
      <div className="variant-step-block">
        <div className="variant-step-row">
          <span className="variant-step-name">{furnitureName}</span>
          <span className="variant-step-empty">placed</span>
        </div>
      </div>
    );
  }

  if (allOptions.length === 0) {
    return (
      <div className="variant-step-block">
        <div className="variant-step-row">
          <span className="variant-step-name">{furnitureName}</span>
          <span className="variant-step-empty">no placement</span>
        </div>
      </div>
    );
  }

  // Group flat indices by variantIndex
  const variantMap = new Map<number, number[]>();
  for (let i = 0; i < allOptions.length; i++) {
    const vi = allOptions[i].variantIndex;
    if (!variantMap.has(vi)) variantMap.set(vi, []);
    variantMap.get(vi)!.push(i);
  }
  const variantKeys = Array.from(variantMap.keys()).sort((a, b) => a - b);

  const currentVariant = selected?.variantIndex ?? variantKeys[0];
  const currentFlatIndices = variantMap.get(currentVariant) ?? [];
  const posInVariant = currentFlatIndices.indexOf(selectedIndex);

  return (
    <div className="variant-step-block">
      <div className="variant-step-row">
        <span className="variant-step-name">{furnitureName}</span>
        {variantKeys.length > 1 && (
          <div className="variant-pills">
            {variantKeys.map((vi) => {
              const count = variantMap.get(vi)?.length ?? 0;
              return (
                <button
                  key={vi}
                  className={`variant-pill${vi === currentVariant ? " active" : ""}`}
                  onClick={() => {
                    const indices = variantMap.get(vi);
                    if (indices?.length) onChange(indices[0]);
                  }}
                >
                  V{vi + 1}: {count}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="variant-step-row variant-pos-row">
        <button
          className="variant-nav-btn"
          disabled={posInVariant <= 0}
          onClick={() => onChange(currentFlatIndices[posInVariant - 1])}
        >
          ‹
        </button>
        <span className="variant-counter">
          pos {posInVariant + 1}/{currentFlatIndices.length}
        </span>
        <button
          className="variant-nav-btn"
          disabled={posInVariant >= currentFlatIndices.length - 1}
          onClick={() => onChange(currentFlatIndices[posInVariant + 1])}
        >
          ›
        </button>
        {currentFlatIndices.length <= 14 && (
          <div className="variant-dots">
            {currentFlatIndices.map((flatIdx) => (
              <button
                key={flatIdx}
                className={`variant-dot${flatIdx === selectedIndex ? " active" : ""}`}
                onClick={() => onChange(flatIdx)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function VariantControlPanel({
  roomResult,
  onStepChange,
}: {
  roomResult: FurnishedRoomResult;
  onStepChange: (stepIndex: number, newIndex: number) => void;
}) {
  if (roomResult.steps.length === 0) return null;
  const { score } = scoreRoom(roomResult.roomName, { steps: roomResult.steps, warnings: roomResult.warnings });
  const scoreColor = score >= 80 ? "var(--st-olive)" : score >= 50 ? "var(--accent)" : "var(--accent-deep)";
  return (
    <div className="variant-panel" onClick={(e) => e.stopPropagation()}>
      <div className="variant-panel-header">
        <span>{roomResult.roomName}</span>
        <span className="variant-score" style={{ color: scoreColor }}>{score.toFixed(0)}</span>
      </div>
      {roomResult.steps.map((step, i) => (
        <VariantStepRow key={i} step={step} onChange={(idx) => onStepChange(i, idx)} />
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

const initialTransform: ViewerTransform = { metresAcross: 16, centerX: 0, centerY: 0 };

export default function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLElement>(null);
  const [viewMode, setViewMode] = useState<"trace" | "explore">("trace");
  const [selectedTool, setSelectedTool] = useState<ToolId>("upload");
  const [lastRoomTool, setLastRoomTool] = useState<RoomToolId>("Bedroom");
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const [transform, setTransform] = useState<ViewerTransform>(initialTransform);
  const [backgroundImages, setBackgroundImages] = useState<BackgroundImage[]>([]);
  const [scaleCalibration, setScaleCalibration] = useState<ScaleCalibration>({
    p1: null,
    p2: null,
    cursor: null,
  });
  const [rooms, setRooms] = useState<DrawnRoom[]>([]);
  const [roomDraft, setRoomDraft] = useState<RoomDraft | null>(null);
  const [drawMode, setDrawMode] = useState<"rectangle" | "lines">("rectangle");
  const [orthoMode, setOrthoMode] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [gridStep, setGridStep] = useState(DEFAULT_GRID_STEP);
  const [furnishedRooms, setFurnishedRooms] = useState<FurnishedRoomResult[]>([]);
  const [furnishError, setFurnishError] = useState<string | null>(null);
  // Feature B: once the user has furnished once, layout edits auto-re-furnish.
  const [hasFurnishedOnce, setHasFurnishedOnce] = useState(false);
  // Signature of the layout last furnished — guards the auto-furnish effect
  // against redundant runs right after a manual/dataset furnish.
  const lastFurnishedSignatureRef = useRef<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [pipelineConfig, setPipelineConfig] = useState<PipelineConfig>({
    aptTypeOverride: null,
    roomOverrides: {},
  });
  const [selectedFurnitureKey, setSelectedFurnitureKey] = useState<FurnitureKey | null>(null);
  // Failed / unplaced candidates — pure session UI state (see the rebuild effect
  // and handlers below). Declared here so the keydown effect can depend on the
  // selected candidate without a temporal-dead-zone reference.
  const [showFailedCandidates, setShowFailedCandidates] = useState(false);
  const [failedCandidates, setFailedCandidates] = useState<FailedCandidate[]>([]);
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<FurnitureKey | null>(null);
  // Non-furnishable areas (corridors, …) from a loaded dataset apartment — display-only.
  const [datasetContext, setDatasetContext] = useState<DatasetContextArea[]>([]);
  // Wall thickness polygons from a loaded dataset apartment — display-only. Shown by default.
  const [datasetWalls, setDatasetWalls] = useState<Point2D[][]>([]);
  const [datasetEntrances, setDatasetEntrances] = useState<EntranceDoor[]>([]);
  const [apartmentShell, setApartmentShell] = useState<ApartmentShell | null>(null);
  const [wallSettings, setWallSettings] = useState<WallSettings>(DEFAULT_WALL_SETTINGS);
  const [showWalls, setShowWalls] = useState(true);

  // Non-passive wheel listener so preventDefault actually works and prevents browser zoom
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const zoomFactor = event.deltaY > 0 ? 1.12 : 0.88;
      setTransform((current) => ({
        ...current,
        metresAcross: Math.min(90, Math.max(8, current.metresAcross * zoomFactor)),
      }));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── Generated walls ─────────────────────────────────────────────────────────
  // Walls built from the traced geometry: the uploaded apartment contour gives
  // the outer walls, the room polygons give the inner partitions. Door and
  // window openings are cut out so each is a real gap with jamb ends. Dataset
  // apartments ship their own wall polygons, so nothing is generated for them.
  const generatedWalls = useMemo<WallPolygon[]>(() => {
    if (datasetWalls.length) return [];
    const { outer, inner } = wallSettings;
    const axes: WallAxis[] = [];

    if (apartmentShell && outer.enabled) {
      axes.push({ polygon: apartmentShell.outline, thickness: outer.thickness, offset: outer.offset });
    }
    if (inner.enabled) {
      // Partitions are clipped to the space the outer wall leaves clear, so a
      // room traced right up to the contour doesn't thicken the outer wall.
      const clip = apartmentShell
        ? outer.enabled
          ? wallInnerFace(apartmentShell.outline, outer.thickness, outer.offset)
          : apartmentShell.outline
        : undefined;
      for (const room of rooms) {
        axes.push({ polygon: room.points, thickness: inner.thickness, offset: inner.offset, clip });
      }
    }
    if (!axes.length) return [];

    // The cutter must cross the thickest wall it may hit, whatever it is set to.
    const halfDepth = Math.max(0.3, Math.max(outer.thickness, inner.thickness) * 1.5);
    const cutters: Array<[number, number][]> = [];
    if (apartmentShell) {
      for (const o of [...apartmentShell.doors, ...apartmentShell.windows]) {
        const c = buildOpeningCutterAligned(o.point, o.width, o.wallDir, halfDepth);
        if (c) cutters.push(c);
      }
    }
    if (inner.enabled) {
      for (const room of rooms) {
        for (const door of room.doors) {
          const c = buildDoorCutter(room, door, halfDepth);
          if (c) cutters.push(c);
        }
        room.windows.forEach((win, i) => {
          const c = buildWindowCutter(room, win, room.windowWidths?.[i] ?? windowWidth(room.type), halfDepth);
          if (c) cutters.push(c);
        });
      }
    }

    return buildWalls(axes, cutters);
  }, [apartmentShell, rooms, wallSettings, datasetWalls]);

  // Feature B: auto-furnish on layout changes after the first manual furnish.
  // The signature captures only layout inputs (rooms + pipelineConfig), never
  // furnishedRooms, so furnishing can't re-trigger this effect → no loop.
  const layoutSignature = useMemo(
    () => computeLayoutSignature(rooms, pipelineConfig),
    [rooms, pipelineConfig],
  );

  useEffect(() => {
    if (!hasFurnishedOnce || rooms.length === 0) return;
    // Already furnished exactly this layout (e.g. just after a manual furnish).
    if (layoutSignature === lastFurnishedSignatureRef.current) return;
    // Debounce so dragging a vertex/room (many updates) furnishes once, at rest.
    const handle = window.setTimeout(() => {
      try {
        const deduped = dedupeRooms(rooms);
        doFurnish(deduped, pipelineConfig);
        lastFurnishedSignatureRef.current = layoutSignature;
        setFurnishError(null);
      } catch (error) {
        setFurnishError(error instanceof Error ? error.message : "Furniture placement failed.");
      }
    }, 350);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature, hasFurnishedOnce]);

  function resetScaleCalibration() {
    setScaleCalibration({ p1: null, p2: null, cursor: null });
  }

  function resetRoomDraft() {
    setRoomDraft(null);
  }

  function handleSelectTool(tool: ToolId) {
    if (isRoomTool(tool) && tool === selectedTool) {
      resetRoomDraft();
      setSelectedTool("upload");
      return;
    }
    if ((tool === "doors" || tool === "windows") && tool === selectedTool) {
      setSelectedTool("upload");
      return;
    }
    resetScaleCalibration();
    if (!isRoomTool(tool)) resetRoomDraft();
    if (isRoomTool(tool)) setLastRoomTool(tool);
    // Leave room selected when entering door mode; deselect when drawing rooms
    if (isRoomTool(tool)) setSelectedRoomId(null);
    setSelectedTool(tool);
  }

  function handleReset() {
    resetScaleCalibration();
    resetRoomDraft();
    setRooms([]);
    setFurnishedRooms([]);
    setFurnishError(null);
    setSelectedRoomId(null);
    setDatasetContext([]);
    setDatasetWalls([]);
    setDatasetEntrances([]);
    setApartmentShell(null);
    setSelectedTool("upload");
  }

  function updateBackgroundImage(id: string, patch: Partial<BackgroundImage>) {
    setBackgroundImages((imgs) => imgs.map((img) => (img.id === id ? { ...img, ...patch } : img)));
  }

  function moveBackgroundImage(id: string, dx: number, dy: number) {
    setBackgroundImages((imgs) =>
      imgs.map((img) => (img.id === id ? { ...img, x: img.x + dx, y: img.y + dy } : img)),
    );
  }

  function selectBackgroundImage(id: string) {
    setBackgroundImages((imgs) => imgs.map((img) => ({ ...img, selected: img.id === id })));
  }

  function deselectAllImages() {
    setBackgroundImages((imgs) => imgs.map((img) => ({ ...img, selected: false })));
  }

  function deleteBackgroundImage(id: string) {
    setBackgroundImages((imgs) => imgs.filter((img) => img.id !== id));
    if (selectedTool === "scale2d") setSelectedTool("upload");
    resetScaleCalibration();
  }

  function applyScaleFromCalibration(id: string, anchor: Point2D, factor: number) {
    setBackgroundImages((imgs) =>
      imgs.map((img) => {
        if (img.id !== id) return img;
        const nextScale = Math.min(8, Math.max(0.05, img.scale * factor));
        const actual = nextScale / img.scale;
        return {
          ...img,
          x: anchor.x - (anchor.x - img.x) * actual,
          y: anchor.y - (anchor.y - img.y) * actual,
          scale: nextScale,
        };
      }),
    );
  }

  function handleScaleCalibrationClick(point: Point2D) {
    const selectedImg = backgroundImages.find((b) => b.selected);
    if (!selectedImg) return;
    if (!scaleCalibration.p1) {
      setScaleCalibration({ p1: point, p2: null, cursor: point });
      return;
    }
    if (!scaleCalibration.p2) {
      setScaleCalibration({ ...scaleCalibration, p2: point, cursor: point });
      return;
    }
    const refDist = distance(scaleCalibration.p1, scaleCalibration.p2);
    const targetDist = distance(scaleCalibration.p1, point);
    if (refDist > 0.001 && targetDist > 0.001) {
      applyScaleFromCalibration(selectedImg.id, scaleCalibration.p1, targetDist / refDist);
    }
    resetScaleCalibration();
  }

  function applyOrthogonalConstraint(rawPoint: Point2D, draft: RoomDraft | null): Point2D {
    if (!(isShiftHeld || orthoMode) || !draft || draft.points.length === 0) return rawPoint;
    return constrainToOrthogonal(rawPoint, draft.points[draft.points.length - 1]);
  }

  /** Grid snap for tracing input. Applied before the orthogonal constraint —
   *  that constraint only copies coordinates between two snapped points, so the
   *  result stays on the grid. */
  function applyGridSnap(point: Point2D): Point2D {
    if (!snapToGrid) return point;
    return snapPointToGrid(point, gridStep);
  }

  function handleRoomToolClick(rawInput: Point2D) {
    if (!isRoomTool(selectedTool)) return;
    const tool = ROOM_TOOLS.find((t) => t.id === selectedTool);
    if (!tool) return;
    const rawPoint = applyGridSnap(rawInput);

    if (drawMode === "rectangle") {
      if (!roomDraft || roomDraft.type !== selectedTool) {
        setRoomDraft({ type: selectedTool, points: [rawPoint], cursor: rawPoint, color: tool.color, orthogonal: false });
        return;
      }
      // Second click — complete rectangle from first point + current constrained cursor
      const a = roomDraft.points[0];
      const b = roomDraft.cursor ?? rawPoint;
      if (Math.abs(b.x - a.x) < 0.05 || Math.abs(b.y - a.y) < 0.05) return; // too small to be a room
      setRooms((existing) => [
        ...existing,
        {
          id: crypto.randomUUID(),
          type: roomDraft.type,
          points: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }],
          color: roomDraft.color,
          doors: [],
          windows: [],
        },
      ]);
      setRoomDraft(null);
      return;
    }

    // Lines mode
    if (!roomDraft || roomDraft.type !== selectedTool) {
      setRoomDraft({ type: selectedTool, points: [rawPoint], cursor: rawPoint, color: tool.color, orthogonal: false });
      return;
    }

    const point = applyOrthogonalConstraint(rawPoint, roomDraft);
    const firstPoint = roomDraft.points[0];
    const canClose = roomDraft.points.length >= 3 && distance(firstPoint, point) <= 0.35;

    if (canClose) {
      setRooms((existing) => [
        ...existing,
        { id: crypto.randomUUID(), type: roomDraft.type, points: roomDraft.points, color: roomDraft.color, doors: [], windows: [] },
      ]);
      setRoomDraft(null);
      return;
    }

    setRoomDraft({ ...roomDraft, points: [...roomDraft.points, point], cursor: point, orthogonal: false });
  }

  function handleRoomPointerMove(rawInput: Point2D) {
    const rawPoint = applyGridSnap(rawInput);
    setRoomDraft((current) => {
      if (!current) return current;
      const isOrtho = isShiftHeld || orthoMode;

      if (drawMode === "rectangle" && current.points.length === 1) {
        // Rectangle is always orthogonal by definition — cursor moves freely
        return { ...current, cursor: rawPoint, orthogonal: false };
      }

      // Lines mode
      const constrained = isOrtho && current.points.length > 0
        ? constrainToOrthogonal(rawPoint, current.points[current.points.length - 1])
        : rawPoint;
      return { ...current, cursor: constrained, orthogonal: isOrtho && current.points.length > 0 };
    });
  }

  function handleSetDrawMode(mode: "rectangle" | "lines") {
    setDrawMode(mode);
    setRoomDraft(null);
  }

  function handleToggleOrtho() {
    setOrthoMode((v) => !v);
  }

  function handleDownloadTemplate() {
    if (rooms.length === 0) return;
    downloadTemplateJson(dedupeRooms(rooms));
  }

  function handleToggleSnapToGrid() {
    setSnapToGrid((v) => !v);
  }

  function handleSetGridStep(step: number) {
    if (!Number.isFinite(step)) return;
    setGridStep(Math.min(MAX_GRID_STEP, Math.max(MIN_GRID_STEP, step)));
  }

  function handleDoorClick(point: Point2D) {
    // Delete door if clicking near an existing center point
    for (const room of rooms) {
      const idx = room.doors.findIndex((d) => distance(d, point) < 0.18);
      if (idx !== -1) {
        setRooms((current) =>
          current.map((r) =>
            r.id === room.id ? { ...r, doors: r.doors.filter((_, i) => i !== idx) } : r,
          ),
        );
        return;
      }
    }

    const nearest = nearestRoomEdge(point, rooms);
    if (!nearest || nearest.distance > 0.75) return;
    setRooms((current) =>
      current.map((room) =>
        room.id === nearest.roomId ? { ...room, doors: [...room.doors, nearest.point] } : room,
      ),
    );
  }

  function handleWindowClick(point: Point2D) {
    // Delete window if clicking near an existing center
    for (const room of rooms) {
      const idx = room.windows.findIndex((w) => distance(w, point) < 0.18);
      if (idx !== -1) {
        setRooms((current) =>
          current.map((r) =>
            r.id === room.id ? { ...r, windows: r.windows.filter((_, i) => i !== idx) } : r,
          ),
        );
        return;
      }
    }
    const nearest = nearestRoomEdge(point, rooms);
    if (!nearest || nearest.distance > 0.75) return;
    setRooms((current) =>
      current.map((room) =>
        room.id === nearest.roomId ? { ...room, windows: [...room.windows, nearest.point] } : room,
      ),
    );
  }

  function handleUpdateRoom(roomId: string, newPoints: Point2D[]) {
    setRooms((current) =>
      current.map((room) => (room.id === roomId ? { ...room, points: newPoints } : room)),
    );
    // Invalidate furniture when polygon changes
    setFurnishedRooms((current) => current.filter((r) => r.roomId !== roomId));
  }

  // Feature C: translate the whole room (points + doors + windows). Only updates
  // room state (so the layout signature changes) — it never furnishes directly;
  // Feature B's debounced effect re-furnishes once the drag settles.
  function handleMoveRoom(roomId: string, newPoints: Point2D[], newDoors: Point2D[], newWindows: Point2D[]) {
    // A room-body drag is a pure translation. Shift the room's existing
    // placement by the same delta so the furniture is preserved and follows the
    // room — no re-furnish. The delta is measured against the room's current
    // first vertex (same render as the furniture we translate, so consistent).
    const moved = rooms.find((r) => r.id === roomId);
    const base = moved?.points[0];
    const dx = base && newPoints[0] ? newPoints[0].x - base.x : 0;
    const dy = base && newPoints[0] ? newPoints[0].y - base.y : 0;
    setRooms((current) =>
      current.map((room) =>
        room.id === roomId ? { ...room, points: newPoints, doors: newDoors, windows: newWindows } : room,
      ),
    );
    setFurnishedRooms((current) =>
      current.map((r) => (r.roomId === roomId ? translateFurnishedRoom(r, dx, dy) : r)),
    );
  }

  // Greedy best-first: for each step in sequence, try every available option
  // and commit to the one that gives the highest room score for the full pipeline.
  // Complexity: O(steps × options) pipeline runs — fast in practice for typical rooms.
  function findBestInitialResult(
    room: EngineRoom,
    aptType: number,
    opts: { pipeline?: Pipeline; library?: FurnitureLibrary },
  ) {
    const initial = runRoomPipelineAt(room, aptType, [], opts);
    const stepCount = initial.steps.length;
    if (stepCount === 0) return initial;

    const chosen: number[] = [];

    for (let s = 0; s < stepCount; s++) {
      const current = runRoomPipelineAt(room, aptType, chosen, opts);
      const optCount = current.steps[s]?.allOptions.length ?? 0;

      if (optCount <= 1) { chosen.push(0); continue; }

      let bestScore = -1;
      let bestIdx   = 0;
      for (let opt = 0; opt < optCount; opt++) {
        const { score } = scoreRoom(
          room.name,
          runRoomPipelineAt(room, aptType, [...chosen, opt], opts),
        );
        if (score > bestScore) { bestScore = score; bestIdx = opt; }
      }
      chosen.push(bestIdx);
    }

    return runRoomPipelineAt(room, aptType, chosen, opts);
  }

  function doFurnish(roomsToUse: DrawnRoom[], config: PipelineConfig) {
    const uniqueRooms = dedupeRooms(roomsToUse);
    const aptType = config.aptTypeOverride ?? inferApartmentType(uniqueRooms);
    const customPipeline = buildCustomPipeline(config);
    const customLibrary = buildCustomLibrary(config, aptType);
    const engineRooms = toEngineRooms(uniqueRooms);

    const results: FurnishedRoomResult[] = [];
    for (const { roomId, room } of engineRooms) {
      try {
        const result = findBestInitialResult(room, aptType, { pipeline: customPipeline, library: customLibrary });
        results.push({ roomId, roomName: room.name, steps: result.steps, warnings: Array.from(new Set(result.warnings)) });
      } catch (error) {
        results.push({ roomId, roomName: room.name, steps: [], warnings: [error instanceof Error ? error.message : "Furniture placement failed."] });
      }
    }
    setFurnishedRooms(results);
    setHasFurnishedOnce(true);
  }

  function handleFurnishClick() {
    resetScaleCalibration();
    resetRoomDraft();
    setSelectedTool("furnish");
    setSelectedRoomId(null);
    setFurnishError(null);
    setSelectedFurnitureKey(null);

    if (!rooms.length) {
      setFurnishedRooms([]);
      setFurnishError("Draw at least one room before furnishing.");
      return;
    }
    if (rooms.every((r) => isCirculationRoom(r.type))) {
      setFurnishedRooms([]);
      setFurnishError("Halls and corridors are not furnished — draw at least one other room.");
      return;
    }

    const deduped = dedupeRooms(rooms);
    if (rooms.length !== deduped.length) setRooms(deduped);
    doFurnish(deduped, pipelineConfig);
    // Prime the guard so the auto-furnish effect doesn't immediately re-run for
    // the layout we just furnished.
    lastFurnishedSignatureRef.current = computeLayoutSignature(deduped, pipelineConfig);
  }

  function handleSetAptType(type: number | null) {
    setPipelineConfig((c) => ({ ...c, aptTypeOverride: type }));
  }

  function handleUpdateRoomSteps(section: string, steps: PipelineStepConfig[]) {
    setPipelineConfig((c) => ({
      ...c,
      roomOverrides: { ...c.roomOverrides, [section]: steps },
    }));
  }

  function handleVariantChange(roomId: string, stepIndex: number, newOptionIndex: number) {
    const roomResult = furnishedRooms.find((r) => r.roomId === roomId);
    if (!roomResult) return;

    const currentIndices = roomResult.steps.map((s) => Math.max(0, s.selectedIndex));
    const newIndices = [...currentIndices];
    newIndices[stepIndex] = newOptionIndex;
    for (let i = stepIndex + 1; i < newIndices.length; i++) newIndices[i] = 0;

    const aptType = pipelineConfig.aptTypeOverride ?? inferApartmentType(rooms);
    const engineRoomEntry = toEngineRooms(rooms).find((r) => r.roomId === roomId);
    if (!engineRoomEntry) return;

    const customPipeline = buildCustomPipeline(pipelineConfig);
    const customLibrary = buildCustomLibrary(pipelineConfig, aptType);

    try {
      const result = runRoomPipelineAt(engineRoomEntry.room, aptType, newIndices, {
        pipeline: customPipeline,
        library: customLibrary,
      });
      setFurnishedRooms((prev) =>
        prev.map((r) =>
          r.roomId === roomId
            ? { ...r, steps: result.steps, warnings: Array.from(new Set(result.warnings)) }
            : r,
        ),
      );
    } catch {
      // keep previous result on error
    }
  }


  function handleFurnitureDrop(
    roomId: string,
    stepIdx: number,
    snapPt: Point2D,
    wallA: Point2D,
    wallB: Point2D,
    inward: Point2D,
  ) {
    const rr = furnishedRooms.find((r) => r.roomId === roomId);
    if (!rr) return;
    const step = rr.steps[stepIdx];
    if (!step?.selected) return;

    const aptType = pipelineConfig.aptTypeOverride ?? inferApartmentType(rooms);
    const customLibrary = buildCustomLibrary(pipelineConfig, aptType);
    const customPipeline = buildCustomPipeline(pipelineConfig);
    const category = roomNameToFurnitureCategory(rr.roomName as RoomName);
    const section = rr.roomName.startsWith("Children") ? "Children" : rr.roomName;

    const entry = findFurnitureByName(customLibrary, aptType, category, step.furnitureName);
    if (!entry?.pieces[0]) return;
    const variant = entry.pieces[0].variants[step.selected.variantIndex];
    if (!variant) return;

    const lp = variant.linePlacement.points as [number, number][];
    const cornerSrcPt: [number, number] = [(lp[0][0] + lp[1][0]) / 2, (lp[0][1] + lp[1][1]) / 2];
    const newPlaced = placeVariantAtCorner(
      variant,
      [wallA.x, wallA.y], [wallB.x, wallB.y], [inward.x, inward.y],
      cornerSrcPt, [snapPt.x, snapPt.y],
      step.furnitureName,
    );

    const engineRoomEntry = toEngineRooms(rooms).find((r) => r.roomId === roomId);
    if (!engineRoomEntry) return;
    const engineRoom = engineRoomEntry.room;

    // Rebuild polygon chains through all steps up to and including the dropped piece
    let roomFullChain = [...engineRoom.polygon];
    const doorRects = getDoorRectangles(engineRoom);
    let roomRdcChain = [...engineRoom.polygon];
    for (const rect of doorRects) roomRdcChain = subtractPolygon(roomRdcChain, rect);

    for (let i = 0; i < stepIdx; i++) {
      const s = rr.steps[i];
      if (s.selected) {
        roomFullChain = subtractPolygon(roomFullChain, s.selected.placed.smallCutout);
        roomRdcChain  = subtractPolygon(roomRdcChain,  s.selected.placed.largeCutout);
      }
    }
    roomFullChain = subtractPolygon(roomFullChain, newPlaced.smallCutout);
    roomRdcChain  = subtractPolygon(roomRdcChain,  newPlaced.largeCutout);

    const originalWalls: [[number,number],[number,number]][] = engineRoom.polygon.map((p, i) =>
      [p, engineRoom.polygon[(i + 1) % engineRoom.polygon.length]],
    );

    const pipelineSteps = customPipeline[section] ?? [];
    const newSteps: StepOptions[] = [];
    const newWarnings: string[] = [...rr.warnings];

    for (let i = 0; i < stepIdx; i++) newSteps.push(rr.steps[i]);
    newSteps.push({ furnitureName: step.furnitureName, allOptions: [], selectedIndex: MANUAL_IDX, selected: { variantIndex: step.selected.variantIndex, placed: newPlaced } });

    for (let i = stepIdx + 1; i < pipelineSteps.length; i++) {
      const alternatives = pipelineSteps[i];
      let entry2 = null;
      let resolvedName = "";
      for (const name of alternatives) {
        entry2 = findFurnitureByName(customLibrary, aptType, category, name);
        if (entry2) { resolvedName = name; break; }
      }
      if (!entry2) {
        newWarnings.push(`No library entry for [${alternatives.join(" | ")}] — skipped`);
        newSteps.push({ furnitureName: alternatives.join(" | "), allOptions: [], selectedIndex: -1, selected: null });
        continue;
      }
      const placementOpts: PlacementOptions = {
        referenceWalls:   resolvedName === "Dining" ? undefined : originalWalls,
        collisionPolygon: roomFullChain,
        edgePolygon:      roomRdcChain,
      };
      const allOpts = getAllPlacements(engineRoom, entry2, placementOpts);
      const sel = allOpts[0] ?? null;
      newSteps.push({ furnitureName: resolvedName, allOptions: allOpts, selectedIndex: sel ? 0 : -1, selected: sel ?? null });
      if (sel) {
        roomFullChain = subtractPolygon(roomFullChain, sel.placed.smallCutout);
        roomRdcChain  = subtractPolygon(roomRdcChain,  sel.placed.largeCutout);
      }
    }

    setFurnishedRooms((prev) => prev.map((r) => r.roomId === roomId ? { ...r, steps: newSteps, warnings: newWarnings } : r));
    setSelectedFurnitureKey(null);
  }

  // ── Dataset browser (Neufert bundle) ────────────────────────────────────────

  const datasetLoadSeq = useRef(0);

  function handleLoadDatasetApartment(record: NeufertRecord, opts?: { cohortActive?: boolean }) {
    // 1. Translate all coordinates so the bounding-box min corner sits at (1, 1)
    //    — the canvas prefers positive coordinates.
    const allCoords: [number, number][] = [
      ...record.rooms.flatMap((r) => [...r.polygon, ...(r.windows ?? [])]),
      ...(record.doors ?? []),
    ];
    if (!allCoords.length) return;
    let minX = Infinity;
    let minY = Infinity;
    for (const [x, y] of allCoords) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
    }
    const shiftX = 1 - minX;
    const shiftY = 1 - minY;
    const translate = ([x, y]: [number, number]): Point2D => ({ x: x + shiftX, y: y + shiftY });

    // 2. Convert to DrawnRoom[]. Global doors are attached to every room whose
    //    boundary is within ADJACENT_DOOR_THRESHOLD of the door point.
    const seq = ++datasetLoadSeq.current;
    const globalDoors = (record.doors ?? []).map(translate);
    const converted: DrawnRoom[] = [];
    for (const room of record.rooms) {
      const type = (room.name.startsWith("Children") ? "Children" : room.name) as RoomToolId;
      const tool = ROOM_TOOLS.find((t) => t.id === type);
      if (!tool || !Array.isArray(room.polygon) || room.polygon.length < 3) continue;
      const points = room.polygon.map(translate);
      converted.push({
        id: `nf-${seq}-${converted.length}`,
        type,
        points,
        color: tool.color,
        doors: globalDoors.filter((d) => distPointToPolygonBoundary(d, points) <= ADJACENT_DOOR_THRESHOLD),
        windows: (room.windows ?? []).map(translate),
        // Real per-window widths (unaffected by the translation offset). Same
        // index order as windows; absent on older bundles → symbol/opening fall
        // back to windowWidth(type).
        ...(Array.isArray(room.windowWidths) ? { windowWidths: room.windowWidths } : {}),
      });
    }
    if (!converted.length) return;

    // Display-only context areas (corridors, …), translated with the SAME
    // offset as the rooms. The offset itself is still computed from the
    // furnishable geometry only, so room placement is unchanged.
    const contextAreas: DatasetContextArea[] = (record.context ?? [])
      .filter((c) => Array.isArray(c?.polygon) && c.polygon.length >= 3)
      .map((c) => ({
        subtype: typeof c.subtype === "string" && c.subtype.length > 0 ? c.subtype : "context",
        points: c.polygon.map(translate),
      }));

    // Wall thickness polygons, translated with the SAME room-derived offset so
    // they align exactly with the rooms. Rings with < 3 points are dropped.
    const wallRings: Point2D[][] = (record.walls ?? [])
      .filter((ring) => Array.isArray(ring) && ring.length >= 3)
      .map((ring) => ring.map(translate));

    // Cut real door AND window openings out of the wall rings so each opening is a
    // clean gap with proper jamb ends (baked in at load — render is unchanged).
    // Windows use their real per-window width when the bundle provides it. Wrapped in a
    // try/catch so a bad apartment can never break loading; on any failure we fall
    // back to the uncut wall rings.
    // Apartment entrance door(s): translated with the same room-derived offset.
    // Also present in the door set (so the engine already accounts for them);
    // kept here for a distinct apartment-level glyph + wall opening. Orientation
    // is resolved once, against the clean architectural outlines (wall faces +
    // room + corridor polygons), so the swing sits ALONG its wall — not across a
    // wall end-cap — and the opening cutter uses the very same wall direction.
    const interior = apartmentInterior(converted);
    const orientBoundaries: Point2D[][] = [
      ...wallRings,
      ...converted.map((r) => r.points),
      ...contextAreas.map((c) => c.points),
    ];
    const entrances: EntranceDoor[] = (record.entrance ?? [])
      .filter((e) => Array.isArray(e?.point) && e.point.length === 2)
      .map((e) => {
        const raw = translate(e.point);
        const o = orientToNearestEdge(raw, orientBoundaries, interior);
        // Use the point snapped onto its wall so the swing + opening sit on the
        // wall (dataset entrance centroids can be offset into the corridor).
        return o
          ? { point: o.snap, width: e.width, wallDir: o.wallDir, inward: o.inward, wallA: o.wallA, wallB: o.wallB }
          : null;
      })
      .filter((e): e is EntranceDoor => e !== null);

    let gappedWalls = wallRings;
    try {
      gappedWalls = cutOpeningsInWalls(wallRings, converted, entrances);
    } catch {
      gappedWalls = wallRings;
    }

    // 3. Replace the drawing state (background images are left untouched).
    resetScaleCalibration();
    resetRoomDraft();
    setRooms(converted);
    setDatasetContext(contextAreas);
    setDatasetWalls(gappedWalls);
    setDatasetEntrances(entrances);
    setApartmentShell(null);
    setFurnishedRooms([]);
    setSelectedRoomId(null);
    setSelectedFurnitureKey(null);
    setFurnishError(null);
    const nextConfig: PipelineConfig = { ...pipelineConfig, roomOverrides: {} };
    setPipelineConfig(nextConfig);
    setSelectedTool("furnish");
    // When triaging a cohort from the Explore tab, surface the failing pieces
    // right away so it's clear WHY this apartment is in the group.
    if (opts?.cohortActive) setShowFailedCandidates(true);

    // 4. Fit the viewer: centre the apartment with ~10% margin on each side.
    //    The SVG viewBox is a square `metresAcross` wide centred on
    //    (centerX, centerY), so the max bbox dimension × 1.2 fits both axes.
    //    Context areas and walls are included so corridors and exterior walls
    //    aren't clipped offscreen.
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    const fitPointLists = [...converted.map((r) => r.points), ...contextAreas.map((c) => c.points), ...wallRings];
    for (const points of fitPointLists) {
      for (const p of points) {
        if (p.x < bMinX) bMinX = p.x;
        if (p.y < bMinY) bMinY = p.y;
        if (p.x > bMaxX) bMaxX = p.x;
        if (p.y > bMaxY) bMaxY = p.y;
      }
    }
    const span = Math.max(bMaxX - bMinX, bMaxY - bMinY);
    setTransform({
      metresAcross: Math.min(90, Math.max(8, span * 1.2)),
      centerX: (bMinX + bMaxX) / 2,
      centerY: (bMinY + bMaxY) / 2,
    });

    // 5. Auto-furnish with the freshly converted rooms (avoids stale closures).
    //    A furnishing failure must not break the load itself.
    try {
      doFurnish(converted, nextConfig);
      lastFurnishedSignatureRef.current = computeLayoutSignature(converted, nextConfig);
    } catch (error) {
      setFurnishedRooms([]);
      setFurnishError(error instanceof Error ? error.message : "Furniture placement failed.");
    }
  }

  // ── Apartment JSON (shell only — rooms are traced by hand afterwards) ───────

  /** Load an uploaded apartment shell: contour, entrance door and windows. The
   *  contour is display-only; the drawing state is cleared so the rooms can be
   *  traced inside it. Throws with a user-facing message on a bad document. */
  function handleLoadApartmentShell(text: string) {
    const parsed = parseApartmentJson(text);

    // Translate so the bounding-box min corner sits at (1, 1) — same convention
    // as the dataset loader, since the canvas prefers positive coordinates.
    let minX = Infinity, minY = Infinity;
    for (const p of parsed.outline) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
    }
    const shiftX = 1 - minX;
    const shiftY = 1 - minY;
    const translate = (p: Point2D): Point2D => ({ x: p.x + shiftX, y: p.y + shiftY });
    const outline = parsed.outline.map(translate);

    // Openings are snapped onto their nearest contour edge, so a midpoint that
    // is a few centimetres off the wall still reads as a clean opening.
    const interior = polygonCentroid(outline);
    const resolveOpening = (o: ApartmentOpening): EntranceDoor | null => {
      const or = orientToNearestEdge(translate(o.point), [outline], interior);
      if (!or) return null;
      // The centroid is only a hint (it can fall outside an L-shaped contour), so
      // the swing direction is confirmed against the contour itself.
      const inward = pointInPolygon(addPoint(or.snap, scalePoint(or.inward, 0.05)), outline)
        ? or.inward
        : scalePoint(or.inward, -1);
      return { point: or.snap, width: o.width, wallDir: or.wallDir, inward, wallA: or.wallA, wallB: or.wallB };
    };
    const entrances = parsed.doors.map(resolveOpening).filter((e): e is EntranceDoor => e !== null);
    const windows = parsed.windows.map(resolveOpening).filter((e): e is EntranceDoor => e !== null);

    resetScaleCalibration();
    resetRoomDraft();
    setRooms([]);
    setDatasetContext([]);
    setDatasetWalls([]);   // shell walls are generated from the Walls settings
    setDatasetEntrances(entrances);
    setApartmentShell({ outline, doors: entrances, windows });
    // A thickness stated in the file wins over the current outer-wall setting.
    if (parsed.wallThickness !== null) {
      const t = parsed.wallThickness;
      setWallSettings((s) => ({ ...s, outer: { ...s.outer, thickness: t } }));
    }
    setFurnishedRooms([]);
    setSelectedRoomId(null);
    setSelectedFurnitureKey(null);
    setFurnishError(null);
    setPipelineConfig((c) => ({ ...c, roomOverrides: {} }));
    // Straight into tracing — the next step is drawing rooms inside the contour.
    setSelectedTool(lastRoomTool);

    // Fit the viewer on the contour with ~10% margin (plus a wall's worth).
    const margin = parsed.wallThickness ?? wallSettings.outer.thickness;
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    for (const points of [outline]) {
      for (const p of points) {
        if (p.x < bMinX) bMinX = p.x;
        if (p.y < bMinY) bMinY = p.y;
        if (p.x > bMaxX) bMaxX = p.x;
        if (p.y > bMaxY) bMaxY = p.y;
      }
    }
    const span = Math.max(bMaxX - bMinX, bMaxY - bMinY) + 2 * margin;
    setTransform({
      metresAcross: Math.min(90, Math.max(8, span * 1.2)),
      centerX: (bMinX + bMaxX) / 2,
      centerY: (bMinY + bMaxY) / 2,
    });
  }

  function handleJsonUploadClick() {
    jsonInputRef.current?.click();
  }

  function handleJsonFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      try {
        handleLoadApartmentShell(String(reader.result));
      } catch (error) {
        setFurnishError(error instanceof Error ? error.message : "Apartment JSON: could not read the file.");
      }
    });
    reader.addEventListener("error", () => setFurnishError("Apartment JSON: could not read the file."));
    reader.readAsText(file);
  }

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleImageFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((f) =>
      ["image/png", "image/jpeg"].includes(f.type),
    );
    event.target.value = "";
    for (const file of files) {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const src = String(reader.result);
        const probe = new Image();
        probe.addEventListener("load", () => {
          const baseWidth = 12;
          const ratio = probe.naturalHeight && probe.naturalWidth ? probe.naturalHeight / probe.naturalWidth : 0.7;
          const newImg: BackgroundImage = {
            id: crypto.randomUUID(),
            src,
            name: file.name,
            width: baseWidth,
            height: baseWidth * ratio,
            x: 0,
            y: 0,
            scale: 1,
            rotation: 0,
            opacity: 0.85,
            selected: true,
          };
          setBackgroundImages((imgs) => [...imgs.map((i) => ({ ...i, selected: false })), newImg]);
        });
        probe.src = src;
      });
      reader.readAsDataURL(file);
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Shift") setIsShiftHeld(true);
      if (event.key === "Escape") {
        resetScaleCalibration();
        resetRoomDraft();
        setSelectedRoomId(null);
        if (selectedTool !== "upload" && selectedTool !== "furnish") setSelectedTool("upload");
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedCandidateKey) {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        handleDeleteCandidate(selectedCandidateKey);
        return;
      }
      if (event.key === "Delete" && selectedRoomId) {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
        setRooms((current) => current.filter((r) => r.id !== selectedRoomId));
        setFurnishedRooms((current) => current.filter((r) => r.roomId !== selectedRoomId));
        setSelectedRoomId(null);
      }
    }
    function handleKeyUp(event: KeyboardEvent) {
      if (event.key === "Shift") setIsShiftHeld(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTool, selectedRoomId, selectedCandidateKey]);

  const [showTransitionAreas, setShowTransitionAreas] = useState(false);

  // ── Failed / unplaced candidates ────────────────────────────────────────────
  // Rebuild the candidate set whenever the furnish result (or layout it depends
  // on) changes. Candidates are pure UI state and are deliberately NOT part of
  // the layout signature, so building / dragging / deleting them can never
  // re-trigger the auto-furnish effect (this effect only *reads* furnish output).
  useEffect(() => {
    const aptType = pipelineConfig.aptTypeOverride ?? inferApartmentType(rooms);
    const customLibrary = buildCustomLibrary(pipelineConfig, aptType);
    const next: FailedCandidate[] = [];
    for (const rr of furnishedRooms) {
      const room = rooms.find((r) => r.id === rr.roomId);
      if (!room || room.points.length < 3) continue;
      const wall = longestWallOf(room.points);
      if (!wall) continue;
      const category = roomNameToFurnitureCategory(rr.roomName as RoomName);
      rr.steps.forEach((step, si) => {
        // Unplaced iff the engine committed no placement for this step.
        if (step.selected !== null) return;
        // Only pieces that resolve to a real library entry have geometry to
        // draw; steps with a joined "A | B" name (no entry at all) are skipped.
        const entry = findFurnitureByName(customLibrary, aptType, category, step.furnitureName);
        const variant = entry?.pieces[0]?.variants[0];
        if (!variant) return;
        next.push({
          roomId: rr.roomId,
          stepIndex: si,
          furnitureName: step.furnitureName,
          variantIndex: 0,
          placed: placeCandidateAgainstWall(variant, wall, step.furnitureName),
        });
      });
    }
    setFailedCandidates(next);
    setSelectedCandidateKey(null);
  }, [furnishedRooms, rooms, pipelineConfig]);

  // Reposition a dragged candidate — reuses placeVariantAtCorner exactly like
  // the manual furniture-drop flow (handleFurnitureDrop), but only updates the
  // candidate's own footprint; it never runs the pipeline or touches placed
  // furniture. Overlap with existing furniture is allowed by design.
  function handleCandidateDrop(
    key: FurnitureKey,
    snapPt: Point2D,
    wallA: Point2D,
    wallB: Point2D,
    inward: Point2D,
  ) {
    const rr = furnishedRooms.find((r) => r.roomId === key.roomId);
    if (!rr) return;
    const aptType = pipelineConfig.aptTypeOverride ?? inferApartmentType(rooms);
    const customLibrary = buildCustomLibrary(pipelineConfig, aptType);
    const category = roomNameToFurnitureCategory(rr.roomName as RoomName);

    setFailedCandidates((prev) =>
      prev.map((c) => {
        if (c.roomId !== key.roomId || c.stepIndex !== key.stepIndex) return c;
        const entry = findFurnitureByName(customLibrary, aptType, category, c.furnitureName);
        const variant = entry?.pieces[0]?.variants[c.variantIndex];
        if (!variant) return c;
        const lp = variant.linePlacement.points as unknown as [number, number][];
        const cornerSrcPt: [number, number] = [(lp[0][0] + lp[1][0]) / 2, (lp[0][1] + lp[1][1]) / 2];
        const newPlaced = placeVariantAtCorner(
          variant,
          [wallA.x, wallA.y], [wallB.x, wallB.y], [inward.x, inward.y],
          cornerSrcPt, [snapPt.x, snapPt.y],
          c.furnitureName,
        );
        return { ...c, placed: newPlaced };
      }),
    );
  }

  // Delete a candidate from the session (UI state only — no pipeline change).
  function handleDeleteCandidate(key: FurnitureKey) {
    setFailedCandidates((prev) =>
      prev.filter((c) => !(c.roomId === key.roomId && c.stepIndex === key.stepIndex)),
    );
    setSelectedCandidateKey(null);
  }

  const isFurnished = furnishedRooms.length > 0;
  const computedAptType = pipelineConfig.aptTypeOverride ?? inferApartmentType(rooms);

  // Shared canvas-view toggles, reused by both tabs (Trace furnish card +
  // Explore panel).
  const affords = {
    showTransitionAreas,
    onToggleTransitionAreas: () => setShowTransitionAreas((v) => !v),
    showFailedCandidates,
    onToggleFailedCandidates: () => setShowFailedCandidates((v) => !v),
    showWalls,
    onToggleWalls: () => setShowWalls((v) => !v),
  };

  return (
    <div className="app-root">
      <AppHeader />
      <main className="app-shell">
      <div className="rail">
        <div className="view-tabs">
          <button
            type="button"
            className={`view-tab-btn${viewMode === "trace" ? " active" : ""}`}
            onClick={() => setViewMode("trace")}
          >
            Trace &amp; Furnish
          </button>
          <button
            type="button"
            className={`view-tab-btn${viewMode === "explore" ? " active" : ""}`}
            onClick={() => setViewMode("explore")}
          >
            Explore dataset
          </button>
        </div>
        {/* Both panels stay mounted and are hidden with the `hidden` attribute
            rather than unmounted, so switching tabs keeps the Explore tab's
            loaded bundle, filters, selected apartment and scroll position. */}
        <Sidebar
            hidden={viewMode !== "trace"}
            rooms={rooms}
            furnishedRooms={furnishedRooms}
            selectedTool={selectedTool}
            lastRoomTool={lastRoomTool}
            backgroundImages={backgroundImages}
            drawMode={drawMode}
            orthoMode={orthoMode}
            snapToGrid={snapToGrid}
            gridStep={gridStep}
            aptType={computedAptType}
            pipelineConfig={pipelineConfig}
            onSelectTool={handleSelectTool}
            onUploadClick={handleUploadClick}
            onUploadJsonClick={handleJsonUploadClick}
            wallSettings={wallSettings}
            onSetWallSettings={(patch) => setWallSettings((s) => ({ ...s, ...patch }))}
            onReset={handleReset}
            onFurnish={handleFurnishClick}
            onSetDrawMode={handleSetDrawMode}
            onToggleOrtho={handleToggleOrtho}
            onToggleSnapToGrid={handleToggleSnapToGrid}
            onSetGridStep={handleSetGridStep}
            onDownloadTemplate={handleDownloadTemplate}
            onSetAptType={handleSetAptType}
            onUpdateRoomSteps={handleUpdateRoomSteps}
            onImageSelect={selectBackgroundImage}
            onImageDelete={deleteBackgroundImage}
            onImageUpdate={updateBackgroundImage}
            {...affords}
          />
        <ExploreTab
          hidden={viewMode !== "explore"}
          isFurnished={isFurnished}
          affords={affords}
          onLoadApartment={handleLoadDatasetApartment}
        />
      </div>

      <section
        ref={viewerRef}
        className="viewer-surface"
        aria-label="Layout viewer"
        onClick={deselectAllImages}
      >
        <ViewerLayer
          backgroundImages={backgroundImages}
          calibration={scaleCalibration}
          roomDraft={roomDraft}
          rooms={rooms}
          furnishedRooms={furnishedRooms}
          selectedRoomId={selectedRoomId}
          selectedTool={selectedTool}
          drawMode={drawMode}
          gridStep={gridStep}
          transform={transform}
          datasetContext={datasetContext}
          datasetWalls={datasetWalls}
          generatedWalls={generatedWalls}
          datasetEntrances={datasetEntrances}
          apartmentShell={apartmentShell}
          showWalls={showWalls}
          onCalibrationClick={handleScaleCalibrationClick}
          onCalibrationMove={(p) => setScaleCalibration((c) => (c.p1 ? { ...c, cursor: p } : c))}
          onDoorClick={handleDoorClick}
          onWindowClick={handleWindowClick}
          onRoomClick={handleRoomToolClick}
          onRoomPointerMove={handleRoomPointerMove}
          onMoveImage={moveBackgroundImage}
          onSelectRoom={setSelectedRoomId}
          onSelectFurniture={setSelectedFurnitureKey}
          onUpdateRoom={handleUpdateRoom}
          onMoveRoom={handleMoveRoom}
          selectedFurnitureKey={selectedFurnitureKey}
          onFurnitureDrop={handleFurnitureDrop}
          onPan={(cx, cy) => setTransform((t) => ({ ...t, centerX: cx, centerY: cy }))}
          showTransitionAreas={showTransitionAreas}
          failedCandidates={failedCandidates}
          showFailedCandidates={showFailedCandidates}
          selectedCandidateKey={selectedCandidateKey}
          onSelectCandidate={setSelectedCandidateKey}
          onCandidateDrop={handleCandidateDrop}
        />

        {isFurnished ? (
          <div className="canvas-status-badge">
            <span className="status-dot" />
            FURNISHED
          </div>
        ) : null}

        {furnishError ? (
          <div className="furnish-messages">
            <strong>{furnishError}</strong>
          </div>
        ) : null}

        {(() => {
          const roomResult = selectedRoomId
            ? furnishedRooms.find((r) => r.roomId === selectedRoomId)
            : null;
          return roomResult && selectedTool === "furnish" ? (
            <VariantControlPanel
              roomResult={roomResult}
              onStepChange={(stepIndex, newIndex) => handleVariantChange(selectedRoomId!, stepIndex, newIndex)}
            />
          ) : null;
        })()}

        <input
          ref={fileInputRef}
          className="file-input"
          type="file"
          accept=".png,.jpg,.jpeg,image/png,image/jpeg"
          multiple
          onChange={handleImageFileChange}
        />

        <input
          ref={jsonInputRef}
          className="file-input"
          type="file"
          accept=".json,application/json"
          onChange={handleJsonFileChange}
        />
      </section>
      </main>
    </div>
  );
}
