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

const rejections: [string, unknown, RegExp?][] = [
  ["null config", null],
  ["no routes", config({ routes: {} })],
  ["routes not an object", config({ routes: [] })],
  ["empty apiKey", config({ apiKey: "" })],
  ["apiKey with whitespace", config({ apiKey: "a b" })],
  ["apiKey with control char", config({ apiKey: "ab\u0000c" })],
  ["apiKey not a string", config({ apiKey: 5 })],
  ["empty connectionCode", config({ connectionCode: "" })],
  ["apiUrl ftp", config({ apiUrl: "ftp://x.com" })],
  ["apiUrl garbage", config({ apiUrl: "not a url" })],
  ["apiUrl userinfo", config({ apiUrl: "https://u:p@x.com" })],
  ["apiUrl query", config({ apiUrl: "https://x.com?a=1" })],
  ["apiUrl fragment", config({ apiUrl: "https://x.com#a" })],
  ["origin path", config({ origin: "https://x.com/api" })],
  ["origin query", config({ origin: "https://x.com?a=1" })],
  ["origin empty query", config({ origin: "https://x.com/?" })],
  ["origin fragment", config({ origin: "https://x.com#a" })],
  ["origin http non-loopback", config({ origin: "http://x.com" })],
  ["origin userinfo", config({ origin: "https://u@x.com" })],
  ["origin not a string", config({ origin: 1 })],
  ["origin with space", config({ origin: "https://x .com" })],
  ["statement empty", config({ signInStatement: "" })],
  ["statement newline", config({ signInStatement: "a\nb" })],
  ["statement U+2028", config({ signInStatement: "a\u2028b" })],
  ["statement control", config({ signInStatement: "a\u0007b" })],
  ["statement 257 bytes", config({ signInStatement: "a".repeat(257) })],
  ["statement 65 four-byte chars", config({ signInStatement: "\u{1F600}".repeat(65) })],
  ["timeout zero", config({ timeouts: { eventMs: 0 } })],
  ["timeout fractional", config({ timeouts: { eventMs: 1.5 } })],
  ["timeout infinite", config({ timeouts: { gateCheckMs: Infinity } })],
  ["route name with space", config({ routes: { "a b": route() } })],
  ["route name too long", config({ routes: { ["a".repeat(65)]: route() } })],
  ["route not an object", config({ routes: { generate: 1 } })],
  ["empty billableMetric", config({}, { billableMetric: "" })],
  ["empty planCode", config({}, { planCode: "" })],
  ["empty walletCode", config({}, { walletCode: "" })],
  ["topUp missing", config({}, { topUpAmountCents: undefined })],
  ["topUp zero", config({}, { topUpAmountCents: 0 })],
  ["topUp negative", config({}, { topUpAmountCents: -5 })],
  ["topUp fractional", config({}, { topUpAmountCents: 1.5 })],
  ["topUp above 2^53-1", config({}, { topUpAmountCents: 2 ** 53 })],
  ["topUp string", config({}, { topUpAmountCents: "500" })],
  ["cost missing", config({}, { estimatedCallCostCents: undefined })],
  ["cost zero", config({}, { estimatedCallCostCents: 0 })],
  ["cost fractional", config({}, { estimatedCallCostCents: 0.5 })],
  ["cost above 2^53-1", config({}, { estimatedCallCostCents: 2 ** 53 })],
  ["wallet missing", config({}, { wallet: undefined })],
  ["wallet name empty", config({}, { wallet: { name: "", rateAmount: "1" } })],
  ["rate 0", config({}, { wallet: { name: "w", rateAmount: "0" } })],
  ["rate 0.00000", config({}, { wallet: { name: "w", rateAmount: "0.00000" } })],
  ["rate -1", config({}, { wallet: { name: "w", rateAmount: "-1" } })],
  ["rate abc", config({}, { wallet: { name: "w", rateAmount: "abc" } })],
  ["rate 6 decimals", config({}, { wallet: { name: "w", rateAmount: "0.000001" } })],
  ["rate number", config({}, { wallet: { name: "w", rateAmount: 1 } })],
  ["min zero", config({}, { wallet: { name: "w", rateAmount: "1", paidTopUpMinAmountCents: 0 } })],
  ["max negative", config({}, { wallet: { name: "w", rateAmount: "1", paidTopUpMaxAmountCents: -1 } })],
  [
    "min > max",
    config(
      {},
      { wallet: { name: "w", rateAmount: "1", paidTopUpMinAmountCents: 9, paidTopUpMaxAmountCents: 8 } },
    ),
  ],
  ["topUp > max", config({}, { wallet: { name: "w", rateAmount: "1", paidTopUpMaxAmountCents: 499 } })],
  ["resource description number", config({}, { resource: { description: 1 } })],
  ["resource tags not array", config({}, { resource: { tags: "a" } })],
  ["resource tags non-string", config({}, { resource: { tags: [1] } })],
  ["discoverable without discovery", config({}, { discoverable: true })],
  ["discoverable non-boolean", config({}, { discoverable: "yes" })],
];

describe("validateConfig: rejections", () => {
  it.each(rejections)("rejects %s", (_name, input) => {
    const err = thrown(input);
    expect(err.message).not.toContain(API_KEY);
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
