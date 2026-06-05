import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/app/__tests__/**/*.test.ts", "src/app/__tests__/**/*.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    reporters: "default",
  },
});
