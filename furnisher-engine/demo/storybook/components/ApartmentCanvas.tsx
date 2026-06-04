/**
 * ApartmentCanvas
 * ───────────────
 * Renders an Apartment (rooms + doors) onto a 2D Canvas.
 * Each room gets a distinct colour fill; door points are drawn as circles.
 */

import { useRef, useEffect } from "react";
import type { Apartment, Point2D } from "../../../src/layout/types";

// ─── Colour palette (one per room, cycling) ───────────────────────────────────

const DOOR_COLOR  = "#ff7744";
const LABEL_COLOR = "#c8d8f0";
const BG_COLOR    = "#141414";
const GRID_COLOR  = "rgba(255,255,255,0.04)";

const PALETTE_FILLS = [
  "rgba( 94,140,200,0.18)",
  "rgba(100,190,130,0.18)",
  "rgba(200,140, 80,0.18)",
  "rgba(190, 90,140,0.18)",
  "rgba(130,190,190,0.18)",
  "rgba(180,160, 90,0.18)",
  "rgba(140,110,200,0.18)",
  "rgba(200,110,110,0.18)",
  "rgba( 90,180,160,0.18)",
];

const PALETTE_STROKES = [
  "#5e8cc8","#64be82","#c88c50","#be5a8c",
  "#82bebe","#b4a05a","#8c6ec8","#c86e6e","#5ab4a0",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function allPoints(apt: Apartment): Point2D[] {
  return apt.rooms.flatMap(r => [...r.polygon, r.door]);
}

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
  W: number, H: number, PAD: number
) {
  const rX = bounds.maxX - bounds.minX || 1;
  const rY = bounds.maxY - bounds.minY || 1;
  const scale = Math.min((W - PAD * 2) / rX, (H - PAD * 2) / rY);
  const offX = PAD + ((W - PAD * 2) - rX * scale) / 2;
  const offY = PAD + ((H - PAD * 2) - rY * scale) / 2;
  return {
    tc: ([x, y]: Point2D): [number, number] => [
      offX + (x - bounds.minX) * scale,
      H - offY - (y - bounds.minY) * scale,  // flip Y
    ],
    scale,
  };
}

// ─── Drawing ──────────────────────────────────────────────────────────────────

function draw(
  canvas: HTMLCanvasElement,
  apt: Apartment,
  showDoors: boolean,
  showLabels: boolean,
  showGrid: boolean,
) {
  const W = canvas.width;
  const H = canvas.height;
  const PAD = 32;
  const ctx = canvas.getContext("2d")!;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, W, H);

  if (!apt.rooms.length) return;

  const bounds = boundsOf(allPoints(apt));
  const { tc, scale } = makeTransform(bounds, W, H, PAD);

  if (showGrid) {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    const gridStep = 1;
    const startX = Math.floor(bounds.minX);
    const startY = Math.floor(bounds.minY);
    for (let x = startX; x <= bounds.maxX + 1; x += gridStep) {
      const [cx] = tc([x, bounds.minY]);
      ctx.beginPath(); ctx.moveTo(cx, PAD); ctx.lineTo(cx, H - PAD); ctx.stroke();
    }
    for (let y = startY; y <= bounds.maxY + 1; y += gridStep) {
      const [, cy] = tc([bounds.minX, y]);
      ctx.beginPath(); ctx.moveTo(PAD, cy); ctx.lineTo(W - PAD, cy); ctx.stroke();
    }
  }

  apt.rooms.forEach((room, i) => {
    if (!room.polygon.length) return;
    ctx.beginPath();
    const [sx, sy] = tc(room.polygon[0]);
    ctx.moveTo(sx, sy);
    for (let j = 1; j < room.polygon.length; j++) {
      const [px, py] = tc(room.polygon[j]);
      ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle   = PALETTE_FILLS[i % PALETTE_FILLS.length];
    ctx.strokeStyle = PALETTE_STROKES[i % PALETTE_STROKES.length];
    ctx.lineWidth   = 1.5;
    ctx.fill();
    ctx.stroke();

    if (showLabels) {
      const cx = room.polygon.reduce((s, p) => s + p[0], 0) / room.polygon.length;
      const cy = room.polygon.reduce((s, p) => s + p[1], 0) / room.polygon.length;
      const [lx, ly] = tc([cx, cy]);
      ctx.fillStyle  = LABEL_COLOR;
      ctx.font       = `${Math.max(10, Math.min(13, scale * 0.7))}px 'Segoe UI', sans-serif`;
      ctx.textAlign  = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(room.name, lx, ly);
    }
  });

  if (showDoors) {
    apt.rooms.forEach(room => {
      const [dx, dy] = tc(room.door);
      const r = Math.max(4, scale * 0.15);
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
      ctx.fillStyle   = DOOR_COLOR;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth   = 1.5;
      ctx.fill();
      ctx.stroke();
    });
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  apartment:   Apartment;
  width?:      number;
  height?:     number;
  showDoors?:  boolean;
  showLabels?: boolean;
  showGrid?:   boolean;
}

export function ApartmentCanvas({
  apartment,
  width      = 900,
  height     = 380,
  showDoors  = true,
  showLabels = true,
  showGrid   = true,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current) {
      draw(ref.current, apartment, showDoors, showLabels, showGrid);
    }
  }, [apartment, width, height, showDoors, showLabels, showGrid]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      style={{ display: "block", borderRadius: 8 }}
    />
  );
}
