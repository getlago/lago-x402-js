import { defineConfig } from "vitest/config";

/** `npm run test:next`: the Next.js adapter in a real `next build && next start` (after
 * `npm run build`, since the fixture imports the built package). */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    // `next build` runs in the suite's beforeAll.
    hookTimeout: 300_000,
    // The test process stays sealed against the network; Next runs with telemetry off.
    setupFiles: ["./tests/support/no_network.ts"],
  },
});
