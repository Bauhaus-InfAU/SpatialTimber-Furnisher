// Bundles tools/check_archive_parity.ts with esbuild (from furnisher-for-rhino/engine-cli's node_modules, with the
// engine's `?raw` markdown import) and runs it. Usage (from furnisher-app): node tools/run_check_archive_parity.mjs [N]
// With --trace first: tools/check_trace_parity.ts (Trace & Furnish request == archive request) instead.
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const require = createRequire(resolve(app, "..", "furnisher-for-rhino", "engine-cli", "package.json"));
const { build } = require("esbuild");
const trace = process.argv[2] === "--trace";
const args = trace ? process.argv.slice(3) : process.argv.slice(2);
const out = join(mkdtempSync(join(tmpdir(), "archive-parity-")), "check.cjs");
await build({
  entryPoints: [resolve(here, trace ? "check_trace_parity.ts" : "check_archive_parity.ts")],
  bundle: true, platform: "node",
  alias: { "@engine": resolve(app, "..", "furnisher-engine", "src", "engine"), "@layout": resolve(app, "..", "furnisher-engine", "src", "layout"), "@library": resolve(app, "..", "furnisher-engine", "src", "library") }, target: "node18", format: "cjs", outfile: out, logLevel: "warning",
  plugins: [{
    name: "raw-md",
    setup(b) {
      b.onResolve({ filter: /\.md\?raw$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.replace(/\?raw$/, "")), namespace: "raw-md" }));
      b.onLoad({ filter: /.*/, namespace: "raw-md" }, (a) => ({ contents: readFileSync(a.path, "utf8"), loader: "text" }));
    },
  }],
});
const r = spawnSync("node", [out, app, args[0] ?? (trace ? "40" : "150")], { stdio: "inherit" });
process.exit(r.status ?? 1);
