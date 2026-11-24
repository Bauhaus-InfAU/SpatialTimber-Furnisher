// ─── The app and the CLI furnish a room the same way ─────────────────────────
//
// Runs every room of test/cases.json (one-room requests taken from real
// apartments) twice:
//   app: the engine as the app calls it (furnishRoom with the options the app
//        builds from its default settings, then runRoomPipelineAt at the chosen
//        selection, scoreFurnishedRoom);
//   cli: the built dist/furnisher-cli.cjs, as Rhino and the batch runner call it.
// and checks that both give the same pieces, the same number of options per
// step, the same placed geometry, the same fallback and the same room score.
// Each case may also state what it expects (expect.pieces, expect.fallback).
//
// Run: npm test (builds dist first: npm run build).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { furnishRoom, runRoomPipelineAt, scoreFurnishedRoom } from "../../../furnisher-engine/src/engine/index";
import type { FurnishOptions } from "../../../furnisher-engine/src/engine/index";
import { defaultLibrary, defaultPipeline, defaultFallbacks } from "../../../furnisher-engine/src/library/index";
import type { Point2D, RoomName } from "../../../furnisher-engine/src/layout/types";

console.log = () => {}; // the placer's debug lines
const say = (s: string) => process.stdout.write(s + "\n");

interface Case {
  name: string;
  source: string;
  request: { rooms: { name: string; polygon: Point2D[]; windows?: Point2D[] }[]; doors: Point2D[]; aptType: number };
  expect?: { pieces?: string[]; fallback?: string | null; furnished?: boolean; score?: number };
}

const here = dirname(process.argv[2]); // test/app-and-cli.ts, passed by run.mjs
const root = resolve(here, "..");
const cases: Case[] = JSON.parse(readFileSync(resolve(root, "test/cases.json"), "utf8"));
const cli = resolve(root, "dist/furnisher-cli.cjs");

// The options the app builds from its default settings (App.tsx buildPipelineOptions).
const appOptions: FurnishOptions = {
  pipeline: { ...defaultPipeline },
  library: { ...defaultLibrary, furniture: [...defaultLibrary.furniture] },
  flexibleKitchen: false,
  fallbacks: { ...defaultFallbacks, rules: [...defaultFallbacks.rules] },
};

function signedArea(pts: Point2D[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function distToPolygon(p: Point2D, poly: Point2D[]): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    min = Math.min(min, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return min;
}

const round = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(round) : typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v;

let failed = 0;
for (const c of cases) {
  const r = c.request.rooms[0];
  // The room as the app hands it to the engine: counter-clockwise, its doors.
  const polygon = signedArea(r.polygon) < 0 ? [...r.polygon].reverse() : r.polygon;
  const doors = c.request.doors.filter(d => distToPolygon(d, polygon) <= 0.4);
  const name = (/^children$/i.test(r.name) ? "Children 1" : r.name) as RoomName; // as the app names its first children's room
  const room = { name, polygon, ...(doors.length ? { doors } : {}), ...(r.windows?.length ? { windows: r.windows } : {}) };

  const f = furnishRoom(room, c.request.aptType, appOptions);
  const app = runRoomPipelineAt(room, c.request.aptType, f.selection, f.options);
  const appScored = scoreFurnishedRoom(room.name, app, f.fallback, c.request.aptType, appOptions.fallbacks);
  const appScore = appScored.score;
  const appSteps = app.steps.map(s => ({
    piece: s.furnitureName, options: s.allOptions.length,
    geometry: round(s.selected ? s.selected.placed.transformedGeometry.map(g => g.points) : []),
  }));

  const out = JSON.parse(execFileSync("node", [cli], { input: JSON.stringify(c.request) }).toString());
  const cr = out.rooms[0];
  const cliSteps = cr.steps.map((s: { furnitureName: string; optionCount: number; geometry: { points: Point2D[] }[] }) => ({
    piece: s.furnitureName, options: s.optionCount, geometry: round(s.geometry.map(g => g.points)),
  }));

  const problems: string[] = [];
  if (JSON.stringify(appSteps) !== JSON.stringify(cliSteps)) problems.push("steps differ");
  if (appScore !== cr.score) problems.push(`score app ${appScore} cli ${cr.score}`);
  if (appScored.furnished !== cr.furnished) problems.push(`furnished app ${appScored.furnished} cli ${cr.furnished}`);
  if (c.expect && "furnished" in c.expect && c.expect.furnished !== cr.furnished) problems.push(`furnished ${cr.furnished}, expected ${c.expect.furnished}`);
  if (c.expect && "score" in c.expect && c.expect.score !== cr.score) problems.push(`score ${cr.score}, expected ${c.expect.score}`);
  const appFb = f.fallback?.id ?? null, cliFb = cr.fallback?.id ?? null;
  if (appFb !== cliFb) problems.push(`fallback app ${appFb} cli ${cliFb}`);
  const pieces = appSteps.map(s => s.piece);
  if (c.expect?.pieces && JSON.stringify(c.expect.pieces) !== JSON.stringify(pieces)) problems.push(`pieces ${pieces.join(",")}, expected ${c.expect.pieces.join(",")}`);
  if (c.expect && "fallback" in c.expect && c.expect.fallback !== appFb) problems.push(`fallback ${appFb}, expected ${c.expect.fallback}`);

  const line = `${c.name}: ${pieces.join(" + ")} | options ${appSteps.map(s => s.options).join("/")} | score ${appScore}${appFb ? ` | ${appFb}` : ""}${appScored.missingOptional ? ` | without ${appScored.missingOptional.pieces.map(p => p.furnitureName).join(", ")}` : ""} | furnished ${appScored.furnished}`;
  if (problems.length) { failed++; say(`FAIL ${line} | ${problems.join("; ")}`); }
  else say(`ok   ${line}`);
}
say(`${cases.length - failed} of ${cases.length} cases equal in the app and the CLI`);
process.exitCode = failed ? 1 : 0;
