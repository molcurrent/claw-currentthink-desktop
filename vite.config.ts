import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The tokenizer vocabulary is intentionally lazy-loaded as a separate chunk.
    // Its minified size is expected to exceed Vite's default 500 kB warning threshold.
    chunkSizeWarningLimit: 1200,
  },
});
