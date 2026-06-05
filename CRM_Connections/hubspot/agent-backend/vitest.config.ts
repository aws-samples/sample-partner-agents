// Vitest configuration for the AWS Partner Central Agent backend package.
// Independent of `backend/`. Tests run in Node.js (no DOM) and exercise
// the handler wrappers, core orchestration, and lib/* modules against
// mocked HTTPS responses + Secrets Manager.
import { defineConfig } from "vitest/config";

process.env.FC_VERBOSE = process.env.FC_VERBOSE ?? "1";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["__tests__/**/*.test.ts"],
    reporters: "default",
  },
});
