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
import { processRequest, RoomInput } from "./core";

// ─── Wire shapes ─────────────────────────────────────────────────────────────

type BatchRoomInput = RoomInput & { area?: number; subtype?: string };

interface BatchRequest {
  id: string;
  apartment_id?: string;
  rooms: BatchRoomInput[];
  doors?: [number, number][];
  aptType?: number;
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

/** Apply a point transform to every coordinate of the request (polygons, windows, doors). */
function perturbRequest(req: BatchRequest, f: (p: Pt) => Pt) {
  return {
    rooms: req.rooms.map(r => ({
      ...r,
      polygon: r.polygon.map(p => f(p as Pt)),
      ...(r.windows ? { windows: r.windows.map(p => f(p as Pt)) } : {}),
    })),
    doors: req.doors?.map(d => f(d)),
    aptType: req.aptType,
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
      const res0 = processRequest({ rooms: req.rooms, doors: req.doors, aptType: req.aptType });

      // Retry ladder: on per-room errors, re-run the whole request with small
      // perturbations and keep, per room, the first attempt that succeeded.
      const merged = res0.rooms.map(room => ({ room, recovered: 0 }));
      for (let attempt = 1; attempt <= RETRY_PERTURBATIONS.length; attempt++) {
        if (!merged.some(m => m.room.error)) break;
        try {
          const resA = processRequest(perturbRequest(req, RETRY_PERTURBATIONS[attempt - 1]));
          resA.rooms.forEach((room, i) => {
            if (merged[i].room.error && !room.error) {
              merged[i] = { room, recovered: attempt };
            }
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
          warnings: room.warnings,
          ...(room.error ? { error: room.error } : {}),
          ...(recovered ? { recovered } : {}),
          stepScores: room.stepScores,
          steps: room.steps.map(s => ({
            furnitureName: s.furnitureName,
            optionCount: s.optionCount,
            selectedVariant: s.selectedVariant,
            selectedPosition: s.selectedPosition,
            ...(geometry
              ? { geometry: s.geometry, bbox: s.bbox, smallBbox: s.smallBbox }
              : {}),
          })),
          ...(geometry ? { doors: room.doors } : {}),
        };
      });

      writeRow({ id, apartment_id, aptType: res0.aptType, elapsedMs, rooms });
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
