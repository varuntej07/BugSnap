import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "shared")
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup/index.html"),
        capture: resolve(__dirname, "capture/index.html"),
        "background/service_worker": resolve(__dirname, "background/service_worker.ts"),
        "content/overlay": resolve(__dirname, "content/overlay.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
