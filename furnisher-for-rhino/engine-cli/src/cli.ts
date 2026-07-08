// ─── Furnisher CLI ──────────────────────────────────────────────────────────
//
// Headless bridge between the Grasshopper plugin and the TypeScript furnisher
// engine. Reads ONE JSON request on stdin, runs the engine, writes ONE JSON
// response on stdout. All geometry is in metres, the engine's native unit.

// The engine emits many `[placer] ...` debug lines via console.log. stdout is
// our JSON channel, and a flood of these on stderr can fill the OS pipe buffer
// and stall the parent process, so we silence them entirely.
console.log = () => {};
console.debug = () => {};
console.info = () => {};

import { processRequest, Request } from "./core";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

(async () => {
  try {
    const raw = await readStdin();
    const req: Request = JSON.parse(raw.replace(/^﻿/, ""));
    const out = processRequest(req);
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    );
    process.exitCode = 1;
  }
})();
