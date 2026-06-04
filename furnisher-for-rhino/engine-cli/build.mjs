// Bundles the TypeScript furnisher-engine + this CLI into a single self-contained
// CommonJS file that the Grasshopper plugin can run with `node furnisher-cli.cjs`.
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

await build({
  entryPoints: [resolve(here, "src/cli.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: resolve(here, "dist/furnisher-cli.cjs"),
  plugins: [rawMarkdownPlugin],
  loader: { ".json": "json" },
  logLevel: "info",
});

console.log("Built dist/furnisher-cli.cjs");
