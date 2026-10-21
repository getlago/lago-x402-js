import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateConfig, type LagoX402Config, type LagoX402Route } from "../../src/config.js";
import { LagoX402ConfigError } from "../../src/errors.js";
import { DEFAULT_SIGN_IN_STATEMENT } from "../../src/wire.js";

const API_KEY = "test-key-" + randomUUID();

function route(over: Record<string, unknown> = {}): LagoX402Route {
  return {
    billableMetric: "calls",
    planCode: "x402_plan",
    walletCode: "x402_wallet",
    topUpAmountCents: 500,
    estimatedCallCostCents: 5,
    wallet: { name: "Agent wallet", rateAmount: "0.01" },
    ...over,
  } as LagoX402Route;
}

function config(over: Record<string, unknown> = {}, routeOver: Record<string, unknown> = {}): LagoX402Config {
  return {
    apiUrl: "https://api.getlago.com",
    apiKey: API_KEY,
    connectionCode: "conn_1",
    origin: "https://api.example.com",
    routes: { generate: route(routeOver) },
    ...over,
  } as LagoX402Config;
}

function thrown(c: unknown): LagoX402ConfigError {
  try {
    validateConfig(c as LagoX402Config);
  } catch (e) {
    expect(e).toBeInstanceOf(LagoX402ConfigError);
    return e as LagoX402ConfigError;
  }
  throw new Error("expected validateConfig to throw");
}

describe("validateConfig: normalization", () => {
  it("applies defaults and normalizes", () => {
    const n = validateConfig(
      config({ apiUrl: "https://lago.example.com///", origin: "https://API.example.com/" }),
    );
    expect(n.apiUrl).toBe("https://lago.example.com");
    expect(n.origin.href).toBe("https://api.example.com/");
    expect(n.signInStatement).toBe(DEFAULT_SIGN_IN_STATEMENT);
    expect(n.timeouts).toEqual({ gateCheckMs: 5000, creditPurchaseMs: 45000, eventMs: 10000 });
    const r = n.routes.get("generate")!;
    expect(r.name).toBe("generate");
    expect(r.discoverable).toBe(false);
    expect(r.resource).toEqual({});
    expect(r.wallet).toEqual({ name: "Agent wallet", rate_amount: "0.01", currency: "USD" });
  });

  it("maps wallet limits to snake_case and passes resource through", () => {
    const n = validateConfig(
      config(
        {},
        {
          wallet: { name: "w", rateAmount: "1", paidTopUpMinAmountCents: 100, paidTopUpMaxAmountCents: 1000 },
          resource: {
            description: "d",
            mimeType: "application/json",
            tags: ["a"],
            iconUrl: "https://x/i.png",
          },
        },
      ),
    );
    const r = n.routes.get("generate")!;
    expect(r.wallet).toEqual({
      name: "w",
      rate_amount: "1",
      currency: "USD",
      paid_top_up_min_amount_cents: 100,
      paid_top_up_max_amount_cents: 1000,
    });
    expect(r.resource.tags).toEqual(["a"]);
  });

  it("accepts overrides, loopback http and a discovery object", () => {
    const n = validateConfig(
      config(
        {
          origin: "http://localhost:3000",
          apiUrl: "http://localhost:3000",
          timeouts: { gateCheckMs: 1 },
          signInStatement: "Hi \u{1F600}",
        },
        { discoverable: true, discovery: { a: 1 } },
      ),
    );
    expect(n.timeouts.gateCheckMs).toBe(1);
    expect(n.timeouts.eventMs).toBe(10000);
    expect(n.routes.get("generate")!.discovery).toEqual({ a: 1 });
    for (const o of ["http://127.0.0.1:8080", "http://[::1]:8080"]) {
      expect(() => validateConfig(config({ origin: o }))).not.toThrow();
    }
  });

  it("is not affected by later mutation of the caller's object", () => {
    const c = config();
    const n = validateConfig(c);
    (c.routes.generate as { topUpAmountCents: number }).topUpAmountCents = 1;
    c.routes.other = route();
    expect(n.routes.get("generate")!.topUpAmountCents).toBe(500);
    expect(n.routes.has("other")).toBe(false);
    expect(Object.isFrozen(n)).toBe(true);
    expect(Object.isFrozen(n.routes.get("generate"))).toBe(true);
  });
});

const rejections: [name: string, input: unknown, route: string | null, reason: string][] = [
  ["null config", null, null, "config must be an object"],
  ["no routes", config({ routes: {} }), null, "at least one route"],
  ["routes not an object", config({ routes: [] }), null, "routes must be an object"],
  ["empty apiKey", config({ apiKey: "" }), null, "apiKey is invalid"],
  ["apiKey with space", config({ apiKey: "a b" }), null, "apiKey is invalid"],
  ["apiKey trailing space", config({ apiKey: API_KEY + " " }), null, "apiKey is invalid"],
  ["apiKey with control char", config({ apiKey: "ab\u0000c" }), null, "apiKey is invalid"],
  ["apiKey with NBSP", config({ apiKey: "ab\u00a0c" }), null, "apiKey is invalid"],
  ["apiKey with U+2028", config({ apiKey: "ab\u2028c" }), null, "apiKey is invalid"],
  ["apiKey with zero-width space", config({ apiKey: "ab\u200bc" }), null, "apiKey is invalid"],
  ["apiKey with BOM", config({ apiKey: "\ufeffabc" }), null, "apiKey is invalid"],
  ["apiKey not a string", config({ apiKey: 5 }), null, "apiKey is invalid"],
  ["empty connectionCode", config({ connectionCode: "" }), null, "connectionCode"],
  ["apiUrl ftp", config({ apiUrl: "ftp://x.com" }), null, "apiUrl"],
  ["apiUrl garbage", config({ apiUrl: "not a url" }), null, "apiUrl"],
  ["apiUrl userinfo", config({ apiUrl: "https://u:p@x.com" }), null, "apiUrl"],
  ["apiUrl query", config({ apiUrl: "https://x.com?a=1" }), null, "apiUrl"],
  ["apiUrl fragment", config({ apiUrl: "https://x.com#a" }), null, "apiUrl"],
  ["origin path", config({ origin: "https://x.com/api" }), null, "origin must be"],
  ["origin query", config({ origin: "https://x.com?a=1" }), null, "origin must be"],
  ["origin empty query", config({ origin: "https://x.com/?" }), null, "origin must be"],
  ["origin fragment", config({ origin: "https://x.com#a" }), null, "origin must be"],
  ["origin http non-loopback", config({ origin: "http://x.com" }), null, "origin must be"],
  ["origin userinfo", config({ origin: "https://u@x.com" }), null, "origin must be"],
  ["origin not a string", config({ origin: 1 }), null, "origin must be"],
  ["origin with space", config({ origin: "https://x .com" }), null, "origin must be"],
  ["statement empty", config({ signInStatement: "" }), null, "signInStatement"],
  ["statement newline", config({ signInStatement: "a\nb" }), null, "signInStatement"],
  ["statement U+2028", config({ signInStatement: "a\u2028b" }), null, "signInStatement"],
  ["statement control", config({ signInStatement: "a\u0007b" }), null, "signInStatement"],
  ["statement 257 bytes", config({ signInStatement: "a".repeat(257) }), null, "signInStatement"],
  [
    "statement 65 four-byte chars",
    config({ signInStatement: "\u{1F600}".repeat(65) }),
    null,
    "signInStatement",
  ],
  ["timeout zero", config({ timeouts: { eventMs: 0 } }), null, "timeouts.eventMs"],
  ["timeout fractional", config({ timeouts: { eventMs: 1.5 } }), null, "timeouts.eventMs"],
  ["timeout infinite", config({ timeouts: { gateCheckMs: Infinity } }), null, "timeouts.gateCheckMs"],
  [
    "timeout above setTimeout max",
    config({ timeouts: { creditPurchaseMs: 2147483648 } }),
    null,
    "timeouts.creditPurchaseMs",
  ],
  ["route name with space", config({ routes: { "a b": route() } }), null, "route names must match"],
  ["route name too long", config({ routes: { ["a".repeat(65)]: route() } }), null, "route names must match"],
  ["route not an object", config({ routes: { generate: 1 } }), "generate", "route must be an object"],
  ["empty billableMetric", config({}, { billableMetric: "" }), "generate", "billableMetric"],
  ["empty planCode", config({}, { planCode: "" }), "generate", "planCode"],
  ["empty walletCode", config({}, { walletCode: "" }), "generate", "walletCode"],
  ["topUp missing", config({}, { topUpAmountCents: undefined }), "generate", "topUpAmountCents must be"],
  ["topUp zero", config({}, { topUpAmountCents: 0 }), "generate", "topUpAmountCents must be"],
  ["topUp negative", config({}, { topUpAmountCents: -5 }), "generate", "topUpAmountCents must be"],
  ["topUp fractional", config({}, { topUpAmountCents: 1.5 }), "generate", "topUpAmountCents must be"],
  ["topUp above 2^53-1", config({}, { topUpAmountCents: 2 ** 53 }), "generate", "topUpAmountCents must be"],
  ["topUp string", config({}, { topUpAmountCents: "500" }), "generate", "topUpAmountCents must be"],
  ["cost missing", config({}, { estimatedCallCostCents: undefined }), "generate", "estimatedCallCostCents"],
  ["cost zero", config({}, { estimatedCallCostCents: 0 }), "generate", "estimatedCallCostCents"],
  ["cost fractional", config({}, { estimatedCallCostCents: 0.5 }), "generate", "estimatedCallCostCents"],
  [
    "cost above 2^53-1",
    config({}, { estimatedCallCostCents: 2 ** 53 }),
    "generate",
    "estimatedCallCostCents",
  ],
  ["wallet missing", config({}, { wallet: undefined }), "generate", "wallet must be an object"],
  ["wallet name empty", config({}, { wallet: { name: "", rateAmount: "1" } }), "generate", "wallet.name"],
  ["rate 0", config({}, { wallet: { name: "w", rateAmount: "0" } }), "generate", "wallet.rateAmount"],
  [
    "rate 0.00000",
    config({}, { wallet: { name: "w", rateAmount: "0.00000" } }),
    "generate",
    "wallet.rateAmount",
  ],
  ["rate -1", config({}, { wallet: { name: "w", rateAmount: "-1" } }), "generate", "wallet.rateAmount"],
  ["rate abc", config({}, { wallet: { name: "w", rateAmount: "abc" } }), "generate", "wallet.rateAmount"],
  [
    "rate 6 decimals",
    config({}, { wallet: { name: "w", rateAmount: "0.000001" } }),
    "generate",
    "wallet.rateAmount",
  ],
  ["rate number", config({}, { wallet: { name: "w", rateAmount: 1 } }), "generate", "wallet.rateAmount"],
  [
    "min zero",
    config({}, { wallet: { name: "w", rateAmount: "1", paidTopUpMinAmountCents: 0 } }),
    "generate",
    "paidTopUpMinAmountCents must be a positive",
  ],
  [
    "max negative",
    config({}, { wallet: { name: "w", rateAmount: "1", paidTopUpMaxAmountCents: -1 } }),
    "generate",
    "paidTopUpMaxAmountCents must be a positive",
  ],
  [
    "min > max (topUp within max)",
    config(
      {},
      {
        topUpAmountCents: 5,
        wallet: { name: "w", rateAmount: "1", paidTopUpMinAmountCents: 9, paidTopUpMaxAmountCents: 8 },
      },
    ),
    "generate",
    "must not exceed paidTopUpMaxAmountCents",
  ],
  [
    "topUp > max",
    config({}, { wallet: { name: "w", rateAmount: "1", paidTopUpMaxAmountCents: 499 } }),
    "generate",
    "topUpAmountCents must not exceed",
  ],
  [
    "resource description number",
    config({}, { resource: { description: 1 } }),
    "generate",
    "resource.description",
  ],
  ["resource tags not array", config({}, { resource: { tags: "a" } }), "generate", "resource.tags"],
  ["resource tags non-string", config({}, { resource: { tags: [1] } }), "generate", "resource.tags"],
  ["discoverable without discovery", config({}, { discoverable: true }), "generate", "require a discovery"],
  [
    "discoverable non-boolean",
    config({}, { discoverable: "yes" }),
    "generate",
    "discoverable must be a boolean",
  ],
];

describe("validateConfig: rejections", () => {
  it.each(rejections)("rejects %s", (_name, input, route, reason) => {
    const err = thrown(input);
    expect(err.route).toBe(route);
    expect(err.reason).toContain(reason);
    expect(err.message).not.toContain(API_KEY);
  });

  it("uses the constant apiKey message whatever the key", () => {
    for (const key of [API_KEY + " ", "a" + "\u00a0" + "b"]) {
      expect(thrown(config({ apiKey: key })).reason).toBe("apiKey is invalid");
    }
  });

  it("names the route for route errors and not for global ones", () => {
    expect(thrown(config({}, { topUpAmountCents: 0 })).route).toBe("generate");
    expect(thrown(config({}, { topUpAmountCents: 0 })).message).toContain('"generate"');
    expect(thrown(config({ connectionCode: "" })).route).toBeNull();
  });

  it("the message never contains apiKey", () => {
    for (const key of [API_KEY + " x", "bad\u0000" + API_KEY, ""]) {
      const err = thrown(config({ apiKey: key }));
      expect(err.message).not.toContain(API_KEY);
      expect(err.reason).toBe("apiKey is invalid");
    }
    expect(thrown(config({ connectionCode: "" }, {})).message).not.toContain(API_KEY);
  });
});
