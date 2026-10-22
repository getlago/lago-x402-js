import { defineConfig } from "vitest/config";

/** `npm run test:live`: the three legs against a real Lago on Base Sepolia (tests/live). Skipped
 * unless LAGO_API_URL, LAGO_API_KEY and X402_BUYER_EVM_PRIVATE_KEY are set. No network guard:
 * this suite talks to Lago (and, through it, to the facilitator and the chain). */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    environment: "node",
    // Waiting for Lago to refresh a wallet's ongoing balance takes minutes (LIVE_WALLET_TIMEOUT_MS).
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // One Lago, one buyer, one port: never in parallel.
    fileParallelism: false,
    // Each step and its `[live]` lines (transaction hash, fee payers, wallet movement) are the
    // run's record, so they are printed for passing tests too.
    reporters: ["verbose"],
  },
});
