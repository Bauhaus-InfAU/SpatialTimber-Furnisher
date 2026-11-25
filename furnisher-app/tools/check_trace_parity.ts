// An archive layout opened in Trace & Furnish sends the very same request as the archive tab (and the CLI):
// archiveLayoutRooms → drawn rooms (y negated for the canvas) → buildApartmentRequest (y negated back) must equal the
// exported request (rooms: name, polygon, windows, subtype, open; door points in order; aptType), for every layout;
// on a sample the furnish results are compared too (JSON identical) and the apartment scores.
// Run from furnisher-app: node tools/run_check_archive_parity.mjs --trace [N]
import fs from "node:fs";
import path from "node:path";
import { furnishApartment } from "../../furnisher-engine/src/engine/apartment";
import { archiveLayoutRooms, buildApartmentRequest, apartmentScore } from "../src/apartmentFurnish";
import { composerScore } from "../src/archive/types";
import type { ArchiveIndex, ArchiveLayout } from "../src/archive/types";
import type { DrawnRoom } from "../src/types";

const here = process.argv[2];
const N = Number(process.argv[3] ?? 40);
const DATA = path.join(here, "public", "archive", "composer");
const log = console.log;
console.log = () => {};

const index: ArchiveIndex = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
const chunks = new Map<string, ArchiveLayout[]>();
for (const r of index.layouts) if (!chunks.has(r.chunk)) chunks.set(r.chunk, JSON.parse(fs.readFileSync(path.join(DATA, r.chunk), "utf8")).layouts);
const all = [...chunks.values()].flat();
const strip = (req: { rooms: Record<string, unknown>[]; doors?: unknown; aptType?: unknown }) => JSON.stringify({
  rooms: req.rooms.map((r) => ({ name: r.name, polygon: r.polygon, windows: r.windows ?? [], subtype: r.subtype ?? null, open: r.open ?? null })),
  doors: req.doors ?? [], aptType: req.aptType ?? null,
});
let reqEqual = 0, resEqual = 0, scoreEqual = 0, sampled = 0;
const bad: string[] = [];
all.forEach((l, i) => {
  const rooms: DrawnRoom[] = archiveLayoutRooms(l as never).map((r, k) => ({
    id: `r${k}`, type: r.type, color: "", points: r.points.map((p) => ({ x: p.x, y: -p.y })),
    doors: r.doors.map((p) => ({ x: p.x, y: -p.y })), doorOrder: r.doorOrder, windows: r.windows.map((p) => ({ x: p.x, y: -p.y })),
    subtype: r.subtype, open: r.open,
  }));
  const run = buildApartmentRequest(rooms, { flipY: true, aptType: l.request.aptType ?? null, flexibleKitchen: false });
  if (strip(run.request as never) === strip(l.request as never)) reqEqual++;
  else bad.push(l.id);
  if (N > 0 && i % Math.max(1, Math.floor(all.length / N)) === 0) {
    sampled++;
    const a = furnishApartment(run.request);
    const b = furnishApartment(l.request);
    if (JSON.stringify(a) === JSON.stringify(b)) resEqual++;
    else bad.push(`${l.id} result`);
    if (apartmentScore(run, a).score === composerScore(l.request, b).score) scoreEqual++;
    else bad.push(`${l.id} score ${apartmentScore(run, a).score} vs ${composerScore(l.request, b).score}`);
  }
});
log(JSON.stringify({ layouts: all.length, request_equal: reqEqual, sampled, result_json_equal: resEqual, apartment_score_equal: scoreEqual, bad: bad.slice(0, 20) }, null, 1));
process.exitCode = bad.length ? 1 : 0;
