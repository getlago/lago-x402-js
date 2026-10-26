/** The behaviour every adapter must show, through real HTTP and the official x402 clients
 * (`@x402/fetch` + the sign-in-with-x client extension), against the fake Lago. Each framework in
 * `FRAMEWORKS` runs the whole suite (Next through `nextListener`, with `after()` mocked as Next
 * runs it). Events are asserted only after `settle()`: the app is
 * closed (every response has finished, so billing has run) and the instance drained, so no
 * assertion waits on a timer. */
import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createLagoX402, LagoApiError, LagoUnreachableError, LagoX402UsageError } from "../../src/index.js";
import type { LagoX402, LagoX402Config, LagoX402ErrorWhere } from "../../src/index.js";
import { evmAgent, type EvmAgent } from "../support/agent.js";
import { startFakeLago, type FakeAnswer, type FakeLago, type RecordedRequest } from "../support/fake-lago.js";
import {
  gateCheckChallenge,
  gateCheckPass,
  hex32,
  notFound,
  settlement,
  validationErrors,
} from "../support/fixtures.js";
import {
  FRAMEWORKS,
  HANDLER_BODY,
  PATH,
  ROUTE,
  USAGE_GETTER_MESSAGE,
  startApp,
  type Handler,
} from "../support/frameworks.js";

// Next's `after()` as on a Node server, scoped to each request the bridge serves.
vi.mock("next/server.js", async () => (await import("../support/frameworks.js")).nextServer);

const apiKey = "test-key-" + randomUUID();
const SIGN_IN_WITH_X = "sign-in-with-x";
const TX_HASH = hex32("cd");

interface Report {
  err: Error;
  where: LagoX402ErrorWhere;
}

interface UsageEvent {
  transaction_id: string;
  external_subscription_id: string;
  code: string;
  timestamp: number;
  properties: { value: string; target_wallet_code: string };
}

interface SignInInfo {
  domain: string;
  uri: string;
  nonce: string;
}

/** A stock agent's fetch (`wrapFetchWithPayment`), recording what it sends and receives. */
interface Recorded {
  agent: EvmAgent;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  sent: Headers[];
  received: { status: number; headers: Headers }[];
}

function recorded(agent: EvmAgent): Recorded {
  const sent: Headers[] = [];
  const received: { status: number; headers: Headers }[] = [];
  const recorder: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    sent.push(new Headers(req.headers));
    const res = await fetch(req);
    received.push({ status: res.status, headers: new Headers(res.headers) });
    return res;
  };
  return { agent, fetch: wrapFetchWithPayment(recorder, agent.http), sent, received };
}

/** Signs in; never pays (the stock client's default $1 cap is below the $5 top-up). */
const signingAgent = () => recorded(evmAgent());
/** Signs in and pays the $5 top-up when the sign-in is answered with a 402. */
const unfundedAgent = () => recorded(evmAgent({ maxAmountPerPayment: "$10" }));
/** No sign-in extension: pays the $5 top-up straight from the first 402. */
const payingAgent = () => recorded(evmAgent({ signIn: false, maxAmountPerPayment: "$10" }));

const gateCheckOf = (r: RecordedRequest) => (r.json as { gate_check: Record<string, unknown> }).gate_check;
const purchaseOf = (r: RecordedRequest) =>
  (r.json as { credit_purchase: Record<string, unknown> }).credit_purchase;
const siwxOf = (r: RecordedRequest) =>
  gateCheckOf(r).siwx as { address: string; domain: string; uri: string } | undefined;
const paymentOf = (r: RecordedRequest) =>
  purchaseOf(r).payment as {
    resource: { url: string };
    payload: { authorization: { from: string; nonce: string } };
  };
const payerOf = (r: RecordedRequest) => paymentOf(r).payload.authorization.from;
const subscriptionFor = (address: string) => `sub_${address.toLowerCase()}`;

/** E7: a pass for a signed-in agent (subscription named after its address), else a challenge. */
function funded(r: RecordedRequest): FakeAnswer {
  const siwx = siwxOf(r);
  return siwx
    ? { status: 200, body: gateCheckPass({ external_subscription_id: subscriptionFor(siwx.address) }) }
    : { status: 200, body: gateCheckChallenge() };
}

/** E7: whatever `answer` says for a signed-in agent, else a challenge. */
function onSignIn(answer: FakeAnswer): (r: RecordedRequest) => FakeAnswer {
  return (r) => (siwxOf(r) ? answer : { status: 200, body: gateCheckChallenge() });
}

/** E8: settles every payment, for a subscription named after the payer. */
function settles(r: RecordedRequest): FakeAnswer {
  const from = payerOf(r);
  return {
    status: 200,
    body: settlement({
      payer_address: from,
      transaction_hash: TX_HASH,
      external_subscription_id: subscriptionFor(from),
    }),
  };
}

/** E8 as Lago runs it: settles a payment once, then answers it again from its row
 * (`replayed: true`) for as long as it is kept, whoever presents it. */
function settlesOnce(): (r: RecordedRequest) => FakeAnswer {
  const seen = new Set<string>();
  return (r) => {
    const answer = settles(r);
    const nonce = paymentOf(r).payload.authorization.nonce;
    const replayed = seen.has(nonce);
    seen.add(nonce);
    const { x402_settlement } = answer.body as ReturnType<typeof settlement>;
    return { ...answer, body: { x402_settlement: { ...x402_settlement, replayed } } };
  };
}

function signInOf(pr: PaymentRequired): SignInInfo {
  return (pr.extensions![SIGN_IN_WITH_X] as { info: SignInInfo }).info;
}

async function expectRefusal(
  res: Response,
  status: number,
  body: Record<string, string>,
  retryAfter: string | null = null,
): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("retry-after")).toBe(retryAfter);
  expect(res.headers.get("payment-response")).toBeNull();
  expect(await res.json()).toStrictEqual(body);
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A `node:http` request, so `Host` can be forged (fetch sets its own). */
function rawPost(url: string, headers: Record<string, string>): Promise<RawResponse> {
  const { port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: pathname, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe.each(FRAMEWORKS)("%s", (fw) => {
  let lago: FakeLago;
  let reports: Report[];
  let warn: MockInstance<typeof console.warn>;
  let cleanups: (() => Promise<unknown>)[];

  beforeEach(async () => {
    lago = await startFakeLago();
    reports = [];
    cleanups = [];
    // Every report is also logged; keep the run quiet and assert on it where it matters.
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await lago.close();
    warn.mockRestore();
  });

  function config(origin: string, o: Partial<LagoX402Config>): LagoX402Config {
    return {
      apiUrl: lago.apiUrl,
      apiKey,
      connectionCode: "conn_test",
      origin,
      routes: {
        [ROUTE]: {
          billableMetric: "tokens",
          planCode: "agents_plan",
          walletCode: "agents_wallet",
          topUpAmountCents: 500,
          estimatedCallCostCents: 2,
          fallbackUsage: 250,
          wallet: { name: "Agent credits", rateAmount: "1" },
        },
      },
      onError: (err, where) => void reports.push({ err: err as Error, where }),
      ...o,
    };
  }

  /** Boots an instance whose origin is the app's, attaches it, and forgets boot's requests. */
  async function start(h: Handler = {}, o: Partial<LagoX402Config> = {}) {
    let x402: LagoX402 | undefined;
    const app = await startApp(fw, async (origin) => (x402 = await createLagoX402(config(origin, o))), h);
    const settle = async (): Promise<UsageEvent[]> => {
      await app.close();
      await x402!.close({ timeoutMs: 10_000 });
      return events();
    };
    cleanups.push(settle);
    lago.requests.length = 0;
    return { url: app.url + PATH, origin: app.url, settle };
  }

  const e7 = () => lago.requests.filter((r) => r.route === "gate_checks");
  const e8 = () => lago.requests.filter((r) => r.route === "credit_purchases");
  const events = () =>
    lago.requests.filter((r) => r.route === "events").map((r) => (r.json as { event: UsageEvent }).event);

  function expectReport(where: LagoX402ErrorWhere, match: object): void {
    expect(reports).toHaveLength(1);
    expect(reports[0].where).toBe(where);
    expect(reports[0].err).toMatchObject(match);
  }

  describe("the three legs", () => {
    it("a stranger gets a 402: PAYMENT-REQUIRED decodes, Cache-Control no-store, body {}", async () => {
      const { url, origin, settle } = await start({ usage: 1 });

      const res = await fetch(url, { method: "POST" });

      expect(res.status).toBe(402);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.text()).toBe("{}");
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(pr.x402Version).toBe(2);
      expect(pr.resource.url).toBe(url);
      expect(pr.accepts).toHaveLength(1);
      expect(pr.accepts[0]).toMatchObject({ scheme: "exact", amount: "5000000" });
      expect(signInOf(pr)).toMatchObject({ domain: new URL(origin).host, uri: url });
      expect(e7()).toHaveLength(1);
      expect(siwxOf(e7()[0])).toBeUndefined();
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it("GET is gated like POST", async () => {
      const { url } = await start({ usage: 1 });
      const res = await fetch(url);
      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).resource.url).toBe(url);
    });

    it("a funded agent signs in and is served: no PAYMENT-SIGNATURE ever sent, E7 got siwx, billed once", async () => {
      lago.on("gate_checks", funded);
      const { url, origin, settle } = await start({ usage: 3 });
      const agent = signingAgent();

      const res = await agent.fetch(url, { method: "POST", body: JSON.stringify({ prompt: "hi" }) });

      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual(HANDLER_BODY);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(res.headers.get("payment-response")).toBeNull();
      expect(agent.sent.map((h) => [h.has("sign-in-with-x"), h.has("payment-signature")])).toStrictEqual([
        [false, false],
        [true, false],
      ]);
      expect(e7()).toHaveLength(2);
      const siwx = siwxOf(e7()[1])!;
      expect(siwx).toMatchObject({ domain: new URL(origin).host, uri: url });
      expect(siwx.address.toLowerCase()).toBe(agent.agent.account.address.toLowerCase());
      expect(e8()).toHaveLength(0);

      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0]).toMatchObject({
        external_subscription_id: subscriptionFor(siwx.address),
        code: "tokens",
        properties: { value: "3", target_wallet_code: "agents_wallet" },
      });
      expect(reports).toStrictEqual([]);
    });

    it("an unfunded agent pays from the first 402's menu: PAYMENT-RESPONSE, private, billed once with E8's subscription", async () => {
      // Signed in but out of credits: E7 challenges every time.
      lago.on("credit_purchases", settles);
      const { url, settle } = await start({ usage: 7 });
      const agent = unfundedAgent();

      const res = await agent.fetch(url, { method: "POST" });

      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual(HANDLER_BODY);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(agent.received.map((r) => r.status)).toStrictEqual([402, 402, 200]);
      expect(agent.sent.map((h) => [h.has("sign-in-with-x"), h.has("payment-signature")])).toStrictEqual([
        [false, false],
        [true, false],
        [false, true],
      ]);
      // Leg 3 asks E7 for a fresh menu, without siwx.
      expect(e7().map((r) => siwxOf(r) !== undefined)).toStrictEqual([false, true, false]);
      expect(e8()).toHaveLength(1);
      const [purchase] = e8();
      const firstMenu = decodePaymentRequiredHeader(agent.received[0].headers.get("payment-required")!);
      expect(purchaseOf(purchase).payment_requirements).toStrictEqual(firstMenu.accepts[0]);
      expect(paymentOf(purchase).resource.url).toBe(url);
      const payer = agent.agent.account.address;
      expect(payerOf(purchase)).toBe(payer);
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toStrictEqual({
        success: true,
        transaction: TX_HASH,
        network: firstMenu.accepts[0].network,
        payer,
      });

      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0]).toMatchObject({
        external_subscription_id: subscriptionFor(payer),
        code: "tokens",
        properties: { value: "7", target_wallet_code: "agents_wallet" },
      });
      expect(reports).toStrictEqual([]);
    });
  });

  describe("one request per row of the error table", () => {
    it("E7 pass on leg 1 → 503 unavailable, gate.check", async () => {
      const { url, settle } = await start({ usage: 1 });
      lago.on("gate_checks", () => ({ status: 200, body: gateCheckPass() }));

      await expectRefusal(await fetch(url, { method: "POST" }), 503, { error: "unavailable" });
      expect(await settle()).toStrictEqual([]);
      expectReport("gate.check", { status: 200, code: "unexpected_pass" });
    });

    it("E7 {siwx:[nonce_already_used]} → 401 sign_in_rejected", async () => {
      lago.on(
        "gate_checks",
        onSignIn({ status: 422, body: validationErrors({ siwx: ["nonce_already_used"] }) }),
      );
      const { url } = await start({ usage: 1 });

      const res = await signingAgent().fetch(url, { method: "POST" });

      await expectRefusal(res, 401, { error: "sign_in_rejected", reason: "nonce_already_used" });
      expect(reports).toStrictEqual([]);
    });

    it("an undecodable SIGN-IN-WITH-X → 401 sign_in_rejected without asking Lago", async () => {
      const { url } = await start({ usage: 1 });

      const res = await fetch(url, { method: "POST", headers: { "SIGN-IN-WITH-X": "!!!not-base64" } });

      await expectRefusal(res, 401, { error: "sign_in_rejected", reason: "invalid_header" });
      expect(e7()).toHaveLength(0);
    });

    it("buyer_not_recognized → 403", async () => {
      lago.on(
        "gate_checks",
        onSignIn({ status: 422, body: validationErrors({ base: ["buyer_not_recognized"] }) }),
      );
      const { url } = await start({ usage: 1 });

      await expectRefusal(await signingAgent().fetch(url, { method: "POST" }), 403, {
        error: "buyer_not_recognized",
      });
      expect(reports).toStrictEqual([]);
    });

    it("E7 credit_purchase_pending → 503 payment_pending, Retry-After 30", async () => {
      lago.on(
        "gate_checks",
        onSignIn({ status: 422, body: validationErrors({ base: ["credit_purchase_pending"] }) }),
      );
      const { url } = await start({ usage: 1 });

      await expectRefusal(
        await signingAgent().fetch(url, { method: "POST" }),
        503,
        { error: "payment_pending" },
        "30",
      );
      expect(reports).toStrictEqual([]);
    });

    it("E8 pending → 503 payment_pending, Retry-After from reconcile_after", async () => {
      const reconcileAfter = new Date(Date.now() + 90_000).toISOString().replace(/\.\d+Z$/, "Z");
      lago.on("credit_purchases", () => ({
        status: 200,
        body: settlement({ status: "pending", reconcile_after: reconcileAfter }),
      }));
      const { url, settle } = await start({ usage: 1 });

      const res = await payingAgent().fetch(url, { method: "POST" });

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const retryAfter = Number(res.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThanOrEqual(80);
      expect(retryAfter).toBeLessThanOrEqual(90);
      expect(await res.json()).toStrictEqual({ error: "payment_pending" });
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it("a PAYMENT-SIGNATURE resent after it was served → 409 payment_already_settled, billed once", async () => {
      lago.on("credit_purchases", settlesOnce());
      const { url, settle } = await start({ usage: 2 });
      const agent = payingAgent();
      expect((await agent.fetch(url, { method: "POST" })).status).toBe(200);
      const payment = agent.sent.at(-1)!.get("payment-signature")!;

      const replay = await fetch(url, { method: "POST", headers: { "PAYMENT-SIGNATURE": payment } });

      await expectRefusal(replay, 409, { error: "payment_already_settled" });
      expect(e8()).toHaveLength(2);
      expect(e8()[1].rawBody).toBe(e8()[0].rawBody);
      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0].external_subscription_id).toBe(subscriptionFor(agent.agent.account.address));
      expect(reports).toStrictEqual([]);
    });

    it("E8 lost answer, then a settled replay of the same payment → served once with PAYMENT-RESPONSE", async () => {
      const replays = settlesOnce();
      let calls = 0;
      lago.on("credit_purchases", (r) => {
        const answer = replays(r); // the first call settles, though its answer is lost
        return calls++ === 0 ? { status: 200, destroySocket: true } : answer;
      });
      const { url, settle } = await start({ usage: 2 });
      const agent = payingAgent();

      const res = await agent.fetch(url, { method: "POST" });

      expect(res.status).toBe(200);
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).transaction).toBe(TX_HASH);
      expect(e8()).toHaveLength(2);
      expect(e8()[1].rawBody).toBe(e8()[0].rawBody);
      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0].external_subscription_id).toBe(subscriptionFor(agent.agent.account.address));
      expect(reports).toStrictEqual([]);
    });

    it("E8 {payment:[…]} → a fresh 402 carrying the code", async () => {
      lago.on("credit_purchases", () => ({
        status: 422,
        body: validationErrors({ payment: ["invalid_exact_evm_payload_signature"] }),
      }));
      const { url } = await start({ usage: 1 });

      const res = await payingAgent().fetch(url, { method: "POST" });

      expect(res.status).toBe(402);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("retry-after")).toBeNull();
      expect(await res.text()).toBe("{}");
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(pr.error).toBe("invalid_exact_evm_payload_signature");
      expect(pr.resource.url).toBe(url);
      expect(reports).toStrictEqual([]);
    });

    it("E8 {payment_requirements:[amount_above_maximum]} → 503 unavailable, gate.purchase", async () => {
      lago.on("credit_purchases", () => ({
        status: 422,
        body: validationErrors({ payment_requirements: ["amount_above_maximum"] }),
      }));
      const { url } = await start({ usage: 1 });

      await expectRefusal(await payingAgent().fetch(url, { method: "POST" }), 503, { error: "unavailable" });
      expectReport("gate.purchase", { endpoint: "credit_purchases", status: 422 });
    });

    it("E8 {payment:[recorded_as_invoice_payment]} → 409 payment_already_used, gate.purchase", async () => {
      lago.on("credit_purchases", () => ({
        status: 422,
        body: validationErrors({ payment: ["recorded_as_invoice_payment"] }),
      }));
      const { url } = await start({ usage: 1 });

      await expectRefusal(await payingAgent().fetch(url, { method: "POST" }), 409, {
        error: "payment_already_used",
      });
      expectReport("gate.purchase", { endpoint: "credit_purchases", status: 422 });
    });

    it("E8 credit_grant_failed twice → one retry, then 503 payment_pending, Retry-After 30, never 402", async () => {
      lago.on("credit_purchases", () => ({
        status: 422,
        body: validationErrors({ base: ["credit_grant_failed"] }),
      }));
      const { url } = await start({ usage: 1 });

      await expectRefusal(
        await payingAgent().fetch(url, { method: "POST" }),
        503,
        { error: "payment_pending" },
        "30",
      );
      expect(e8()).toHaveLength(2);
      expect(e8()[1].rawBody).toBe(e8()[0].rawBody);
      expectReport("gate.purchase", { endpoint: "credit_purchases" });
    });

    it("E8 lost answer twice → one retry, then 503 payment_pending, Retry-After 30", async () => {
      lago.on("credit_purchases", () => ({ status: 200, destroySocket: true }));
      const { url } = await start({ usage: 1 });

      await expectRefusal(
        await payingAgent().fetch(url, { method: "POST" }),
        503,
        { error: "payment_pending" },
        "30",
      );
      expect(e8()).toHaveLength(2);
      expectReport("gate.purchase", { endpoint: "credit_purchases", reason: "network" });
    });

    it("E8 timeout → 503 payment_pending, Retry-After 30, no retry", async () => {
      lago.on("credit_purchases", () => ({ status: 200, body: settlement(), delayMs: 3000 }));
      const { url } = await start({ usage: 1 }, { timeouts: { creditPurchaseMs: 300 } });

      await expectRefusal(
        await payingAgent().fetch(url, { method: "POST" }),
        503,
        { error: "payment_pending" },
        "30",
      );
      expect(e8()).toHaveLength(1);
      expectReport("gate.purchase", { endpoint: "credit_purchases", reason: "timeout" });
      expect(reports[0].err).toBeInstanceOf(LagoUnreachableError);
    });

    it("a route/config refusal (plan_not_found) → 503 unavailable, gate.check", async () => {
      const { url } = await start({ usage: 1 });
      lago.on("gate_checks", () => ({ status: 404, body: notFound("plan") }));

      await expectRefusal(await fetch(url, { method: "POST" }), 503, { error: "unavailable" });
      expectReport("gate.check", { endpoint: "gate_checks", status: 404, code: "plan_not_found" });
      expect(reports[0].err).toBeInstanceOf(LagoApiError);
    });

    it("E7 timeout → 503 unavailable, gate.check", async () => {
      const { url } = await start({ usage: 1 }, { timeouts: { gateCheckMs: 300 } });
      lago.on("gate_checks", () => ({ status: 200, body: gateCheckChallenge(), delayMs: 3000 }));

      await expectRefusal(await fetch(url, { method: "POST" }), 503, { error: "unavailable" });
      expectReport("gate.check", { endpoint: "gate_checks", reason: "timeout" });
    });

    it("event answered value_already_exist → delivered, nothing reported", async () => {
      lago.on("gate_checks", funded);
      lago.on("events", () => ({
        status: 422,
        body: validationErrors({ transaction_id: ["value_already_exist"] }),
      }));
      const { url, settle } = await start({ usage: 2 });

      expect((await signingAgent().fetch(url, { method: "POST" })).status).toBe(200);
      expect(await settle()).toHaveLength(1);
      expect(reports).toStrictEqual([]);
    });

    it("event refused with another 4xx → dropped, usage.send", async () => {
      lago.on("gate_checks", funded);
      lago.on("events", () => ({ status: 400, body: { status: 400, error: "BadRequest: bad" } }));
      const { url, settle } = await start({ usage: 2 });

      expect((await signingAgent().fetch(url, { method: "POST" })).status).toBe(200);
      expect(await settle()).toHaveLength(1);
      expectReport("usage.send", { endpoint: "events", status: 400 });
    });
  });

  describe("the handler's answer", () => {
    it("a 4xx is passed through with private and sends no event", async () => {
      lago.on("gate_checks", funded);
      const { url, settle } = await start({ status: 404, usage: 3 });

      const res = await signingAgent().fetch(url, { method: "POST" });

      expect(res.status).toBe(404);
      expect(await res.json()).toStrictEqual(HANDLER_BODY);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it("a 5xx after a payment keeps PAYMENT-RESPONSE and private, and sends no event", async () => {
      lago.on("credit_purchases", settles);
      const { url, settle } = await start({ status: 500, usage: 3 });

      const res = await payingAgent().fetch(url, { method: "POST" });

      expect(res.status).toBe(500);
      expect(res.headers.get("payment-response")).not.toBeNull();
      expect(res.headers.get("cache-control")).toBe("private");
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it.each([
      ["public, max-age=60", "public, max-age=60, private"],
      ["no-cache", "no-cache, private"],
      ["private, max-age=5", "private, max-age=5"],
    ])("the handler's Cache-Control %j is sent as %j", async (own, sent) => {
      lago.on("gate_checks", funded);
      const { url } = await start({ cacheControl: own, usage: 1 });

      const res = await signingAgent().fetch(url, { method: "POST" });

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(sent);
    });
  });

  describe("usage", () => {
    it("0 is sent as 0", async () => {
      lago.on("gate_checks", funded);
      const { url, settle } = await start({ usage: 0 });

      expect((await signingAgent().fetch(url, { method: "POST" })).status).toBe(200);
      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0].properties.value).toBe("0");
      expect(reports).toStrictEqual([]);
    });

    it.each<[string, Handler, LagoX402UsageError["reason"]]>([
      ["NaN", { usage: NaN }, "invalid"],
      ["-1", { usage: -1 }, "invalid"],
      ["a numeric string", { usage: "3" }, "invalid"],
      ["a throwing getter", { throws: true }, "threw"],
      ["nothing", {}, "missing"],
    ])("%s → bills the route's fallbackUsage, usage.extract", async (_name, h, reason) => {
      lago.on("gate_checks", funded);
      const { url, settle } = await start(h);

      const res = await signingAgent().fetch(url, { method: "POST" });

      expect(res.status).toBe(200);
      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0].properties.value).toBe("250");
      expectReport("usage.extract", { reason });
      expect(reports[0].err).toBeInstanceOf(LagoX402UsageError);
      // A handler's exception text never reaches a report or the log.
      expect(reports[0].err.message).not.toContain(USAGE_GETTER_MESSAGE);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(USAGE_GETTER_MESSAGE);
    });
  });

  describe("security", () => {
    const FORGED = {
      host: "attacker.example",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
      forwarded: "host=attacker.example;proto=https",
    };

    it("forged Host / X-Forwarded-Host with trust proxy on never reach domain, uri or resource.url", async () => {
      lago.on("credit_purchases", settles);
      const { url, origin, settle } = await start({ trustProxy: true, usage: 1 });

      const challenge = await rawPost(url, FORGED);
      expect(challenge.status).toBe(402);
      const pr = decodePaymentRequiredHeader(challenge.headers["payment-required"] as string);
      expect(pr.resource.url).toBe(url);
      expect(signInOf(pr)).toMatchObject({ domain: new URL(origin).host, uri: url });

      // The official client pays from that 402; the paid request is forged the same way.
      const agent = evmAgent({ signIn: false, maxAmountPerPayment: "$10" });
      const payment = await agent.client.createPaymentPayload(pr);
      const header = agent.http.encodePaymentSignatureHeader(payment)["PAYMENT-SIGNATURE"];
      const paid = await rawPost(url, { ...FORGED, "payment-signature": header });

      expect(paid.status).toBe(200);
      expect(paymentOf(e8()[0]).resource.url).toBe(url);
      expect(JSON.stringify(lago.requests.map((r) => r.json))).not.toContain("attacker.example");
      expect(await settle()).toHaveLength(1);
    });

    it("concurrent agents do not share state", async () => {
      lago.on("gate_checks", funded);
      lago.on("credit_purchases", settles);
      const { url, settle } = await start({ usage: 4 });
      const agents = [...Array.from({ length: 4 }, signingAgent), ...Array.from({ length: 4 }, payingAgent)];

      const responses = await Promise.all(agents.map((a) => a.fetch(url, { method: "POST" })));

      responses.forEach((res, i) => {
        expect(res.status).toBe(200);
        const settled = res.headers.get("payment-response");
        if (i < 4) expect(settled).toBeNull();
        else expect(decodePaymentResponseHeader(settled!).payer).toBe(agents[i].agent.account.address);
      });
      expect(e8().map(payerOf).sort()).toStrictEqual(
        agents
          .slice(4)
          .map((a) => a.agent.account.address)
          .sort(),
      );
      const billed = await settle();
      expect(billed).toHaveLength(8);
      expect(new Set(billed.map((e) => e.transaction_id)).size).toBe(8);
      expect(billed.map((e) => e.external_subscription_id).sort()).toStrictEqual(
        agents.map((a) => subscriptionFor(a.agent.account.address)).sort(),
      );
      expect(reports).toStrictEqual([]);
    });
  });
});
