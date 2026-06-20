import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      lib: {
        entry: resolve(__dirname, "frontend/src/main/main.ts"),
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      lib: {
        entry: resolve(__dirname, "frontend/src/main/preload.ts"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "frontend/src/renderer"),
    build: {
      outDir: resolve(__dirname, "out/renderer"),
      rollupOptions: {
        input: {
          index: resolve(__dirname, "frontend/src/renderer/index.html"),
          detail: resolve(__dirname, "frontend/src/renderer/detail.html"),
        },
      },
    },
    server: {
      proxy: {
        "/api": {
          target: process.env.VITE_BACKEND_PORT
            ? `http://127.0.0.1:${process.env.VITE_BACKEND_PORT}`
            : "http://127.0.0.1:7777",
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/api/, ""),
        },
      },
    },
    plugins: [
      react(),
    ],
  },
});
