/**
 * RoomWithFurnitureCanvas
 * ───────────────────────
 * Renders a single Room with optional placed furniture onto a 2D Canvas.
 */

import { useRef, useEffect } from "react";
import type { Point2D, Room } from "../../../src/layout/types";
import type { PlacedFurniture } from "../../../src/engine/types";
import { getDoorRectangle } from "../../../src/engine/placer";
import { subtractPolygon } from "../../../src/engine/subtraction";

// ─── Colours ─────────────────────────────────────────────────────────────────

const BG_COLOR       = "#141414";
const GRID_COLOR     = "rgba(255,255,255,0.04)";
const ROOM_FILL      = "rgba(94, 140, 200, 0.18)";
const ROOM_STROKE    = "#5e8cc8";
const DOOR_COLOR     = "#ff7744";
const LABEL_COLOR    = "#c8d8f0";
const FURN_FILL      = "rgba(232, 192, 96, 0.22)";
const FURN_STROKE    = "#e8c060";
const BBOX_STROKE       = "rgba(255, 100, 100, 0.45)";
const SMALL_BBOX_STROKE = "rgba(255, 200,  50, 0.70)";
const WALL_STROKE       = "rgba(100, 255, 100, 0.35)";
const ROOM_FULL_FILL = "rgba( 80, 200, 160, 0.30)";
const ROOM_RDC_FILL  = "rgba(220, 140,  50, 0.25)";

// ─── Door geometry helpers ────────────────────────────────────────────────────

function vlenD(v: Point2D) { return Math.hypot(v[0], v[1]); }
function normalizeV(v: Point2D): Point2D {
  const l = vlenD(v); return l > 1e-12 ? [v[0]/l, v[1]/l] : [0, 0];
}
function addV(a: Point2D, b: Point2D): Point2D { return [a[0]+b[0], a[1]+b[1]]; }
function scaleV(v: Point2D, s: number): Point2D { return [v[0]*s, v[1]*s]; }
function perpCCWV(v: Point2D): Point2D { return [-v[1], v[0]]; }

function pointInPolyD(pt: Point2D, poly: Point2D[]): boolean {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj-xi)*(py-yi))/(yj-yi)+xi) inside = !inside;
  }
  return inside;
}

function distToSeg(pt: Point2D, a: Point2D, b: Point2D): number {
  const ab = [b[0]-a[0], b[1]-a[1]];
  const len2 = ab[0]*ab[0] + ab[1]*ab[1];
  if (len2 < 1e-12) return Math.hypot(pt[0]-a[0], pt[1]-a[1]);
  const t = Math.max(0, Math.min(1, ((pt[0]-a[0])*ab[0] + (pt[1]-a[1])*ab[1]) / len2));
  return Math.hypot(pt[0]-(a[0]+t*ab[0]), pt[1]-(a[1]+t*ab[1]));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function boundsOf(pts: Point2D[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function makeTransform(
  bounds: ReturnType<typeof boundsOf>,
  W: number, H: number, PAD: number,
) {
  const rX = bounds.maxX - bounds.minX || 1;
  const rY = bounds.maxY - bounds.minY || 1;
  const s = Math.min((W - PAD * 2) / rX, (H - PAD * 2) / rY);
  const offX = PAD + ((W - PAD * 2) - rX * s) / 2;
  const offY = PAD + ((H - PAD * 2) - rY * s) / 2;
  return {
    tc: ([x, y]: Point2D): [number, number] => [
      offX + (x - bounds.minX) * s,
      H - offY - (y - bounds.minY) * s,
    ],
    scale: s,
  };
}

// ─── Door drawing ─────────────────────────────────────────────────────────────

function drawDoor(
  ctx: CanvasRenderingContext2D,
  room: Room,
  tc: (p: Point2D) => [number, number],
  scaleVal: number,
) {
  const { door, polygon, name } = room;
  const n = polygon.length;

  let wallA: Point2D = polygon[0];
  let wallB: Point2D = polygon[1];
  let minDist = Infinity;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const d = distToSeg(door, a, b);
    if (d < minDist) { minDist = d; wallA = a; wallB = b; }
  }

  const wallDir = normalizeV([wallB[0] - wallA[0], wallB[1] - wallA[1]]);
  const n1 = perpCCWV(wallDir);
  const testPt = addV(door, scaleV(n1, 0.05));
  const inward = pointInPolyD(testPt, polygon) ? n1 : scaleV(n1, -1);

  const dw = (name === "Bathroom" || name === "WC") ? 0.8 : 0.9;

  const hinge    = addV(door, scaleV(wallDir, -dw / 2));
  const panelEnd = addV(hinge, scaleV(inward, dw));
  const arcEnd   = addV(hinge, scaleV(wallDir, dw));

  const [hx, hy]  = tc(hinge);
  const [px, py]  = tc(panelEnd);
  const [ax, ay]  = tc(arcEnd);
  const radius = Math.hypot(px - hx, py - hy);

  if (radius < 1) return;

  ctx.strokeStyle = DOOR_COLOR;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(px, py);
  ctx.stroke();

  const startAngle = Math.atan2(py - hy, px - hx);
  const endAngle   = Math.atan2(ay - hy, ax - hx);
  const TAU = 2 * Math.PI;
  const cwSweep = ((endAngle - startAngle) % TAU + TAU) % TAU;
  const anticlockwise = cwSweep > Math.PI;

  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(hx, hy, radius, startAngle, endAngle, anticlockwise);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(hx, hy, Math.max(2.5, scaleVal * 0.06), 0, Math.PI * 2);
  ctx.fillStyle = DOOR_COLOR;
  ctx.fill();
}

// ─── Stage-4 subtracted-region rendering ─────────────────────────────────────

function fillPolygon(
  ctx: CanvasRenderingContext2D,
  pts: Point2D[],
  tc: (p: Point2D) => [number, number],
  color: string,
) {
  if (pts.length < 3) return;
  ctx.beginPath();
  const [x0, y0] = tc(pts[0]);
  ctx.moveTo(x0, y0);
  for (let i = 1; i < pts.length; i++) {
    const [x, y] = tc(pts[i]);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function draw(
  canvas: HTMLCanvasElement,
  room: Room,
  pieces: PlacedFurniture[],
  showDoors: boolean,
  showLabels: boolean,
  showGrid: boolean,
  showBbox: boolean,
  showStage4: boolean,
) {
  const W = canvas.width;
  const H = canvas.height;
  const PAD = 32;
  const ctx = canvas.getContext("2d")!;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, W, H);

  const allPts: Point2D[] = [...room.polygon, ...(room.door ? [room.door] : [])];
  for (const furniture of pieces) {
    for (const geo of furniture.transformedGeometry)
      allPts.push(...geo.points);
    allPts.push(...furniture.transformedBbox);
  }

  const bounds = boundsOf(allPts);
  const { tc, scale } = makeTransform(bounds, W, H, PAD);

  if (showGrid) {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    const startX = Math.floor(bounds.minX);
    const startY = Math.floor(bounds.minY);
    for (let x = startX; x <= bounds.maxX + 1; x++) {
      const [cx] = tc([x, bounds.minY]);
      ctx.beginPath(); ctx.moveTo(cx, PAD); ctx.lineTo(cx, H - PAD); ctx.stroke();
    }
    for (let y = startY; y <= bounds.maxY + 1; y++) {
      const [, cy] = tc([bounds.minX, y]);
      ctx.beginPath(); ctx.moveTo(PAD, cy); ctx.lineTo(W - PAD, cy); ctx.stroke();
    }
  }

  const poly = room.polygon;
  if (poly.length) {
    ctx.beginPath();
    const [sx, sy] = tc(poly[0]);
    ctx.moveTo(sx, sy);
    for (let j = 1; j < poly.length; j++) {
      const [px, py] = tc(poly[j]);
      ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle   = ROOM_FILL;
    ctx.strokeStyle = ROOM_STROKE;
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();
  }

  if (showLabels && poly.length) {
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const [lx, ly] = tc([cx, cy]);
    ctx.fillStyle     = LABEL_COLOR;
    ctx.font          = `${Math.max(10, Math.min(13, scale * 0.7))}px 'Segoe UI', sans-serif`;
    ctx.textAlign     = "center";
    ctx.textBaseline  = "middle";
    ctx.fillText(room.name, lx, ly);
  }

  if (showDoors && room.door) {
    drawDoor(ctx, room as Room & { door: Point2D }, tc, scale);
  }

  for (const furniture of pieces) {
    for (const geo of furniture.transformedGeometry) {
      if (geo.points.length < 2) continue;
      ctx.beginPath();
      const [fx, fy] = tc(geo.points[0]);
      ctx.moveTo(fx, fy);
      for (let j = 1; j < geo.points.length; j++) {
        const [px, py] = tc(geo.points[j]);
        ctx.lineTo(px, py);
      }
      if (geo.closed) ctx.closePath();
      ctx.fillStyle   = FURN_FILL;
      ctx.strokeStyle = FURN_STROKE;
      ctx.lineWidth   = 1.5;
      if (geo.closed) ctx.fill();
      ctx.stroke();
    }
  }

  if (showStage4 && pieces.length > 0) {
    let roomFull = room.polygon;
    let roomRdc  = subtractPolygon(room.polygon, getDoorRectangle(room));
    for (const furniture of pieces) {
      roomFull = subtractPolygon(roomFull, furniture.smallCutout);
      roomRdc  = subtractPolygon(roomRdc,  furniture.largeCutout);
    }
    fillPolygon(ctx, roomFull, tc, ROOM_FULL_FILL);
    fillPolygon(ctx, roomRdc,  tc, ROOM_RDC_FILL);
  }

  if (showBbox) {
    for (const furniture of pieces) {
      if (furniture.transformedBbox.length >= 2) {
        ctx.beginPath();
        const [bx, by] = tc(furniture.transformedBbox[0]);
        ctx.moveTo(bx, by);
        for (let j = 1; j < furniture.transformedBbox.length; j++) {
          const [px, py] = tc(furniture.transformedBbox[j]);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = BBOX_STROKE;
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (furniture.transformedSmallBbox.length >= 2) {
        ctx.beginPath();
        const [bx, by] = tc(furniture.transformedSmallBbox[0]);
        ctx.moveTo(bx, by);
        for (let j = 1; j < furniture.transformedSmallBbox.length; j++) {
          const [px, py] = tc(furniture.transformedSmallBbox[j]);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.strokeStyle = SMALL_BBOX_STROKE;
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }

      const [w0x, w0y] = tc(furniture.wallSegment[0]);
      const [w1x, w1y] = tc(furniture.wallSegment[1]);
      ctx.beginPath();
      ctx.moveTo(w0x, w0y);
      ctx.lineTo(w1x, w1y);
      ctx.strokeStyle = WALL_STROKE;
      ctx.lineWidth   = 2.5;
      ctx.stroke();
    }
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  room:        Room;
  furniture:   PlacedFurniture | PlacedFurniture[] | null;
  width?:      number;
  height?:     number;
  showDoors?:  boolean;
  showLabels?: boolean;
  showGrid?:   boolean;
  showBbox?:   boolean;
  showStage4?: boolean;
}

export function RoomWithFurnitureCanvas({
  room,
  furniture,
  width      = 700,
  height     = 500,
  showDoors  = true,
  showLabels = true,
  showGrid   = true,
  showBbox   = false,
  showStage4 = true,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  const pieces: PlacedFurniture[] =
    furniture === null ? [] :
    Array.isArray(furniture) ? furniture : [furniture];

  useEffect(() => {
    if (ref.current) {
      draw(ref.current, room, pieces, showDoors, showLabels, showGrid, showBbox, showStage4);
    }
  }, [room, furniture, width, height, showDoors, showLabels, showGrid, showBbox, showStage4]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      style={{ display: "block", borderRadius: 8 }}
    />
  );
}
