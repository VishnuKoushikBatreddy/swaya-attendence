import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Component tests (tests/components/*.test.tsx) render real React trees. The
  // automatic runtime means those files don't need to import React themselves,
  // matching how Next.js compiles the app.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  test: {
    // Default to a Node environment; files that need a DOM opt in per-file with
    //   // @vitest-environment jsdom
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Integration tests that need a real MongoDB are guarded with
    // describe.skipIf(!process.env.MONGODB_URI), so the suite is green without one.
    globals: false,
  },
});
