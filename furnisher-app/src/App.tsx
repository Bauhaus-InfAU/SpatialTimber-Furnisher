import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent, PointerEvent } from "react";
import { runRoomPipelineAt, getAllPlacements, placeVariantAtCorner, getDoorRectangles, subtractPolygon, scoreRoom } from "@engine/index";
import type { PlacedFurniture, StepOptions, PlacementOptions } from "@engine/types";
import type { Room as EngineRoom, RoomName } from "@layout/types";
import type { FurnitureLibrary, FurnitureEntry, FurnitureVariant, FurnitureCategory, Pipeline } from "@library";
import { defaultLibrary, defaultPipeline, findFurnitureByName } from "@library";
import { AppHeader } from "./AppHeader";
import { ROOM_TOOLS, isRoomTool } from "./types";
import type {
  ToolId,
  RoomToolId,
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

function getDoorSwingGeometry(room: DrawnRoom, doorPoint: Point2D) {
  if (room.points.length < 2) return null;

  let wallA = room.points[0];
  let wallB = room.points[1];
  let minDistance = Infinity;

  for (let i = 0; i < room.points.length; i++) {
    const a = room.points[i];
    const b = room.points[(i + 1) % room.points.length];
    const candidate = nearestPointOnSegment(doorPoint, a, b);
    if (candidate.distance < minDistance) {
      minDistance = candidate.distance;
      wallA = a;
      wallB = b;
    }
  }

  const wallDir = normalizeVector({ x: wallB.x - wallA.x, y: wallB.y - wallA.y });
  const normal = perpCounterClockwise(wallDir);
  const testPoint = addPoint(doorPoint, scalePoint(normal, 0.05));
  const inward = pointInPolygon(testPoint, room.points) ? normal : scalePoint(normal, -1);
  const width = roomDoorWidth(room.type);

  const hinge = addPoint(doorPoint, scalePoint(wallDir, -width / 2));
  const panelEnd = addPoint(hinge, scalePoint(inward, width));
  const arcEnd = addPoint(hinge, scalePoint(wallDir, width));
  const cross = inward.x * wallDir.y - inward.y * wallDir.x;

  return { arcEnd, hinge, panelEnd, radius: width, sweepFlag: cross > 0 ? 1 : 0, doorPoint };
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
  return `${value.toFixed(2)} m`;
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

// ─── Shared-door display ownership ─────────────────────────────────────────────
// When a physical door sits on a wall between two rooms, both rooms may carry a
// door point for it (esp. dataset apartments). To avoid drawing the swing twice
// in the normal view, exactly one room "owns" the drawing, chosen by room type.
// Higher priority (lower index) wins; ties broken deterministically by room id.
const ROOM_DOOR_PRIORITY: RoomToolId[] = ["Bedroom", "Living room", "Kitchen", "Bathroom", "WC", "Children"];

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

function toEngineRooms(rooms: DrawnRoom[]) {
  let childIndex = 0;
  return rooms.map((room) => {
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
function computeLayoutSignature(rooms: DrawnRoom[], config: PipelineConfig): string {
  const r = (n: number) => n.toFixed(2);
  const pts = (list: Point2D[]) => list.map((p) => `${r(p.x)},${r(p.y)}`).join("|");
  const roomsSig = rooms
    .map((room) => `${room.id}:${room.type}:${pts(room.points)}:${pts(room.doors)}:${pts(room.windows)}`)
    .join(";");
  return `${roomsSig}#${JSON.stringify(config)}`;
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
            {len.toFixed(2)}m
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
    return (
      <g className="edge-editor">
        {/* Whole-room body drag surface — sits below FurnitureHandles. Only the
            interior fill translates the room; furniture glyphs above are
            unaffected. */}
        <path
          className="room-body-drag"
          d={pointsToPath(room.points, true)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={handleBodyPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      </g>
    );
  }

  return (
    <g className="edge-editor">
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
}: {
  room: DrawnRoom;
  ownedDoors: boolean[];
  showAll: boolean;
}) {
  if (!room.doors.length) return null;
  return (
    <>
      {room.doors.map((doorPoint, i) => {
        // Normal view: only the owning room draws a shared door (once).
        // Transition-zones view: every room draws its own clearance so both
        // sides of a shared door are visible.
        if (!showAll && !ownedDoors[i]) return null;
        const geometry = getDoorSwingGeometry(room, doorPoint);
        if (!geometry) return null;
        const { arcEnd, hinge, panelEnd, radius, sweepFlag } = geometry;
        return (
          <g key={i} className="room-door">
            <line x1={hinge.x} y1={hinge.y} x2={panelEnd.x} y2={panelEnd.y} />
            <path
              className="door-arc"
              d={`M ${panelEnd.x} ${panelEnd.y} A ${radius} ${radius} 0 0 ${sweepFlag} ${arcEnd.x} ${arcEnd.y}`}
            />
            <circle className="door-hinge" cx={hinge.x} cy={hinge.y} r="0.035" />
            <circle className="door-center" cx={doorPoint.x} cy={doorPoint.y} r="0.05" />
          </g>
        );
      })}
    </>
  );
}

function windowWidth(roomType: RoomToolId): number {
  return roomType === "Bathroom" || roomType === "WC" || roomType === "Kitchen" ? 1.0 : 1.5;
}

function getWindowGeometry(room: DrawnRoom, windowPt: Point2D) {
  if (room.points.length < 2) return null;
  let wallA = room.points[0], wallB = room.points[1];
  let minDist = Infinity;
  for (let i = 0; i < room.points.length; i++) {
    const a = room.points[i], b = room.points[(i + 1) % room.points.length];
    const d = nearestPointOnSegment(windowPt, a, b).distance;
    if (d < minDist) { minDist = d; wallA = a; wallB = b; }
  }
  const dir = normalizeVector({ x: wallB.x - wallA.x, y: wallB.y - wallA.y });
  const snap = nearestPointOnSegment(windowPt, wallA, wallB).point;
  const half = windowWidth(room.type) / 2;
  const start = { x: snap.x - dir.x * half, y: snap.y - dir.y * half };
  const end   = { x: snap.x + dir.x * half, y: snap.y + dir.y * half };
  const normal = perpCounterClockwise(dir);
  const inward = pointInPolygon(addPoint(snap, scalePoint(normal, 0.05)), room.points)
    ? normal : scalePoint(normal, -1);
  const REVEAL = 0.14;
  return { start, end, snap, inward, reveal: REVEAL };
}

function WindowDisplay({ room }: { room: DrawnRoom }) {
  if (!room.windows.length) return null;
  return (
    <>
      {room.windows.map((winPt, i) => {
        const g = getWindowGeometry(room, winPt);
        if (!g) return null;
        const { start, end, snap, inward, reveal } = g;
        const inner = (p: Point2D) => addPoint(p, scalePoint(inward, -reveal));
        return (
          <g key={i} className="room-window">
            <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} className="window-outer" />
            <line x1={inner(start).x} y1={inner(start).y} x2={inner(end).x} y2={inner(end).y} className="window-inner" />
            <line x1={start.x} y1={start.y} x2={inner(start).x} y2={inner(start).y} className="window-jamb" />
            <line x1={end.x} y1={end.y} x2={inner(end).x} y2={inner(end).y} className="window-jamb" />
            <circle className="window-center" cx={snap.x} cy={snap.y} r="0.08" />
          </g>
        );
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
  onSelectRoom,
}: {
  draft: RoomDraft | null;
  drawMode: "rectangle" | "lines";
  furnishedRooms: FurnishedRoomResult[];
  rooms: DrawnRoom[];
  selectedRoomId: string | null;
  selectable: boolean;
  showTransitionAreas: boolean;
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

              {/* single wall-midpoint drag handle */}
              {handlePt && (
                <circle
                  cx={handlePt.x} cy={handlePt.y} r="0.13"
                  className="furniture-drag-handle"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const w = toWorld(e.clientX, e.clientY);
                    if (!w) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({ roomId: rr.roomId, stepIndex: si, cursor: w });
                  }}
                  onPointerMove={(e) => {
                    if (!drag) return;
                    const w = toWorld(e.clientX, e.clientY);
                    if (w) setDrag((d) => d ? { ...d, cursor: w } : null);
                  }}
                  onPointerUp={(e) => {
                    if (!drag || drag.roomId !== rr.roomId || drag.stepIndex !== si) return;
                    e.currentTarget.releasePointerCapture(e.pointerId);
                    const s = snapToRoomWall(drag.cursor, room);
                    if (s) onDrop(drag.roomId, drag.stepIndex, s.point, s.wallA, s.wallB, s.inward);
                    setDrag(null);
                  }}
                  onPointerCancel={() => setDrag(null)}
                />
              )}

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

            {/* Wall-midpoint drag handle (only when selected) */}
            {handlePt && (
              <circle
                cx={handlePt.x} cy={handlePt.y} r="0.13"
                className="furniture-drag-handle"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  const w = toWorld(e.clientX, e.clientY);
                  if (!w) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setCandDrag({ roomId: c.roomId, stepIndex: c.stepIndex, cursor: w });
                }}
                onPointerMove={(e) => {
                  if (!candDrag) return;
                  const w = toWorld(e.clientX, e.clientY);
                  if (w) setCandDrag((d) => (d ? { ...d, cursor: w } : null));
                }}
                onPointerUp={(e) => {
                  if (!candDrag || candDrag.roomId !== c.roomId || candDrag.stepIndex !== c.stepIndex) return;
                  e.currentTarget.releasePointerCapture(e.pointerId);
                  const s = snapToRoomWall(candDrag.cursor, room);
                  if (s) {
                    onCandidateDrop(
                      { roomId: c.roomId, stepIndex: c.stepIndex },
                      s.point, s.wallA, s.wallB, s.inward,
                    );
                  }
                  setCandDrag(null);
                }}
                onPointerCancel={() => setCandDrag(null)}
              />
            )}

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
  transform,
  selectedFurnitureKey,
  datasetContext,
  datasetWalls,
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
  transform: ViewerTransform;
  selectedFurnitureKey: FurnitureKey | null;
  datasetContext: DatasetContextArea[];
  datasetWalls: Point2D[][];
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

  const gridLines = useMemo(() => {
    const lines = [];
    for (let i = -100; i <= 100; i++) {
      lines.push(
        <line key={`x-${i}`} x1={i} y1="-100" x2={i} y2="100" />,
        <line key={`y-${i}`} x1="-100" y1={i} x2="100" y2={i} />,
      );
    }
    return lines;
  }, []);

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
        onSelectRoom={onSelectRoom}
      />
      {showWalls ? <DatasetWallLayer walls={datasetWalls} /> : null}
      {selectedRoom && selectable ? (
        <EdgeEditor room={selectedRoom} svgRef={svgRef} onUpdate={onUpdateRoom} onMoveRoom={onMoveRoom} layer="body" />
      ) : null}
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
      {selectedRoom && selectable ? (
        <EdgeEditor room={selectedRoom} svgRef={svgRef} onUpdate={onUpdateRoom} onMoveRoom={onMoveRoom} layer="handles" />
      ) : null}
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
  const viewerRef = useRef<HTMLElement>(null);
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

  function handleRoomToolClick(rawPoint: Point2D) {
    if (!isRoomTool(selectedTool)) return;
    const tool = ROOM_TOOLS.find((t) => t.id === selectedTool);
    if (!tool) return;

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

  function handleRoomPointerMove(rawPoint: Point2D) {
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
    setRooms((current) =>
      current.map((room) =>
        room.id === roomId ? { ...room, points: newPoints, doors: newDoors, windows: newWindows } : room,
      ),
    );
    setFurnishedRooms((current) => current.filter((r) => r.roomId !== roomId));
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

  function handleLoadDatasetApartment(record: NeufertRecord) {
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

    // 3. Replace the drawing state (background images are left untouched).
    resetScaleCalibration();
    resetRoomDraft();
    setRooms(converted);
    setDatasetContext(contextAreas);
    setDatasetWalls(wallRings);
    setFurnishedRooms([]);
    setSelectedRoomId(null);
    setSelectedFurnitureKey(null);
    setFurnishError(null);
    const nextConfig: PipelineConfig = { ...pipelineConfig, roomOverrides: {} };
    setPipelineConfig(nextConfig);
    setSelectedTool("furnish");

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

  return (
    <div className="app-root">
      <AppHeader />
      <main className="app-shell">
      <Sidebar
        rooms={rooms}
        furnishedRooms={furnishedRooms}
        selectedTool={selectedTool}
        lastRoomTool={lastRoomTool}
        backgroundImages={backgroundImages}
        drawMode={drawMode}
        orthoMode={orthoMode}
        aptType={computedAptType}
        pipelineConfig={pipelineConfig}
        onSelectTool={handleSelectTool}
        onUploadClick={handleUploadClick}
        onReset={handleReset}
        onFurnish={handleFurnishClick}
        onSetDrawMode={handleSetDrawMode}
        onToggleOrtho={handleToggleOrtho}
        onSetAptType={handleSetAptType}
        onUpdateRoomSteps={handleUpdateRoomSteps}
        onImageSelect={selectBackgroundImage}
        onImageDelete={deleteBackgroundImage}
        onImageUpdate={updateBackgroundImage}
        onLoadDatasetApartment={handleLoadDatasetApartment}
        showTransitionAreas={showTransitionAreas}
        onToggleTransitionAreas={() => setShowTransitionAreas((v) => !v)}
        showFailedCandidates={showFailedCandidates}
        onToggleFailedCandidates={() => setShowFailedCandidates((v) => !v)}
        showWalls={showWalls}
        onToggleWalls={() => setShowWalls((v) => !v)}
      />

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
          transform={transform}
          datasetContext={datasetContext}
          datasetWalls={datasetWalls}
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
      </section>
      </main>
    </div>
  );
}
