import { defineConfig } from "vitest/config";

// Enable fast-check verbose failure reporting (prints the seed + counterexample on failure)
// by setting FC_VERBOSE=1 when running tests. Vitest will otherwise run fast-check with defaults.
process.env.FC_VERBOSE = process.env.FC_VERBOSE ?? "1";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/app/__tests__/**/*.test.ts", "src/app/__tests__/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    reporters: "default",
  },
});
