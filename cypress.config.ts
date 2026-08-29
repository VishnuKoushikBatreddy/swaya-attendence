import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || "http://localhost:3000",
    setupNodeEvents(on, config) {
      // hook for db cleanup if needed
      on("task", {
        log(msg) { console.log(msg); return null; },
        seed: async () => {
          const { seed } = await import("./cypress/support/seed");
          return seed();
        },
        cleanup: async () => {
          const { cleanup } = await import("./cypress/support/seed");
          return cleanup();
        },
      });
      return config;
    },
    specPattern: "cypress/e2e/**/*.cy.{ts,js}",
    supportFile: "cypress/support/e2e.ts",
  },
});
