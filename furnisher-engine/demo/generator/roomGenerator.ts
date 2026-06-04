/**
 * roomGenerator.ts
 * ─────────────────
 * TypeScript port of randomRoomsGenerator.py
 *
 * Given an integer seed, deterministically produces a random apartment
 * layout: a set of named rooms, each with a polygon outline and a door point.
 */

import { makePrng, type Prng } from "./seededRandom";
import type { Point2D, Room, RoomName, Apartment, ApartmentLabel } from "../../src/layout/types";

// ─── Configuration (mirrors the Python constants) ─────────────────────────────

const ROOM_ORDER: RoomName[] = [
  "Bedroom", "Living room", "Bathroom", "WC", "Kitchen",
  "Children 1", "Children 2", "Children 3", "Children 4",
];

/** [minW, maxW, minH, maxH] in metres */
const SIZE_RANGES: Record<RoomName, [number, number, number, number]> = {
  "Bedroom":    [3.2, 5.5, 3.5, 5.0],
  "Living room":[4.0, 7.0, 4.0, 6.5],
  "Bathroom":   [1.8, 3.2, 2.2, 3.5],
  "WC":         [1.0, 2.0, 1.2, 2.2],
  "Kitchen":    [2.5, 4.5, 2.5, 4.5],
  "Children 1": [2.8, 4.5, 3.0, 4.5],
  "Children 2": [2.8, 4.5, 3.0, 4.5],
  "Children 3": [2.8, 4.0, 3.0, 4.0],
  "Children 4": [2.8, 4.0, 3.0, 4.0],
};

const L_SHAPE_CHANCE: Record<RoomName, number> = {
  "Bedroom":    0.55,
  "Living room":0.65,
  "Bathroom":   0.25,
  "WC":         0.08,
  "Kitchen":    0.35,
  "Children 1": 0.50,
  "Children 2": 0.50,
  "Children 3": 0.45,
  "Children 4": 0.45,
};

const ROOM_SPACING = 2.0; // metres between rooms in the display layout

// ─── Apartment type selector ──────────────────────────────────────────────────

interface ActiveRooms {
  flags: Record<RoomName, boolean>;
  label: ApartmentLabel;
}

function getActiveRooms(rng: Prng): ActiveRooms {
  const r = rng.random();
  let hasBed: boolean, hasLiv: boolean, nKids: number, label: ApartmentLabel;

  if      (r < 0.10) { hasBed = false; hasLiv = true;  nKids = 0; label = "Studio (living)";  }
  else if (r < 0.20) { hasBed = true;  hasLiv = false; nKids = 0; label = "Studio (bedroom)"; }
  else if (r < 0.40) { hasBed = true;  hasLiv = true;  nKids = 0; label = "1-Bedroom";        }
  else if (r < 0.65) { hasBed = true;  hasLiv = true;  nKids = 1; label = "2-Bedroom";        }
  else if (r < 0.80) { hasBed = true;  hasLiv = true;  nKids = 2; label = "3-Bedroom";        }
  else if (r < 0.92) { hasBed = true;  hasLiv = true;  nKids = 3; label = "4-Bedroom";        }
  else               { hasBed = true;  hasLiv = true;  nKids = 4; label = "5-Bedroom";        }

  const hasWc = (hasBed && hasLiv)
    ? rng.random() < 0.6
    : rng.random() < 0.15;

  const flags: Record<RoomName, boolean> = {
    "Bedroom":    hasBed,
    "Living room":hasLiv,
    "Bathroom":   true,
    "WC":         hasWc,
    "Kitchen":    true,
    "Children 1": nKids >= 1,
    "Children 2": nKids >= 2,
    "Children 3": nKids >= 3,
    "Children 4": nKids >= 4,
  };

  return { flags, label };
}

// ─── Shape generators ─────────────────────────────────────────────────────────

function makeRectangle(w: number, h: number, ox: number, oy: number): Point2D[] {
  return [
    [ox,     oy    ],
    [ox + w, oy    ],
    [ox + w, oy + h],
    [ox,     oy + h],
  ];
}

function makeLShape(w: number, h: number, ox: number, oy: number, rng: Prng): Point2D[] {
  let cutW = rng.uniform(0.12, 0.45) * w;
  let cutH = rng.uniform(0.15, 0.45) * h;
  cutW = Math.max(0.4, Math.min(cutW, w * 0.48));
  cutH = Math.max(0.4, Math.min(cutH, h * 0.48));

  const corner = rng.randint(0, 3);

  if (corner === 0) { // cut top-right
    return [
      [ox,             oy            ],
      [ox + w,         oy            ],
      [ox + w,         oy + h - cutH ],
      [ox + w - cutW,  oy + h - cutH ],
      [ox + w - cutW,  oy + h        ],
      [ox,             oy + h        ],
    ];
  } else if (corner === 1) { // cut top-left
    return [
      [ox,         oy            ],
      [ox + w,     oy            ],
      [ox + w,     oy + h        ],
      [ox + cutW,  oy + h        ],
      [ox + cutW,  oy + h - cutH ],
      [ox,         oy + h - cutH ],
    ];
  } else if (corner === 2) { // cut bottom-right
    return [
      [ox,             oy       ],
      [ox + w - cutW,  oy       ],
      [ox + w - cutW,  oy + cutH],
      [ox + w,         oy + cutH],
      [ox + w,         oy + h   ],
      [ox,             oy + h   ],
    ];
  } else { // cut bottom-left
    return [
      [ox + cutW,  oy       ],
      [ox + w,     oy       ],
      [ox + w,     oy + h   ],
      [ox,         oy + h   ],
      [ox,         oy + cutH],
      [ox + cutW,  oy + cutH],
    ];
  }
}

function generateRoomShape(
  name: RoomName, ox: number, oy: number, rng: Prng
): { polygon: Point2D[]; width: number } {
  const [mnW, mxW, mnH, mxH] = SIZE_RANGES[name];
  let w = rng.uniform(mnW, mxW);
  let h = rng.uniform(mnH, mxH);
  if (rng.random() < 0.5) { [w, h] = [h, w]; }

  const polygon = rng.random() < L_SHAPE_CHANCE[name]
    ? makeLShape(w, h, ox, oy, rng)
    : makeRectangle(w, h, ox, oy);

  return { polygon, width: w };
}

// ─── Door placement ───────────────────────────────────────────────────────────

function placeDoor(polygon: Point2D[], rng: Prng): Point2D {
  // Collect wall segments
  const walls: Array<{ p1: Point2D; p2: Point2D; len: number }> = [];
  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (len > 0.3) walls.push({ p1, p2, len });
  }
  if (!walls.length) return polygon[0];

  const candidates = walls.filter(w => w.len >= 1.2);
  const pool = candidates.length ? candidates : walls;
  const { p1, p2, len } = rng.choice(pool);

  const margin = Math.min(0.4, len * 0.2);
  const t = rng.uniform(margin / len, 1 - margin / len);

  return [
    p1[0] + t * (p2[0] - p1[0]),
    p1[1] + t * (p2[1] - p1[1]),
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a random apartment from an integer seed.
 * Same seed always produces the same layout.
 */
export function generateApartment(seed: number): Apartment {
  const rng = makePrng(seed);
  const { flags, label } = getActiveRooms(rng);

  const rooms: Room[] = [];
  let offsetX = 0;

  for (const name of ROOM_ORDER) {
    if (!flags[name]) continue;

    const { polygon, width } = generateRoomShape(name, offsetX, 0, rng);
    const door = placeDoor(polygon, rng);

    rooms.push({ name, polygon, door });
    offsetX += width + ROOM_SPACING;
  }

  return { label, rooms };
}

/**
 * Generate a single room of a specific type from an integer seed.
 * Useful for testing placement of furniture in isolation.
 */
export function generateSingleRoom(name: RoomName, seed: number): Room {
  const rng = makePrng(seed);
  const { polygon } = generateRoomShape(name, 0, 0, rng);
  const door = placeDoor(polygon, rng);
  return { name, polygon, door };
}
