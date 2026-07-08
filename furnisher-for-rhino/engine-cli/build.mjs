// Bundles the TypeScript furnisher-engine + this CLI into self-contained
// CommonJS files:
//   dist/furnisher-cli.cjs   — stdin/stdout bridge run by the Grasshopper plugin
//   dist/furnisher-batch.cjs — JSONL batch runner for dataset sweeps
//
// The engine's loader.ts uses Vite's `import md from "file.md?raw"` syntax to pull
// placement_order.md in as a string. esbuild doesn't understand the `?raw` suffix,
// so we add a tiny plugin that resolves `*.md?raw` to the file and loads it as text.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve `./foo.md?raw` imports to the underlying file, loaded as a UTF-8 string. */
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

const bundles = [
  { entry: "src/cli.ts",   outfile: "dist/furnisher-cli.cjs" },
  { entry: "src/batch.ts", outfile: "dist/furnisher-batch.cjs" },
];

for (const { entry, outfile } of bundles) {
  await build({
    entryPoints: [resolve(here, entry)],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    outfile: resolve(here, outfile),
    plugins: [rawMarkdownPlugin],
    loader: { ".json": "json" },
    logLevel: "info",
  });
  console.log(`Built ${outfile}`);
}
