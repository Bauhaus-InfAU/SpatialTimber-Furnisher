import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@engine": path.resolve(__dirname, "../furnisher-engine/src/engine"),
      "@layout": path.resolve(__dirname, "../furnisher-engine/src/layout"),
      "@library": path.resolve(__dirname, "../furnisher-engine/src/library"),
    },
  },
  server: {
    fs: {
      allow: [
        path.resolve(__dirname),
        path.resolve(__dirname, "../furnisher-engine/src"),
      ],
    },
  },
});
