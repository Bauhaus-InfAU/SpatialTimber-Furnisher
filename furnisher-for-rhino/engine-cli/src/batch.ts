// ─── Furnisher batch runner ──────────────────────────────────────────────────
//
// Runs the furnisher engine over a JSONL dataset of apartment requests and
// writes one JSONL result row per request. For dataset sweeps / evaluation.
//
// Usage:
//   node furnisher-batch.cjs <requests.jsonl> <results.jsonl> [--limit N] [--offset N] [--geometry]

// The engine emits many `[placer] ...` debug lines via console.log. Silence
// them so a large sweep isn't drowned in debug output.
console.log = () => {};
console.debug = () => {};
console.info = () => {};

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { processRequest, apartmentOf } from "./core";
import type { RoomInput } from "./core";

// ─── Wire shapes ─────────────────────────────────────────────────────────────

// `subtype` / `open` (open-kitchen detection) and `area` (the weight in the
// apartment score) travel inside RoomInput.
type BatchRoomInput = RoomInput;

interface BatchRequest {
  id: string;
  apartment_id?: string;
  rooms: BatchRoomInput[];
  doors?: [number, number][];
  aptType?: number;
  flexibleKitchen?: boolean;
}

// ─── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let limit = Infinity;
  let offset = 0;
  let geometry = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      limit = Number(argv[++i]);
      if (!Number.isFinite(limit) || limit < 0) fatal(`Invalid --limit value: ${argv[i]}`);
    } else if (a === "--offset") {
      offset = Number(argv[++i]);
      if (!Number.isFinite(offset) || offset < 0) fatal(`Invalid --offset value: ${argv[i]}`);
    } else if (a === "--geometry") {
      geometry = true;
    } else if (a.startsWith("--")) {
      fatal(`Unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length !== 2) {
    fatal("Usage: node furnisher-batch.cjs <requests.jsonl> <results.jsonl> [--limit N] [--offset N] [--geometry]");
  }

  return { input: positional[0], output: positional[1], limit, offset, geometry };
}

function fatal(msg: string): never {
  process.stderr.write(`[batch] fatal: ${msg}\n`);
  process.exit(1);
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Retry perturbations ─────────────────────────────────────────────────────
//
// polygon-clipping occasionally throws "Unable to complete output ring ..." on
// near-degenerate inputs. A tiny rotation or jitter of the whole apartment
// usually sidesteps the numerical failure. Rooms are independent in the engine,
// so we retry the whole request and merge per room: each room keeps the first
// attempt in which it succeeded. Scores from a rotated retry are computed in a
// slightly rotated frame — acceptable; the `recovered` field records it.

type Pt = [number, number];

function rotate(p: Pt, deg: number): Pt {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [p[0] * cos - p[1] * sin, p[0] * sin + p[1] * cos];
}

function round3(p: Pt): Pt {
  return [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
}

/** Attempt 1: rotate +0.7° around the origin, round to 3 decimals. */
function perturbRotate(p: Pt): Pt {
  return round3(rotate(p, 0.7));
}

/** Attempt 2: deterministic jitter, no rounding. */
function perturbJitter(p: Pt): Pt {
  return [p[0] + 0.0007, p[1] - 0.0007];
}

/** Apply a point transform to every coordinate of the request (polygons, windows, doors).
 *  Room flags (name, subtype, open) and request flags are carried over unchanged;
 *  open-kitchen segments are re-detected from the perturbed polygons. */
function perturbRequest(req: BatchRequest, f: (p: Pt) => Pt) {
  return {
    rooms: req.rooms.map(r => ({
      ...r,
      polygon: r.polygon.map(p => f(p as Pt)),
      ...(r.windows ? { windows: r.windows.map(p => f(p as Pt)) } : {}),
    })),
    doors: req.doors?.map(d => f(d)),
    aptType: req.aptType,
    flexibleKitchen: req.flexibleKitchen,
  };
}

const RETRY_PERTURBATIONS: ((p: Pt) => Pt)[] = [perturbRotate, perturbJitter];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { input, output, limit, offset, geometry } = parseArgs(process.argv.slice(2));

  const inStream = createReadStream(input, { encoding: "utf8" });
  inStream.on("error", (err) => fatal(`cannot read ${input}: ${err.message}`));

  const outStream = createWriteStream(output, { encoding: "utf8" });
  outStream.on("error", (err) => fatal(`cannot write ${output}: ${err.message}`));

  const rl = createInterface({ input: inStream, crlfDelay: Infinity });

  const startedAt = Date.now();
  const elapsedTimes: number[] = [];
  let seen = 0;      // non-blank request lines encountered (for --offset)
  let processed = 0; // requests actually run
  let errors = 0;    // fatal per-request errors (whole apartment failed to run)
  let aptFullyOk = 0;
  let aptPartiallyFailed = 0;
  let aptFullyFailed = 0;
  let roomsRecovered = 0;

  const writeRow = (row: unknown) => {
    outStream.write(JSON.stringify(row) + "\n");
  };

  const progress = () => {
    const rate = processed / Math.max(1e-9, (Date.now() - startedAt) / 1000);
    process.stderr.write(`[batch] ${processed} done, ${errors} errors, ${rate.toFixed(1)} apt/s\n`);
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    seen++;
    if (seen <= offset) continue;
    if (processed >= limit) break;

    let id: string | undefined;
    let apartment_id: string | undefined;
    const t0 = Date.now();
    try {
      const req: BatchRequest = JSON.parse(trimmed);
      id = req.id;
      apartment_id = req.apartment_id;

      // Attempt 0: original request. aptType only depends on room names, so
      // the value from attempt 0 stays valid across retries.
      const res0 = processRequest({
        rooms: req.rooms, doors: req.doors, aptType: req.aptType, flexibleKitchen: req.flexibleKitchen,
      });

      // Retry ladder: on per-room errors, re-run the whole request with small
      // perturbations and keep, per room, the first attempt that succeeded.
      // An open kitchen and the living room(s) across its opening depend on
      // each other (bar stools reserved in the living room), so they form one
      // group: if any member failed, the whole group is taken from the first
      // retry in which every member succeeded.
      const merged = res0.rooms.map(room => ({ room, recovered: 0 }));
      const groupOf = res0.rooms.map((_, i) => {
        const g = new Set<number>([i]);
        for (let grew = true; grew;) {
          grew = false;
          for (const j of [...g]) {
            for (const k of res0.rooms[j].openRooms ?? []) if (!g.has(k)) { g.add(k); grew = true; }
          }
        }
        return [...g].sort((a, b) => a - b);
      });
      for (let attempt = 1; attempt <= RETRY_PERTURBATIONS.length; attempt++) {
        if (!merged.some(m => m.room.error)) break;
        try {
          const resA = processRequest(perturbRequest(req, RETRY_PERTURBATIONS[attempt - 1]));
          const done = new Set<number>();
          resA.rooms.forEach((_, i) => {
            if (done.has(i)) return;
            const g = groupOf[i];
            g.forEach(j => done.add(j));
            if (!g.some(j => merged[j].room.error)) return;
            if (g.some(j => resA.rooms[j]?.error)) return;
            for (const j of g) merged[j] = { room: resA.rooms[j], recovered: attempt };
          });
        } catch {
          // A retry attempt failing wholesale just means no rescue this round.
        }
      }

      const elapsedMs = Date.now() - t0;
      elapsedTimes.push(elapsedMs);

      const failedRooms = merged.filter(m => m.room.error).length;
      roomsRecovered += merged.filter(m => m.recovered > 0).length;
      if (failedRooms === 0) aptFullyOk++;
      else if (failedRooms === merged.length) aptFullyFailed++;
      else aptPartiallyFailed++;

      // processRequest preserves room order — zip by index to echo metadata.
      const rooms = merged.map(({ room, recovered }, i) => {
        const inRoom = req.rooms[i];
        return {
          name: room.name,
          subtype: inRoom?.subtype,
          area: inRoom?.area,
          score: room.score,
          furnished: room.furnished,
          warnings: room.warnings,
          ...(room.error ? { error: room.error } : {}),
          ...(recovered ? { recovered } : {}),
          ...(room.openKitchen ? { openKitchen: true } : {}),
          ...(room.fallback ? { fallback: room.fallback } : {}),
          ...(room.missingOptional ? { missingOptional: room.missingOptional } : {}),
          ...(room.overlaps ? { overlaps: room.overlaps } : {}),
          stepScores: room.stepScores,
          steps: room.steps.map(s => ({
            furnitureName: s.furnitureName,
            optionCount: s.optionCount,
            selectedVariant: s.selectedVariant,
            selectedPosition: s.selectedPosition,
            ...(s.replaces ? { replaces: s.replaces } : {}),
            ...(geometry
              ? { geometry: s.geometry, bbox: s.bbox, smallBbox: s.smallBbox }
              : {}),
          })),
          ...(geometry ? { doors: room.doors } : {}),
          ...(geometry && room.openSegments ? { openSegments: room.openSegments } : {}),
          // With --geometry the full bar; otherwise just whether there is one.
          ...(room.bar ? { bar: geometry ? room.bar : true } : {}),
        };
      });

      // After the retries: the apartment's score and whether every room counts as furnished.
      const apartment = apartmentOf(req.rooms, merged.map(m => m.room));
      writeRow({ id, apartment_id, aptType: res0.aptType, elapsedMs, apartment, rooms });
    } catch (err: any) {
      const elapsedMs = Date.now() - t0;
      elapsedTimes.push(elapsedMs);
      errors++;
      aptFullyFailed++;
      writeRow({ id, apartment_id, error: String((err && err.message) || err), elapsedMs });
    }

    processed++;
    if (processed % 25 === 0) progress();
  }

  await new Promise<void>((resolve, reject) => {
    outStream.end(() => resolve());
    outStream.on("error", reject);
  });

  const wallMs = Date.now() - startedAt;
  const mean = elapsedTimes.length
    ? elapsedTimes.reduce((a, b) => a + b, 0) / elapsedTimes.length
    : 0;
  const med = median([...elapsedTimes].sort((a, b) => a - b));
  process.stderr.write(
    `[batch] finished: ${processed} processed, ${errors} errors, ` +
    `${(wallMs / 1000).toFixed(1)}s wall, ` +
    `mean ${mean.toFixed(1)}ms / median ${med.toFixed(1)}ms per apartment\n`,
  );
  process.stderr.write(
    `[batch] apartments: ${aptFullyOk} fully ok, ${aptPartiallyFailed} partially failed, ` +
    `${aptFullyFailed} fully failed; rooms recovered by retry: ${roomsRecovered}\n`,
  );
}

main().catch((err) => fatal(err instanceof Error ? err.message : String(err)));
