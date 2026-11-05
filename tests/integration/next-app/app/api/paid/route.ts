/** The route the integration test serves with `next start`: `withLagoX402` in front of a handler
 * reporting a usage of 3, imported from the built package (`npm run build`) as an app imports
 * `lago-x402` and `lago-x402/next`. The config comes from the environment the test sets (test
 * code: the library itself reads no env). `?bytes=n` pads the body by n bytes, so the test can
 * hold the response mid-body. */
import { createLagoX402 } from "../../../../../../dist/index.js";
import { withLagoX402 } from "../../../../../../dist/next.js";

// At module scope, as an app does. `next build` evaluates this module too (collecting page
// data), where it boots against the same fake Lago.
const x402 = createLagoX402({
  apiUrl: process.env.LAGO_API_URL ?? "",
  apiKey: process.env.LAGO_API_KEY ?? "",
  connectionCode: "conn_test",
  origin: process.env.LAGO_X402_ORIGIN ?? "",
  routes: {
    paid: {
      billableMetric: "tokens",
      planCode: "agents_plan",
      walletCode: "agents_wallet",
      topUpAmountCents: 500,
      estimatedCallCostCents: 2,
      fallbackUsage: 250,
      wallet: { name: "Agent credits", rateAmount: "1" },
    },
  },
});

export const POST = withLagoX402(x402, "paid", async (req) => {
  const bytes = Number(new URL(req.url).searchParams.get("bytes") ?? 0);
  return { response: Response.json({ served: true, padding: "x".repeat(bytes) }), usage: 3 };
});
