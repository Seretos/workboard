import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["@testing-library/jest-dom/vitest"],
    include: ["frontend/src/**/*.test.{ts,tsx}"],
    // Default environment is node (for main/preload tests).
    // Renderer tests that need DOM APIs (React Testing Library etc.) must opt in
    // per-file by adding the directive:  // @vitest-environment jsdom
    environment: "node",
  },
});
