import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    // Only tests/unit/security.test.ts runs tests concurrently: ~400 runs, each mostly waiting on
    // loopback I/O and timers.
    maxConcurrency: 10,
    // Sealed against the network for every file in the suite; see the guard's docstring.
    setupFiles: ["./tests/support/no_network.ts"],
  },
});
