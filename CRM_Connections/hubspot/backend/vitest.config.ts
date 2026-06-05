// Vitest configuration for the AWS Lambda backend package.
// Tests run in Node.js (no DOM) and exercise the handler wrappers, core orchestration,
// and lib/* modules against mocked AWS SDK + HubSpot clients.
import { defineConfig } from "vitest/config";

// Enable fast-check verbose failure reporting (prints the seed + counterexample on failure)
// by setting FC_VERBOSE=1 when running tests. Vitest will otherwise run fast-check with defaults.
process.env.FC_VERBOSE = process.env.FC_VERBOSE ?? "1";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["__tests__/**/*.test.ts"],
    reporters: "default",
  },
});
