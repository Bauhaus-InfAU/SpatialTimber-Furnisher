// Parity of the app's archive path with the composer's CLI path, on exported composer layouts.
//
// For each layout: the app path (the engine's `furnishApartment`, imported from source exactly as the app's worker
// does, plus the app's `composerScore`) against `node furnisher-cli.cjs` on the same request (what the composer runs).
// Checks (1) the result JSON is byte-identical and (2) the apartment score equals the composer's own score where the
// exporter's --verify ran the studio's measure_model (verify_measure_model.json).
//
// Build + run (from furnisher-app):
//   node tools/run_check_archive_parity.mjs [N]      (N layouts spread over the dataset, default 150; 0 = all)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { furnishApartment } from "../../furnisher-engine/src/engine/apartment";
import { composerScore } from "../src/archive/types";
import type { ArchiveIndex, ArchiveLayout } from "../src/archive/types";

const here = process.argv[2];
const N = Number(process.argv[3] ?? 150);
const DATA = path.join(here, "public", "archive", "composer");
const CLI = path.join(here, "..", "furnisher-for-rhino", "engine-cli", "dist", "furnisher-cli.cjs");

const log = console.log;
console.log = () => {};
console.debug = () => {};
console.info = () => {};

const index: ArchiveIndex = JSON.parse(fs.readFileSync(path.join(DATA, "index.json"), "utf8"));
const rows = index.layouts;
const pick = N > 0 && N < rows.length ? Array.from({ length: N }, (_, i) => rows[Math.floor((i * rows.length) / N)]) : rows;
const verify: Map<string, number | null> = new Map();
try {
  const v = JSON.parse(fs.readFileSync(path.join(DATA, "verify_measure_model.json"), "utf8"));
  for (const r of v.rows) verify.set(r.id, r.measure_model_score);
} catch { /* no verify file */ }

const chunks = new Map<string, Map<string, ArchiveLayout>>();
const layoutOf = (chunk: string, id: string) => {
  if (!chunks.has(chunk)) {
    const doc = JSON.parse(fs.readFileSync(path.join(DATA, chunk), "utf8"));
    chunks.set(chunk, new Map(doc.layouts.map((l: ArchiveLayout) => [l.id, l])));
  }
  return chunks.get(chunk)!.get(id)!;
};

let identical = 0, differ = 0, scoreChecked = 0, scoreEqual = 0;
const bad: string[] = [];
const t0 = Date.now();
// the verify sample first, so every composer score is checked even with a small N
const verifyRows = rows.filter((r) => verify.has(r.id));
for (const row of [...verifyRows, ...pick.filter((r) => !verify.has(r.id))]) {
  const l = layoutOf(row.chunk, row.id);
  const app = furnishApartment(l.request);
  const appJson = JSON.stringify(app);
  const cli = spawnSync("node", [CLI], { input: JSON.stringify(l.request), encoding: "utf8", maxBuffer: 1 << 28 });
  if (cli.stdout === appJson) identical++;
  else { differ++; bad.push(row.id); }
  const v = verify.get(row.id);
  if (v !== undefined && v !== null) {
    scoreChecked++;
    const s = composerScore(l.request, app).score;
    if (Math.abs(s - v) < 1e-9) scoreEqual++;
    else bad.push(`${row.id}: app score ${s} vs composer ${v}`);
  }
}
log(JSON.stringify({ layouts: identical + differ, result_json_identical: identical, differ,
  composer_score_checked: scoreChecked, composer_score_equal: scoreEqual, seconds: Math.round((Date.now() - t0) / 1000), bad: bad.slice(0, 20) }, null, 1));
process.exitCode = differ || scoreEqual !== scoreChecked ? 1 : 0;
