import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { checkRoute, retryDelayMs, type CheckResult } from "../../src/boot.js";
import { validateConfig, type LagoX402Config, type LagoX402Route } from "../../src/config.js";
import { LagoX402ConfigError } from "../../src/errors.js";
import type { GateOutcome, GateRequest } from "../../src/gate.js";
import * as publicApi from "../../src/index.js";
import type {
  LagoEndpoint,
  LagoX402 as PublicLagoX402,
  LagoX402Config as PublicConfig,
  LagoX402Discovery,
  LagoX402ErrorWhere,
  LagoX402Route as PublicRoute,
} from "../../src/index.js";
import { LagoClient } from "../../src/lago-client.js";
import { createLagoX402, handleRequest, hasRoute, type LagoX402 } from "../../src/x402.js";
import { startFakeLago, type FakeAnswer, type FakeLago, type FakeRoute } from "../support/fake-lago.js";
import {
  billableMetric,
  evmRequirement,
  forbidden,
  gateCheckChallenge,
  gateCheckPass,
  notFound,
  thirdPartyError,
  unauthorized,
  validationErrors,
} from "../support/fixtures.js";

/** Compile-time check that §4's public types are exported from the entry point. */
export type PublicTypes = [
  PublicLagoX402,
  PublicConfig,
  PublicRoute,
  LagoX402Discovery,
  LagoX402ErrorWhere,
  LagoEndpoint,
];

const ORIGIN = "https://api.merchant.example";
const apiKey = "test-key-" + randomUUID();
/** Leg 1's exact E7 body for the `generate` route (same bytes as in gate.test.ts). */
const E7_BODY =
  '{"gate_check":{"connection_code":"conn_test","plan_code":"agents_plan","billable_metric_code":"tokens",' +
  '"wallet_code":"agents_wallet","amount_cents":500,"estimated_call_cost_cents":2}}';
const NO_SIGN_IN = "this Lago does not support sign-in-with-x; it needs lago-api with INT-331";
const UNEXPECTED_E7 = "Lago's gate_checks answer has an unexpected shape";
/** Background retries in tests: 10 ms, 20 ms, 40 ms, … */
const FAST = { bootRetryBaseMs: 10 };

let lago: FakeLago;
let reports: { err: Error; where: LagoX402ErrorWhere }[];
let warn: MockInstance<typeof console.warn>;
let instances: LagoX402[];

beforeEach(async () => {
  lago = await startFakeLago();
  reports = [];
  instances = [];
  // The log floor prints every report; keep the run quiet and assert on it where it matters.
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const x of instances) await x.close({ timeoutMs: 100 });
  await lago.close();
  warn.mockRestore();
});

function route(o: Partial<LagoX402Route> = {}): LagoX402Route {
  return {
    billableMetric: "tokens",
    planCode: "agents_plan",
    walletCode: "agents_wallet",
    topUpAmountCents: 500,
    estimatedCallCostCents: 2,
    wallet: { name: "Agent credits", rateAmount: "1" },
    ...o,
  };
}

function config(o: Partial<LagoX402Config> = {}): LagoX402Config {
  return {
    apiUrl: lago.apiUrl,
    apiKey,
    connectionCode: "conn_test",
    origin: ORIGIN,
    routes: { generate: route() },
    onError: (err, where) => void reports.push({ err: err as Error, where }),
    ...o,
  };
}

async function create(c: LagoX402Config = config(), o: typeof FAST = FAST): Promise<LagoX402> {
  const x402 = await createLagoX402(c, o);
  instances.push(x402);
  return x402;
}

/** The boot check of the `generate` route, on its own. */
async function check(o: Partial<LagoX402Config> = {}): Promise<CheckResult> {
  const c = validateConfig(config(o));
  return checkRoute(new LagoClient(c.apiUrl, c.apiKey), c, c.routes.get("generate")!);
}

/** The single `LagoX402ConfigError` a boot must reject with. */
async function rejection(p: Promise<unknown>): Promise<LagoX402ConfigError> {
  const outcome = await p.then(
    (x) => {
      instances.push(x as LagoX402);
      return null;
    },
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(LagoX402ConfigError);
  return outcome as LagoX402ConfigError;
}

/** Answers `endpoint` with `seq` in order, repeating the last answer. */
function answers(endpoint: FakeRoute, ...seq: FakeAnswer[]): void {
  let i = 0;
  lago.on(endpoint, () => seq[Math.min(i++, seq.length - 1)]);
}

const calls = (endpoint: FakeRoute) => lago.requests.filter((r) => r.route === endpoint);

function request(headers: Record<string, string> = {}, target = "/v1/generate"): GateRequest {
  const map = new Headers(headers);
  return { method: "POST", target, header: (name) => map.get(name) ?? undefined };
}

/** A decodable SIGN-IN-WITH-X header (Lago, not the gate, verifies it). */
const SIGN_IN = Buffer.from(
  JSON.stringify({ address: "0x00000000000000000000000000000000000b0b01" }),
).toString("base64");

function expectUnavailable(outcome: GateOutcome): void {
  expect(outcome).toStrictEqual({
    action: "respond",
    status: 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: '{"error":"unavailable"}',
  });
}

async function statusOf(x402: LagoX402, name = "generate"): Promise<number> {
  const outcome = await handleRequest(x402, name, request());
  return outcome.action === "respond" ? outcome.status : 200;
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("checkRoute", () => {
  it("reads the billable metric with GET, then sends leg 1's exact E7 body", async () => {
    expect(await check()).toStrictEqual({ ok: true });
    expect(lago.requests.map((r) => [r.method, r.path])).toStrictEqual([
      ["GET", "/api/v1/billable_metrics/tokens"],
      ["POST", "/api/v1/x402/gate_checks"],
    ]);
    expect(lago.requests[1].rawBody).toBe(E7_BODY);
    expect(lago.requests[0].headers.authorization).toBe(`Bearer ${apiKey}`);
  });

  it("puts the metric code into one encoded path segment", async () => {
    await check({ routes: { generate: route({ billableMetric: "a b/c?d#e" }) } });
    expect(calls("billable_metrics")[0].path).toBe("/api/v1/billable_metrics/a%20b%2Fc%3Fd%23e");
  });

  it.each([
    ["null", null],
    ['""', ""],
  ])("accepts a metric whose expression is %s", async (_label, expression) => {
    answers("billable_metrics", { status: 200, body: billableMetric({ expression }) });
    expect(await check()).toStrictEqual({ ok: true });
  });

  it("names every problem of an unusable metric at once, and calls no E7", async () => {
    answers("billable_metrics", {
      status: 200,
      body: billableMetric({ aggregation_type: "max_agg", field_name: "tokens", recurring: true }),
    });
    const result = await check();
    expect(result).toStrictEqual({
      ok: false,
      definitive: true,
      reason:
        'billable metric "tokens" cannot bill x402 calls: aggregation_type must be sum_agg (is max_agg); ' +
        'field_name must be "value"; recurring must be false',
    });
    expect(calls("gate_checks")).toHaveLength(0);
  });

  it("refuses a metric answer of the wrong shape", async () => {
    answers("billable_metrics", { status: 200, body: { billable_metrics: [] } });
    expect(await check()).toStrictEqual({
      ok: false,
      definitive: true,
      reason: "Lago billable_metrics answered 200 (unexpected_answer)",
    });
  });

  it.each([
    ["401", { status: 401, body: unauthorized() }, "Lago billable_metrics answered 401"],
    [
      "403 feature_unavailable",
      { status: 403, body: forbidden("feature_unavailable") },
      "Lago billable_metrics answered 403 (feature_unavailable)",
    ],
    [
      "400",
      { status: 400, body: { status: 400, error: "BadRequest: free text from Lago" } },
      "Lago billable_metrics answered 400",
    ],
    [
      "a 404 that is not Lago's metric 404 (wrong apiUrl)",
      { status: 404, body: notFound("route") },
      "Lago billable_metrics answered 404 (route_not_found)",
    ],
  ])("a metric %s is a definitive refusal with Lago's code only", async (_label, answer, reason) => {
    answers("billable_metrics", answer);
    expect(await check()).toStrictEqual({ ok: false, definitive: true, reason });
    expect(calls("gate_checks")).toHaveLength(0);
  });

  it.each([
    ["E7 pass", { status: 200, body: gateCheckPass() }, "Lago passed a request without a sign-in"],
    [
      "challenge with an empty sign_in_chains",
      { status: 200, body: gateCheckChallenge({ sign_in_chains: [] }) },
      "Lago's challenge offers no sign-in chain this middleware can render",
    ],
    [
      "challenge with only unknown sign-in chains",
      { status: 200, body: gateCheckChallenge({ sign_in_chains: ["cosmos:cosmoshub-4"] }) },
      "Lago's challenge offers no sign-in chain this middleware can render",
    ],
  ])("an E7 %s is a definitive refusal", async (_label, answer, reason) => {
    answers("gate_checks", answer);
    expect(await check()).toStrictEqual({ ok: false, definitive: true, reason });
  });

  // R23: only a challenge (requirements array) without a sign_in_chains array is a Lago without
  // INT-331; any other unreadable answer is not something upgrading lago-api would fix.
  const challengeWithout = (chains: "absent" | null) => {
    const body = gateCheckChallenge();
    if (chains === "absent") delete (body.gate_check as Partial<typeof body.gate_check>).sign_in_chains;
    else body.gate_check.sign_in_chains = chains;
    return body;
  };
  it.each([
    ["a challenge without sign_in_chains", challengeWithout("absent"), NO_SIGN_IN],
    ["a challenge with sign_in_chains: null", challengeWithout(null), NO_SIGN_IN],
    [
      "a pass without external_subscription_id",
      gateCheckPass({ external_subscription_id: null }),
      UNEXPECTED_E7,
    ],
    ["a challenge with requirements: []", gateCheckChallenge({ requirements: [] }), UNEXPECTED_E7],
    [
      "a challenge with a malformed requirement entry",
      gateCheckChallenge({ requirements: [{ ...evmRequirement(), amount_atomic: "5.00" }] }),
      UNEXPECTED_E7,
    ],
    ["an answer without gate_check", { x402_settlement: {} }, UNEXPECTED_E7],
  ])("an unreadable E7 200 (%s) is refused with the right reason", async (_label, body, reason) => {
    answers("gate_checks", { status: 200, body });
    expect(await check()).toStrictEqual({ ok: false, definitive: true, reason });
  });

  it.each([
    ["metric 500", "billable_metrics", { status: 500 }, "Lago billable_metrics answered 500"],
    ["metric 503", "billable_metrics", { status: 503 }, "Lago billable_metrics answered 503"],
    ["metric 429", "billable_metrics", { status: 429 }, "Lago billable_metrics answered 429"],
    ["metric 408", "billable_metrics", { status: 408 }, "Lago billable_metrics answered 408"],
    [
      "metric dropped socket",
      "billable_metrics",
      { status: 200, destroySocket: true },
      "Lago billable_metrics unreachable (network)",
    ],
    ["E7 502", "gate_checks", { status: 502 }, "Lago gate_checks answered 502"],
    ["E7 429", "gate_checks", { status: 429 }, "Lago gate_checks answered 429"],
    [
      "E7 third_party_error (facilitator read failed)",
      "gate_checks",
      { status: 422, body: thirdPartyError() },
      "Lago gate_checks answered 422 (third_party_error)",
    ],
    [
      "E7 dropped socket",
      "gate_checks",
      { status: 200, destroySocket: true },
      "Lago gate_checks unreachable (network)",
    ],
  ] as [string, FakeRoute, FakeAnswer, string][])(
    "%s is unreachable, not a refusal",
    async (_label, endpoint, answer, reason) => {
      answers(endpoint, answer);
      expect(await check()).toStrictEqual({ ok: false, definitive: false, reason });
    },
  );

  it("a metric read slower than gateCheckMs is unreachable (timeout)", async () => {
    answers("billable_metrics", { status: 200, body: billableMetric(), delayMs: 400 });
    expect(await check({ timeouts: { gateCheckMs: 50 } })).toStrictEqual({
      ok: false,
      definitive: false,
      reason: "Lago billable_metrics unreachable (timeout)",
    });
  });

  it("an E7 slower than gateCheckMs is unreachable (timeout)", async () => {
    answers("gate_checks", { status: 200, body: gateCheckChallenge(), delayMs: 400 });
    expect(await check({ timeouts: { gateCheckMs: 50 } })).toStrictEqual({
      ok: false,
      definitive: false,
      reason: "Lago gate_checks unreachable (timeout)",
    });
  });

  it("an unsafe metric code is never quoted in a reason", async () => {
    answers("billable_metrics", { status: 404, body: notFound("billable_metric") });
    const result = await check({ routes: { generate: route({ billableMetric: 'x"\n[lago-x402] forged' }) } });
    expect(result).toStrictEqual({
      ok: false,
      definitive: true,
      reason: "the route's billable metric not found in Lago (billable_metric_not_found)",
    });
  });

  it("reasons never carry Lago's free text, an expression or the API key", async () => {
    const secret = "secret-" + randomUUID();
    answers("billable_metrics", { status: 200, body: billableMetric({ expression: `concat(${secret})` }) });
    const metric = await check();
    answers("billable_metrics", { status: 200, body: billableMetric() });
    answers("gate_checks", {
      status: 422,
      body: { ...validationErrors({ base: ["plan_not_usage_only"] }), error: secret },
    });
    const gate = await check();
    for (const result of [metric, gate]) {
      expect(result.ok).toBe(false);
      const text = JSON.stringify(result);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(apiKey);
    }
  });
});

describe("createLagoX402: refusals at boot", () => {
  it("rejects an invalid config before any network call", async () => {
    const err = await rejection(createLagoX402(config({ origin: "http://merchant.example" }), FAST));
    expect(err.route).toBeNull();
    expect(lago.requests).toHaveLength(0);
  });

  it.each([
    [
      "count_agg",
      { status: 200, body: billableMetric({ aggregation_type: "count_agg" }) },
      "aggregation_type must be sum_agg (is count_agg)",
    ],
    [
      'field_name "tokens"',
      { status: 200, body: billableMetric({ field_name: "tokens" }) },
      'field_name must be "value"',
    ],
    [
      "an expression",
      { status: 200, body: billableMetric({ expression: "event.properties.a * 2" }) },
      "expression must be empty",
    ],
    [
      "recurring: true",
      { status: 200, body: billableMetric({ recurring: true }) },
      "recurring must be false",
    ],
    [
      "404",
      { status: 404, body: notFound("billable_metric") },
      'billable metric "tokens" not found in Lago (billable_metric_not_found)',
    ],
  ])("a metric with %s rejects naming the route and the reason", async (_label, answer, reason) => {
    answers("billable_metrics", answer);
    const err = await rejection(createLagoX402(config(), FAST));
    expect(err.route).toBe("generate");
    expect(err.reason).toContain(reason);
    expect(err.message).toBe(`lago-x402 route "generate": ${err.reason}`);
    expect(calls("gate_checks")).toHaveLength(0);
  });

  const base = (code: string): FakeAnswer => ({ status: 422, body: validationErrors({ base: [code] }) });
  it.each([
    [
      "plan_not_found",
      { status: 404, body: notFound("plan") },
      "Lago gate_checks answered 404 (plan_not_found)",
    ],
    [
      "charge_not_found",
      { status: 404, body: notFound("charge") },
      "Lago gate_checks answered 404 (charge_not_found)",
    ],
    [
      "plan_currency_not_supported",
      base("plan_currency_not_supported"),
      "Lago gate_checks answered 422 (validation_errors) [base: plan_currency_not_supported]",
    ],
    [
      "plan_not_usage_only",
      base("plan_not_usage_only"),
      "Lago gate_checks answered 422 (validation_errors) [base: plan_not_usage_only]",
    ],
    [
      "charge_not_targeted",
      base("charge_not_targeted"),
      "Lago gate_checks answered 422 (validation_errors) [base: charge_not_targeted]",
    ],
    [
      "charge_not_invoiceable",
      base("charge_not_invoiceable"),
      "Lago gate_checks answered 422 (validation_errors) [base: charge_not_invoiceable]",
    ],
    [
      "connection_not_found",
      { status: 404, body: notFound("connection") },
      "Lago gate_checks answered 404 (connection_not_found)",
    ],
    ["401", { status: 401, body: unauthorized() }, "Lago gate_checks answered 401"],
    [
      "403 feature_unavailable",
      { status: 403, body: forbidden("feature_unavailable") },
      "Lago gate_checks answered 403 (feature_unavailable)",
    ],
  ])("E7 %s rejects naming the route and Lago's code", async (_label, answer, reason) => {
    answers("gate_checks", answer);
    const err = await rejection(createLagoX402(config(), FAST));
    expect(err.route).toBe("generate");
    expect(err.reason).toBe(reason);
  });

  it("a challenge without sign_in_chains (Lago without INT-331) is refused", async () => {
    const body = gateCheckChallenge();
    delete (body.gate_check as Partial<typeof body.gate_check>).sign_in_chains;
    answers("gate_checks", { status: 200, body });
    const err = await rejection(createLagoX402(config(), FAST));
    expect(err.route).toBe("generate");
    expect(err.reason).toBe(NO_SIGN_IN);
  });

  it("several refused routes reject once, naming each route with its reason", async () => {
    lago.on("billable_metrics", (req) =>
      req.path.endsWith("/words")
        ? { status: 200, body: billableMetric({ aggregation_type: "count_agg" }) }
        : { status: 200, body: billableMetric() },
    );
    lago.on("gate_checks", (req) =>
      (req.json as { gate_check: { plan_code: string } }).gate_check.plan_code === "missing_plan"
        ? { status: 404, body: notFound("plan") }
        : { status: 200, body: gateCheckChallenge() },
    );
    const err = await rejection(
      createLagoX402(
        config({
          routes: {
            summarize: route({ billableMetric: "words" }),
            generate: route(),
            translate: route({ planCode: "missing_plan" }),
          },
        }),
        FAST,
      ),
    );
    expect(err.route).toBeNull();
    expect(err.reason).toBe(
      '2 routes refused: "summarize": billable metric "words" cannot bill x402 calls: ' +
        'aggregation_type must be sum_agg (is count_agg); "translate": Lago gate_checks answered 404 (plan_not_found)',
    );
    expect(err.reason).not.toContain('"generate"');
  });

  it("a refusal next to an unreachable route rejects and leaves no retry behind", async () => {
    lago.on("billable_metrics", (req) =>
      req.path.endsWith("/words")
        ? { status: 503 }
        : { status: 200, body: billableMetric({ recurring: true }) },
    );
    const err = await rejection(
      createLagoX402(
        config({ routes: { generate: route(), summarize: route({ billableMetric: "words" }) } }),
        FAST,
      ),
    );
    expect(err.route).toBe("generate");
    await sleep(150);
    expect(calls("billable_metrics").filter((r) => r.path.endsWith("/words"))).toHaveLength(1);
  });

  it("checks every route concurrently", async () => {
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    // Each metric read is answered only once both have arrived: run one after the other, the
    // first would wait alone and fall back to a 503.
    lago.on("billable_metrics", async () => {
      if (++arrived === 2) release();
      const together = await Promise.race([both.then(() => true), sleep(1500).then(() => false)]);
      return together ? { status: 200, body: billableMetric() } : { status: 503 };
    });
    const x402 = await create(
      config({ routes: { generate: route(), summarize: route({ billableMetric: "words" }) } }),
    );
    expect(await statusOf(x402, "generate")).toBe(402);
    expect(await statusOf(x402, "summarize")).toBe(402);
    expect(reports).toEqual([]);
  });
});

describe("createLagoX402: Lago unreachable at boot", () => {
  it("Lago down at boot resolves, answers 503, then serves once the background check passes", async () => {
    answers(
      "billable_metrics",
      { status: 503 },
      { status: 503 },
      { status: 503 },
      {
        status: 200,
        body: billableMetric(),
      },
    );
    const x402 = await create();

    expectUnavailable(await handleRequest(x402, "generate", request()));
    expectUnavailable(await handleRequest(x402, "generate", request({ "SIGN-IN-WITH-X": SIGN_IN })));
    expect(calls("gate_checks")).toHaveLength(0);

    await waitFor(async () => (await statusOf(x402)) === 402);
    // One `boot` report per failed attempt (the first one and two background retries), no
    // per-request report while the route was down.
    expect(calls("billable_metrics")).toHaveLength(4);
    expect(reports.map((r) => r.where)).toStrictEqual(["boot", "boot", "boot"]);
    for (const { err } of reports) {
      expect(err.message).toBe('lago-x402 route "generate": Lago billable_metrics answered 503; retrying');
    }
  });

  it("a refusal found in the background keeps 503 and reports boot once", async () => {
    answers(
      "billable_metrics",
      { status: 503 },
      {
        status: 200,
        body: billableMetric({ aggregation_type: "count_agg" }),
      },
    );
    const x402 = await create();
    await waitFor(() => reports.length === 2);
    await sleep(150);

    expect(calls("billable_metrics")).toHaveLength(2);
    expect(reports).toHaveLength(2);
    expect(reports[0].where).toBe("boot");
    expect(reports[1].where).toBe("boot");
    expect(reports[1].err).toBeInstanceOf(LagoX402ConfigError);
    expect(reports[1].err).toMatchObject({
      route: "generate",
      reason:
        'billable metric "tokens" cannot bill x402 calls: aggregation_type must be sum_agg (is count_agg)',
    });
    expectUnavailable(await handleRequest(x402, "generate", request()));
    expect(reports).toHaveLength(2);
  });

  it("a route Lago cannot be reached for does not hold up the others", async () => {
    lago.on("billable_metrics", (req) =>
      req.path.endsWith("/words") ? { status: 503 } : { status: 200, body: billableMetric() },
    );
    const x402 = await create(
      config({ routes: { generate: route(), summarize: route({ billableMetric: "words" }) } }),
    );
    expect(await statusOf(x402, "generate")).toBe(402);
    expect(await statusOf(x402, "summarize")).toBe(503);
  });

  it("retries back off from 1 s, doubling up to 60 s", () => {
    const o = { retryBaseMs: 1000, retryMaxMs: 60_000 };
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => retryDelayMs(n, o))).toStrictEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });

  it("the public createLagoX402 retries after 1 s on an unref'd timer that close() clears", async () => {
    answers("billable_metrics", { status: 503 });
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      // A second argument cannot shorten the public schedule.
      const create = publicApi.createLagoX402 as (...args: unknown[]) => Promise<LagoX402>;
      const x402 = await create(config(), FAST);
      instances.push(x402);
      const retries = setSpy.mock.calls
        .map((call, i) => ({ delay: call[1], timer: setSpy.mock.results[i].value as NodeJS.Timeout }))
        .filter(({ delay }) => delay === 1000 || delay === FAST.bootRetryBaseMs);
      expect(retries.map((r) => r.delay)).toStrictEqual([1000]);
      expect(retries[0].timer.hasRef()).toBe(false);
      await x402.close();
      expect(clearSpy).toHaveBeenCalledWith(retries[0].timer);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

describe("close()", () => {
  it("stops background retries", async () => {
    answers("billable_metrics", { status: 503 });
    const x402 = await create();
    await waitFor(() => calls("billable_metrics").length >= 3);
    await x402.close();
    await sleep(50);
    const seen = calls("billable_metrics").length;
    const reported = reports.length;
    await sleep(200);
    expect(calls("billable_metrics")).toHaveLength(seen);
    expect(reports).toHaveLength(reported);
  });

  it("waits for usage events still being delivered", async () => {
    lago.on("gate_checks", (req) =>
      (req.json as { gate_check: Record<string, unknown> }).gate_check.siwx === undefined
        ? { status: 200, body: gateCheckChallenge() }
        : { status: 200, body: gateCheckPass({ external_subscription_id: "x402_sub_1" }) },
    );
    answers("events", { status: 200, body: {}, delayMs: 200 });
    const x402 = await create();
    const outcome = await handleRequest(x402, "generate", request({ "SIGN-IN-WITH-X": SIGN_IN }));
    if (outcome.action !== "serve") throw new Error("expected serve");

    let billed = false;
    void outcome.billing.finish(200, () => 7).then(() => (billed = true));
    await waitFor(() => calls("events").length === 1);
    expect(billed).toBe(false);
    const started = Date.now();
    await x402.close();
    // close() resolves once Lago answered; finish()'s own promise settles a few microtasks later.
    // Had close() not waited, the event (answered after 200 ms) would still be in flight here.
    await new Promise((r) => setImmediate(r));
    expect(billed).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(calls("events")[0].json).toMatchObject({
      event: {
        external_subscription_id: "x402_sub_1",
        code: "tokens",
        properties: { value: "7", target_wallet_code: "agents_wallet" },
      },
    });
    expect(reports).toEqual([]);
  });

  it("gives up waiting after timeoutMs", async () => {
    lago.on("gate_checks", (req) =>
      (req.json as { gate_check: Record<string, unknown> }).gate_check.siwx === undefined
        ? { status: 200, body: gateCheckChallenge() }
        : { status: 200, body: gateCheckPass() },
    );
    answers("events", { status: 200, body: {}, delayMs: 2000 });
    const x402 = await create();
    const outcome = await handleRequest(x402, "generate", request({ "SIGN-IN-WITH-X": SIGN_IN }));
    if (outcome.action !== "serve") throw new Error("expected serve");
    let billed = false;
    void outcome.billing.finish(200, () => 1).then(() => (billed = true));
    const started = Date.now();
    await x402.close({ timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(billed).toBe(false);
  });
});

describe("handleRequest and hasRoute", () => {
  it("an active route goes through the gate, with leg 1's E7 body", async () => {
    const x402 = await create();
    lago.requests.length = 0;
    const outcome = await handleRequest(x402, "generate", request());
    expect(outcome.action === "respond" && outcome.status).toBe(402);
    expect(calls("gate_checks").map((r) => r.rawBody)).toStrictEqual([E7_BODY]);
  });

  it("an unknown route name answers 503 and reports gate.check", async () => {
    const x402 = await create();
    lago.requests.length = 0;
    expectUnavailable(await handleRequest(x402, "generat", request()));
    expect(lago.requests).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(reports[0].where).toBe("gate.check");
    expect(reports[0].err).toBeInstanceOf(LagoX402ConfigError);
    expect(reports[0].err.message).toBe('lago-x402 route "generat": not configured');
  });

  it("an unknown route name that is not log-safe is not quoted", async () => {
    const x402 = await create();
    expectUnavailable(await handleRequest(x402, 'x"\n[lago-x402] forged', request()));
    expect(reports[0].err.message).toBe("lago-x402 config: a request named a route that is not configured");
  });

  it("hasRoute knows the configured routes only", async () => {
    const x402 = await create();
    expect(hasRoute(x402, "generate")).toBe(true);
    expect(hasRoute(x402, "generat")).toBe(false);
    expect(hasRoute(x402, "__proto__")).toBe(false);
    expect(hasRoute({ close: async () => {} }, "generate")).toBe(false);
  });

  it("an object createLagoX402 did not make answers 503 and is logged", async () => {
    expectUnavailable(await handleRequest({ close: async () => {} }, "generate", request()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[lago-x402\] gate\.check failed: /);
    expect(lago.requests).toHaveLength(0);
  });

  it("the LagoX402 object exposes close() only", async () => {
    const x402 = await create();
    expect(Object.keys(x402)).toStrictEqual(["close"]);
    expect(Object.isFrozen(x402)).toBe(true);
    expect(JSON.stringify(x402)).not.toContain(apiKey);
  });
});

describe("reporting", () => {
  it("every report reaches onError and the console.warn floor", async () => {
    answers("billable_metrics", { status: 503 });
    await create(config(), { bootRetryBaseMs: 60_000 });
    expect(reports).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`[lago-x402] boot failed: ${reports[0].err.message}`);
  });

  it("logs without an onError", async () => {
    answers("billable_metrics", { status: 503 });
    const c = config();
    delete c.onError;
    await create(c, { bootRetryBaseMs: 60_000 });
    expect(warn).toHaveBeenCalledWith(
      '[lago-x402] boot failed: lago-x402 route "generate": Lago billable_metrics answered 503; retrying',
    );
  });

  it("a throwing onError is swallowed and the line is still logged", async () => {
    answers("billable_metrics", { status: 503 });
    const x402 = await create(
      config({
        onError: () => {
          throw new Error("merchant bug");
        },
      }),
      { bootRetryBaseMs: 60_000 },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expectUnavailable(await handleRequest(x402, "generate", request()));
  });
});

describe("public entry point", () => {
  it("exports exactly the core API", () => {
    expect(Object.keys(publicApi).sort()).toStrictEqual([
      "LagoApiError",
      "LagoUnreachableError",
      "LagoX402ConfigError",
      "LagoX402UsageError",
      "createLagoX402",
    ]);
    expect(publicApi.createLagoX402.length).toBe(1);
  });

  it("the public createLagoX402 boots a healthy config", async () => {
    const x402: PublicLagoX402 = await publicApi.createLagoX402(config());
    instances.push(x402);
    expect(await statusOf(x402)).toBe(402);
  });
});
