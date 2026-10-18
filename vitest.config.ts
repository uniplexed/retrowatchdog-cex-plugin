import { defineConfig } from "vitest/config";

// Minimal: this package has no database, no shared external state between
// test files, and nothing to stub globally.
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
  },
});
