// What the Building Composer's design canvas draws of a plan, ported verbatim (logic unchanged) from the composer's
// studio-next/src/next/canvasDraw.ts (branch iuliia/open-kitchen): `planWalls` (room walls as straight runs, the open
// kitchen's side to its living room and the plan's room lines as dashed open runs), `planDoors` / `doorsToDraw` /
// `drawnDoor` (every door hinged at its drawing's `a`, opening into its room; the entrance pieces joined; each drawn at
// 0.90 m, the entrance at 1.10 m, centred on its opening). The input is the drawing the composer's server builds
// (`stc.serve.studio_next.designs.drawing_m2`), exported by tools/export_composer_archive.py in plan metres (y up).

export type XY = [number, number];
export type Seg = { a: XY; b: XY };

export type PlacedRoom = { key: string; type: string; name: string; area_m2: number; rings: XY[][]; label: XY };
export type PlacedDoor = { room: string; from: string; entrance: boolean; a: XY; b: XY; hinge?: "high"; opens?: "from" };
export type Placed = {
  grid_m?: number;
  rooms: PlacedRoom[];
  doors: PlacedDoor[];
  /** room lines (openings between two rooms), each a straight run [a, b] */
  room_lines?: XY[][];
  /** free-standing walls, each a straight run [a, b] */
  free_walls?: XY[][];
};

export const GRID_M = 0.625;
/** look.ts DOOR_DRAWN_M */
export const DOOR_DRAWN_M = { door: 0.9, entrance: 1.1 } as const;

const EPS = 1e-6;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Is the point inside the rings (even-odd, as the canvas fills them)? */
export function inRings(p: XY, rings: XY[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i++) {
      const a = ring[i];
      const b = ring[j];
      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

/** The edges of rings as segments. */
export function ringSegs(rings: XY[][]): Seg[] {
  const out: Seg[] = [];
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (Math.abs(a[0] - b[0]) > EPS || Math.abs(a[1] - b[1]) > EPS) out.push({ a, b });
    }
  return out;
}

type Piece = Seg & { axis: "h" | "v" | null; line: number; lo: number; hi: number; rooms: Set<string> };

/** The room rings cut into grid-cell sides, one piece per side, each with the rooms it bounds (one or two). */
function piecesOf(d: Placed): Piece[] {
  const G = d.grid_m || GRID_M;
  const out = new Map<string, Piece>();
  for (const r of d.rooms)
    for (const s of ringSegs(r.rings)) {
      const n = Math.max(1, Math.round(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) / G));
      for (let k = 0; k < n; k++) {
        const a: XY = [s.a[0] + ((s.b[0] - s.a[0]) * k) / n, s.a[1] + ((s.b[1] - s.a[1]) * k) / n];
        const b: XY = [s.a[0] + ((s.b[0] - s.a[0]) * (k + 1)) / n, s.a[1] + ((s.b[1] - s.a[1]) * (k + 1)) / n];
        const key = `${r3((a[0] + b[0]) / 2)},${r3((a[1] + b[1]) / 2)}`;
        let pc = out.get(key);
        if (!pc) {
          const axis = Math.abs(a[1] - b[1]) < EPS ? "h" : Math.abs(a[0] - b[0]) < EPS ? "v" : null;
          const lo = axis === "h" ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
          const hi = axis === "h" ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
          pc = { a, b, axis, line: axis === "h" ? r3(a[1]) : r3(a[0]), lo, hi, rooms: new Set() };
          out.set(key, pc);
        }
        pc.rooms.add(r.key);
      }
    }
  return [...out.values()];
}

/** Pieces on one line, in order, joined where they meet: the runs as segments (a piece off the grid stays alone). */
function runs(pieces: Piece[]): { seg: Seg; length: number }[] {
  const lines = new Map<string, Piece[]>();
  const out: { seg: Seg; length: number }[] = [];
  for (const p of pieces) {
    if (!p.axis) {
      out.push({ seg: { a: p.a, b: p.b }, length: Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) });
      continue;
    }
    const k = `${p.axis}${p.line}`;
    lines.set(k, [...(lines.get(k) ?? []), p]);
  }
  for (const ps of lines.values()) {
    ps.sort((x, y) => x.lo - y.lo);
    let lo = ps[0].lo;
    let hi = ps[0].hi;
    const flush = (p: Piece) => {
      const seg: Seg = p.axis === "h" ? { a: [lo, p.line], b: [hi, p.line] } : { a: [p.line, lo], b: [p.line, hi] };
      out.push({ seg, length: hi - lo });
    };
    for (let i = 1; i < ps.length; i++) {
      if (ps[i].lo <= hi + EPS) hi = Math.max(hi, ps[i].hi);
      else {
        flush(ps[i - 1]);
        lo = ps[i].lo;
        hi = ps[i].hi;
      }
    }
    flush(ps[ps.length - 1]);
  }
  return out;
}

export type PlanWalls = {
  /** every side between two cells of different rooms or at the plan's edge, joined into straight runs */
  walls: Seg[];
  /** the sides an open kitchen shares with the room it opens onto (and the plan's room lines): drawn dashed */
  open: Seg[];
  /** per open kitchen, the room it opens onto (null: none found) */
  openTo: Record<string, string | null>;
};

const OPEN_ONTO = ["Living room", "Studio"];

export function planWalls(d: Placed): PlanWalls {
  const G = d.grid_m || GRID_M;
  const pieces = piecesOf(d);
  const openTo: Record<string, string | null> = {};
  const open = new Set<Piece>();
  for (const k of d.rooms.filter((r) => r.type === "Open kitchen")) {
    let best: { key: string; run: number; n: number; shared: Piece[] } | null = null;
    for (const o of d.rooms) {
      if (o.key === k.key || !OPEN_ONTO.includes(o.type)) continue;
      const shared = pieces.filter((p) => p.rooms.has(k.key) && p.rooms.has(o.key));
      if (!shared.length) continue;
      const run = Math.max(...runs(shared).map((x) => x.length));
      if (run < 2 * G - EPS) continue;
      if (!best || run > best.run + EPS || (Math.abs(run - best.run) <= EPS && shared.length > best.n)) best = { key: o.key, run, n: shared.length, shared };
    }
    openTo[k.key] = best?.key ?? null;
    for (const p of best?.shared ?? []) open.add(p);
  }
  const lines = new Set<string>();
  for (const ln of d.room_lines ?? []) {
    const [a, b] = ln;
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / G));
    for (let k = 0; k < n; k++) lines.add(`${r3(a[0] + ((b[0] - a[0]) * (k + 0.5)) / n)},${r3(a[1] + ((b[1] - a[1]) * (k + 0.5)) / n)}`);
  }
  if (lines.size) for (const p of pieces) if (lines.has(`${r3((p.a[0] + p.b[0]) / 2)},${r3((p.a[1] + p.b[1]) / 2)}`)) open.add(p);
  const free: Seg[] = (d.free_walls ?? []).map(([a, b]) => ({ a, b }));
  return { walls: [...runs(pieces.filter((p) => !open.has(p))).map((x) => x.seg), ...free], open: runs([...open]).map((x) => x.seg), openTo };
}

// ------------------------------------------------------------------------------------------------------- doors --

export type DoorMark = {
  entrance: boolean;
  room: string;
  from: string;
  /** the end of the opening the leaf turns on (the hinge) */
  a: XY;
  /** the other end of the opening */
  b: XY;
  /** the unit normal into `room` */
  inward: XY;
  /** the unit normal to the side the leaf opens to */
  toward: XY;
  /** the free end of the leaf, swung 90 degrees from `a` */
  leaf: XY;
  /** the SVG sweep flag of the swing from `leaf` to `b` */
  sweep: 0 | 1;
  width: number;
};

const sweepOf = (a: XY, b: XY, leaf: XY): 0 | 1 => ((leaf[0] - a[0]) * (b[1] - a[1]) - (leaf[1] - a[1]) * (b[0] - a[0]) > 0 ? 1 : 0);

export function planDoors(d: Placed): DoorMark[] {
  const G = d.grid_m || GRID_M;
  const rings = new Map(d.rooms.map((r) => [r.key, r.rings]));
  const out: DoorMark[] = [];
  const allRings = d.rooms.flatMap((r) => r.rings);
  const onWall = (p: XY) =>
    allRings.some((ring) => ring.some((a, i) => {
      const b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      if (L2 < EPS) return false;
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
      return t >= -1e-6 && t <= 1 + 1e-6 && Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < 1e-4;
    }));
  for (const raw of d.doors) {
    // Not in the composer: the studio's drawing (studio/designs.py `drawing`) reads a door stored at a grid VERTEX
    // (both coordinates whole cells) as vertical, so a door centred on a vertex of a horizontal wall comes out
    // across the wall. Such a door is turned 90° about its middle when that puts it on a wall.
    let dr = raw;
    const q = (s: XY, e: XY): XY => [s[0] * 0.75 + e[0] * 0.25, s[1] * 0.75 + e[1] * 0.25];
    if (!onWall(q(raw.a, raw.b))) {
      const m: XY = [(raw.a[0] + raw.b[0]) / 2, (raw.a[1] + raw.b[1]) / 2];
      const h: XY = [(raw.b[0] - raw.a[0]) / 2, (raw.b[1] - raw.a[1]) / 2];
      const a: XY = [m[0] + h[1], m[1] - h[0]];
      const b: XY = [m[0] - h[1], m[1] + h[0]];
      if (onWall(q(a, b)) && onWall(q(b, a))) dr = { ...raw, a, b };
    }
    const w = Math.hypot(dr.b[0] - dr.a[0], dr.b[1] - dr.a[1]);
    if (w < EPS) continue;
    let n: XY = [-(dr.b[1] - dr.a[1]) / w, (dr.b[0] - dr.a[0]) / w];
    const m: XY = [(dr.a[0] + dr.b[0]) / 2, (dr.a[1] + dr.b[1]) / 2];
    const into = rings.get(dr.room);
    const off = G / 2;
    if (into && !inRings([m[0] + n[0] * off, m[1] + n[1] * off], into) && inRings([m[0] - n[0] * off, m[1] - n[1] * off], into)) n = [-n[0], -n[1]];
    // Not in the composer: when the probe at the middle is undecided (the middle of an entrance spanning two rooms
    // lies on their shared wall line, so neither probe is inside its room), probe at a quarter and three quarters of
    // the opening against every room. In the composer this case depends on its world frame's orientation.
    else if (into && !inRings([m[0] + n[0] * off, m[1] + n[1] * off], into) && !inRings([m[0] - n[0] * off, m[1] - n[1] * off], into)) {
      const all = d.rooms.flatMap((r) => r.rings);
      const votes = [0.25, 0.75].map((f) => {
        const q: XY = [dr.a[0] + (dr.b[0] - dr.a[0]) * f, dr.a[1] + (dr.b[1] - dr.a[1]) * f];
        return (inRings([q[0] - n[0] * off, q[1] - n[1] * off], all) ? 1 : 0) - (inRings([q[0] + n[0] * off, q[1] + n[1] * off], all) ? 1 : 0);
      });
      if (votes[0] + votes[1] > 0) n = [-n[0], -n[1]];
    }
    const [a, b] = dr.hinge === "high" ? [dr.b, dr.a] : [dr.a, dr.b];
    const toward: XY = dr.opens === "from" ? [-n[0], -n[1]] : n;
    const leaf: XY = [a[0] + toward[0] * w, a[1] + toward[1] * w];
    out.push({ entrance: !!dr.entrance, room: dr.room, from: dr.from, a, b, inward: n, toward, leaf, sweep: sweepOf(a, b, leaf), width: w });
  }
  return out;
}

function distToLine(p: XY, o: DoorMark): number {
  const dx = o.b[0] - o.a[0];
  const dy = o.b[1] - o.a[1];
  const L = Math.hypot(dx, dy) || 1;
  return Math.abs((p[0] - o.a[0]) * dy - (p[1] - o.a[1]) * dx) / L;
}

export function doorsToDraw(doors: DoorMark[]): DoorMark[] {
  const inner = doors.filter((x) => !x.entrance);
  const ent: DoorMark[] = [];
  for (const e of doors.filter((x) => x.entrance)) {
    const w = e.width;
    const dir: XY = [(e.b[0] - e.a[0]) / w, (e.b[1] - e.a[1]) / w];
    const t = (p: XY, o: DoorMark) => (p[0] - o.a[0]) * dir[0] + (p[1] - o.a[1]) * dir[1];
    const host = ent.find((o) => {
      const od: XY = [(o.b[0] - o.a[0]) / o.width, (o.b[1] - o.a[1]) / o.width];
      const parallel = Math.abs(od[0] * dir[1] - od[1] * dir[0]) < 1e-6;
      const onLine = distToLine(e.a, o) < 1e-6;
      const sameSide = o.inward[0] * e.inward[0] + o.inward[1] * e.inward[1] > 0.99;
      if (!parallel || !onLine || !sameSide) return false;
      const [lo, hi] = [Math.min(t(o.a, o), t(o.b, o)), Math.max(t(o.a, o), t(o.b, o))];
      const [elo, ehi] = [Math.min(t(e.a, o), t(e.b, o)), Math.max(t(e.a, o), t(e.b, o))];
      return elo <= hi + 1e-6 && ehi >= lo - 1e-6;
    });
    if (!host) {
      ent.push({ ...e });
      continue;
    }
    const hd: XY = [(host.b[0] - host.a[0]) / host.width, (host.b[1] - host.a[1]) / host.width];
    const ts = [host.a, host.b, e.a, e.b].map((p) => (p[0] - host.a[0]) * hd[0] + (p[1] - host.a[1]) * hd[1]);
    const lo = Math.min(...ts);
    const hi = Math.max(...ts);
    const a: XY = [host.a[0] + hd[0] * lo, host.a[1] + hd[1] * lo];
    const b: XY = [host.a[0] + hd[0] * hi, host.a[1] + hd[1] * hi];
    const width = hi - lo;
    const leaf: XY = [a[0] + host.toward[0] * width, a[1] + host.toward[1] * width];
    Object.assign(host, { a, b, width, leaf, sweep: sweepOf(a, b, leaf), room: host.room === e.room ? host.room : `${host.room}+${e.room}` });
  }
  return [...inner, ...ent];
}

export const drawnWidth = (entrance: boolean, opening: number, widths: { door: number; entrance: number } = DOOR_DRAWN_M): number =>
  Math.min(opening, entrance ? widths.entrance : widths.door);

export function drawnDoor(d: DoorMark, widths: { door: number; entrance: number } = DOOR_DRAWN_M): DoorMark {
  const w = drawnWidth(d.entrance, d.width, widths);
  if (d.width < EPS || Math.abs(w - d.width) < EPS) return d;
  const t: XY = [(d.b[0] - d.a[0]) / d.width, (d.b[1] - d.a[1]) / d.width];
  const m: XY = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
  const a: XY = [m[0] - (t[0] * w) / 2, m[1] - (t[1] * w) / 2];
  const b: XY = [m[0] + (t[0] * w) / 2, m[1] + (t[1] * w) / 2];
  const leaf: XY = [a[0] + d.toward[0] * w, a[1] + d.toward[1] * w];
  return { ...d, a, b, leaf, sweep: sweepOf(a, b, leaf), width: w };
}

/** Every door of a plan as the studio draws it: the openings joined (`doorsToDraw`), each at its drawn width. */
export const drawnDoors = (d: Placed, widths: { door: number; entrance: number } = DOOR_DRAWN_M): DoorMark[] =>
  doorsToDraw(planDoors(d)).map((x) => drawnDoor(x, widths));
