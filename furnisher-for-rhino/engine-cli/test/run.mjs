// Bundles test/app-and-cli.ts (as build.mjs bundles the CLI) into the system's
// temp folder and runs it. Needs dist/ built first (npm run build).

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

const rawMarkdownPlugin = {
  name: "raw-markdown",
  setup(b) {
    b.onResolve({ filter: /\.md\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
      namespace: "raw-md",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw-md" }, (args) => ({
      contents: readFileSync(args.path, "utf8"),
      loader: "text",
    }));
  },
};

const outfile = join(tmpdir(), "furnisher-app-and-cli-test.cjs");
await build({
  entryPoints: [resolve(here, "app-and-cli.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile,
  plugins: [rawMarkdownPlugin],
  loader: { ".json": "json" },
  logLevel: "warning",
});
const r = spawnSync("node", [outfile, resolve(here, "app-and-cli.ts")], { stdio: "inherit" });
process.exitCode = r.status ?? 1;
