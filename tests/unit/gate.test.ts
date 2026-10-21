import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { safeBase64Encode } from "@x402/core/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateConfig, type LagoX402Config, type LagoX402ErrorWhere } from "../../src/config.js";
import { LagoApiError, LagoUnreachableError } from "../../src/errors.js";
import { Gate, type CallBilling, type GateDeps, type GateOutcome, type GateRequest } from "../../src/gate.js";
import { LagoClient } from "../../src/lago-client.js";
import { DEFAULT_SIGN_IN_STATEMENT, SIGN_IN_WITH_X, decodeSignInHeader } from "../../src/wire.js";
import { evmAgent, solanaPayment, type EvmAgent } from "../support/agent.js";
import { startFakeLago, type FakeAnswer, type FakeLago, type FakeRoute } from "../support/fake-lago.js";
import {
  BASE_SEPOLIA,
  SOLANA_DEVNET,
  evmRequirement,
  forbidden,
  gateCheckChallenge,
  gateCheckPass,
  hex32,
  notFound,
  settlement,
  solanaRequirement,
  thirdPartyError,
  unauthorized,
  validationErrors,
  type Requirement,
} from "../support/fixtures.js";

const ORIGIN = "https://api.merchant.example";
const TARGET = "/v1/generate";
const RESOURCE_URL = ORIGIN + TARGET;
const apiKey = "test-key-" + randomUUID();

const RESOURCE = { url: RESOURCE_URL, description: "Generate text", mimeType: "application/json" };
const WALLET = {
  name: "Agent credits",
  rate_amount: "1",
  currency: "USD",
  paid_top_up_min_amount_cents: 100,
  paid_top_up_max_amount_cents: 10000,
};
/** E7's exact raw body for this route, without `siwx`. */
const E7_BODY =
  '{"gate_check":{"connection_code":"conn_test","plan_code":"agents_plan","billable_metric_code":"tokens",' +
  '"wallet_code":"agents_wallet","amount_cents":500,"estimated_call_cost_cents":2}}';

/** Every `{siwx: [code]}` lago-api emits (`sign_in_with_x/verify_service.rb`, plus
 * `value_is_invalid` from `gate_checks/check_service.rb#input_errors` and `nonce_already_used`
 * from its `record_nonce`), and one code Lago may add later: any siwx refusal is a 401. */
const SIWX_CODES = [
  "value_is_invalid",
  "unsupported_version",
  "unsupported_chain",
  "domain_mismatch",
  "uri_mismatch",
  "issued_at_too_old",
  "issued_at_in_future",
  "expired",
  "not_yet_valid",
  "invalid_nonce",
  "invalid_address",
  "invalid_signature",
  "nonce_already_used",
  "a_future_siwx_code",
];

let lago: FakeLago;

beforeEach(async () => {
  lago = await startFakeLago();
});
afterEach(async () => {
  await lago.close();
});

interface Billed {
  route: string;
  externalSubscriptionId: string;
  billing: CallBilling;
}

function setup(
  o: {
    apiUrl?: string;
    timeouts?: LagoX402Config["timeouts"];
    report?: GateDeps["report"];
    billing?: GateDeps["billing"];
  } = {},
) {
  const config = validateConfig({
    apiUrl: o.apiUrl ?? lago.apiUrl,
    apiKey,
    connectionCode: "conn_test",
    origin: ORIGIN,
    routes: {
      generate: {
        billableMetric: "tokens",
        planCode: "agents_plan",
        walletCode: "agents_wallet",
        topUpAmountCents: 500,
        estimatedCallCostCents: 2,
        wallet: {
          name: "Agent credits",
          rateAmount: "1",
          paidTopUpMinAmountCents: 100,
          paidTopUpMaxAmountCents: 10000,
        },
        resource: { description: "Generate text", mimeType: "application/json" },
      },
    },
    ...(o.timeouts ? { timeouts: o.timeouts } : {}),
  });
  const route = config.routes.get("generate")!;
  const reports: { err: Error; where: LagoX402ErrorWhere }[] = [];
  const billed: Billed[] = [];
  const gate = new Gate({
    client: new LagoClient(config.apiUrl, config.apiKey),
    config,
    report: o.report ?? ((err, where) => void reports.push({ err, where })),
    billing:
      o.billing ??
      ((r, externalSubscriptionId) => {
        const billing: CallBilling = { finish: async () => {} };
        billed.push({ route: r.name, externalSubscriptionId, billing });
        return billing;
      }),
  });
  const handle = (headers: Record<string, string> = {}, target = TARGET) =>
    gate.handle(route, request(headers, target));
  return { gate, route, reports, billed, handle };
}

/** A request as an adapter hands it over: case-insensitive header lookup. */
function request(headers: Record<string, string> = {}, target = TARGET): GateRequest {
  const map = new Headers(headers);
  return { method: "POST", target, header: (name) => map.get(name) ?? undefined };
}

function responded(outcome: GateOutcome) {
  if (outcome.action !== "respond") throw new Error("expected a response, got serve");
  return outcome;
}

function served(outcome: GateOutcome) {
  if (outcome.action !== "serve") throw new Error(`expected serve, got ${outcome.status} ${outcome.body}`);
  return outcome;
}

/** Checks the 402 envelope and returns what the stock client decodes from it. */
function read402(outcome: GateOutcome): PaymentRequired {
  const r = responded(outcome);
  expect(r.status).toBe(402);
  expect(r.headers).toStrictEqual({
    "PAYMENT-REQUIRED": expect.any(String),
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  expect(r.body).toBe("{}");
  return decodePaymentRequiredHeader(r.headers["PAYMENT-REQUIRED"]);
}

interface SignInInfo {
  info: Record<string, string>;
  supportedChains: unknown;
}

function signInOf(pr: PaymentRequired): SignInInfo {
  return pr.extensions![SIGN_IN_WITH_X] as SignInInfo;
}

function expectRefusal(
  outcome: GateOutcome,
  status: number,
  body: Record<string, string>,
  retryAfter?: string,
): void {
  const r = responded(outcome);
  expect(r.status).toBe(status);
  expect(JSON.parse(r.body)).toStrictEqual(body);
  expect(r.headers).toStrictEqual({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
  });
}

const e7 = () => lago.requests.filter((r) => r.path === "/api/v1/x402/gate_checks");
const e8 = () => lago.requests.filter((r) => r.path === "/api/v1/x402/credit_purchases");

/** Answers `route` with `seq` in order, repeating the last answer. */
function answers(route: FakeRoute, ...seq: FakeAnswer[]): void {
  let i = 0;
  lago.on(route, () => seq[Math.min(i++, seq.length - 1)]);
}

function challengeWith(...requirements: Requirement[]): FakeAnswer {
  return { status: 200, body: gateCheckChallenge({ requirements }) };
}

function headerReader(outcome: GateOutcome): (name: string) => string | null {
  const headers = new Headers(outcome.headers);
  return (name) => headers.get(name);
}

/** The stock client's sign-in step (`wrapFetchWithPayment` runs these hooks on a 402). */
async function signIn(agent: EvmAgent, outcome: GateOutcome): Promise<string> {
  const paymentRequired = agent.http.getPaymentRequiredResponse(headerReader(responded(outcome)));
  const headers = await agent.http.handlePaymentRequired(paymentRequired, RESOURCE_URL);
  const proof = new Headers(headers ?? {}).get("SIGN-IN-WITH-X");
  if (proof === null) throw new Error("the agent did not sign in");
  return proof;
}

/** The stock client's payment step, with an optional tamper before encoding. */
async function pay(
  agent: EvmAgent,
  outcome: GateOutcome,
  tamper?: (payment: PaymentPayload) => void,
): Promise<string> {
  const paymentRequired = agent.http.getPaymentRequiredResponse(headerReader(responded(outcome)));
  const payment = await agent.client.createPaymentPayload(paymentRequired);
  tamper?.(payment);
  return agent.http.encodePaymentSignatureHeader(payment)["PAYMENT-SIGNATURE"];
}

/** The header's JSON, key order kept. */
function decoded(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
}

function acceptedOf(payment: PaymentPayload): Record<string, unknown> {
  return payment.accepted as unknown as Record<string, unknown>;
}

/** The payment as E8 must receive it: the header's JSON with `resource` reset to the 402's and
 * `extensions.bazaar` removed, every other key in place. */
function forwarded(header: string): Record<string, unknown> {
  const sent = decoded(header);
  const out: Record<string, unknown> = { ...sent, resource: RESOURCE };
  if (typeof sent.extensions === "object" && sent.extensions !== null) {
    const extensions = { ...(sent.extensions as Record<string, unknown>) };
    delete extensions.bazaar;
    out.extensions = extensions;
  }
  return out;
}

/** E8's exact raw body for a payment header. */
function expectedPurchase(header: string): string {
  return JSON.stringify({
    credit_purchase: {
      connection_code: "conn_test",
      plan_code: "agents_plan",
      wallet_code: "agents_wallet",
      wallet: WALLET,
      payment: forwarded(header),
      payment_requirements: decoded(header).accepted,
    },
  });
}

/** A paying EVM agent's header built from a leg-1 402 on the default menu; the recorded
 * requests are then cleared so assertions see leg 3 only. */
async function paidHeader(
  handle: () => Promise<GateOutcome>,
  tamper?: (payment: PaymentPayload) => void,
): Promise<{ agent: EvmAgent; header: string }> {
  const agent = evmAgent({ maxAmountPerPayment: "$10" });
  const header = await pay(agent, await handle(), tamper);
  lago.requests.length = 0;
  return { agent, header };
}

function nonceOf(outcome: GateOutcome): string {
  return signInOf(read402(outcome)).info.nonce;
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/api/v1`;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function expectReport(
  reports: { err: Error; where: LagoX402ErrorWhere }[],
  where: LagoX402ErrorWhere,
  match: object,
): void {
  expect(reports).toHaveLength(1);
  expect(reports[0].where).toBe(where);
  expect(reports[0].err).toMatchObject(match);
}

describe("support", () => {
  it("the fake Lago answers 500 when a handler throws", async () => {
    lago.on("events", () => {
      throw new Error("handler bug");
    });
    const res = await new LagoClient(lago.apiUrl, apiKey).request("events", "POST", "/events", {}, 5000);
    expect(res.status).toBe(500);
  });

  it("a pending settlement fixture has no subscription yet", () => {
    expect(settlement({ status: "pending" }).x402_settlement.external_subscription_id).toBeNull();
    expect(settlement().x402_settlement.external_subscription_id).toMatch(/^x402_sub_/);
  });
});

describe("leg 1: no header", () => {
  it("a stranger gets 402 with PAYMENT-REQUIRED, Cache-Control no-store and body {}", async () => {
    answers("gate_checks", challengeWith(evmRequirement(), solanaRequirement()));
    const { handle, reports, billed } = setup();

    const pr = read402(await handle());

    expect(pr.x402Version).toBe(2);
    expect(pr.error).toBeUndefined();
    expect(pr.resource).toStrictEqual(RESOURCE);
    const evm = evmRequirement();
    const sol = solanaRequirement();
    expect(pr.accepts).toStrictEqual([
      {
        scheme: "exact",
        network: BASE_SEPOLIA,
        amount: "5000000",
        asset: evm.asset_address,
        payTo: evm.pay_to,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
      {
        scheme: "exact",
        network: SOLANA_DEVNET,
        amount: "5000000",
        asset: sol.asset_address,
        payTo: sol.pay_to,
        maxTimeoutSeconds: 60,
        extra: { feePayer: sol.extra!.feePayer },
      },
    ]);
    expect(Object.keys(pr.extensions!)).toEqual([SIGN_IN_WITH_X]);
    const signInChallenge = signInOf(pr);
    expect(signInChallenge.info).toMatchObject({
      domain: "api.merchant.example",
      uri: RESOURCE_URL,
      statement: DEFAULT_SIGN_IN_STATEMENT,
      version: "1",
    });
    expect(signInChallenge.supportedChains).toStrictEqual([
      { chainId: BASE_SEPOLIA, type: "eip191" },
      { chainId: SOLANA_DEVNET, type: "ed25519" },
    ]);

    expect(e7()).toHaveLength(1);
    expect(e7()[0].rawBody).toBe(E7_BODY);
    expect(e8()).toHaveLength(0);
    expect(reports).toEqual([]);
    expect(billed).toEqual([]);
  });

  it("two 402s never share a nonce", async () => {
    const { handle } = setup();
    const first = nonceOf(await handle());
    const second = nonceOf(await handle());
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });

  it("an E7 pass without a sign-in is 503 and reported", async () => {
    answers("gate_checks", { status: 200, body: gateCheckPass() });
    const { handle, reports, billed } = setup();

    expectRefusal(await handle(), 503, { error: "unavailable" });

    expectReport(reports, "gate.check", { endpoint: "gate_checks", status: 200, code: "unexpected_pass" });
    expect(reports[0].err).toBeInstanceOf(LagoApiError);
    expect(billed).toEqual([]);
  });

  it.each<[string, FakeAnswer, object]>([
    ["connection_not_found", { status: 404, body: notFound("connection") }, { status: 404 }],
    ["a forbidden key", { status: 403, body: forbidden("feature_unavailable") }, { status: 403 }],
    ["a bad key", { status: 401, body: unauthorized() }, { status: 401 }],
    ["a facilitator outage", { status: 422, body: thirdPartyError() }, { code: "third_party_error" }],
    ["a 500", { status: 500 }, { status: 500 }],
    ["a 201", { status: 201, body: gateCheckChallenge() }, { status: 201 }],
    ["an unreadable 200", { status: 200, body: { gate_check: null } }, { code: "unexpected_answer" }],
  ])("E7 %s fails closed as 503 unavailable and is reported", async (_name, answer, match) => {
    answers("gate_checks", answer);
    const { handle, reports } = setup();
    expectRefusal(await handle(), 503, { error: "unavailable" });
    expectReport(reports, "gate.check", { endpoint: "gate_checks", ...match });
    expect(reports[0].err).toBeInstanceOf(LagoApiError);
  });
});

describe("leg 2: SIGN-IN-WITH-X", () => {
  it("a signed-in funded agent is served and billed with E7's subscription", async () => {
    const { handle, reports, billed } = setup();
    const proof = await signIn(evmAgent(), await handle());
    const pass = gateCheckPass();
    answers("gate_checks", { status: 200, body: pass });

    const outcome = served(await handle({ "SIGN-IN-WITH-X": proof }));

    expect(outcome.headers).toStrictEqual({ "Cache-Control": "private" });
    expect(billed).toEqual([
      {
        route: "generate",
        externalSubscriptionId: pass.gate_check.external_subscription_id,
        billing: outcome.billing,
      },
    ]);
    expect(outcome.billing).toBe(billed[0].billing);
    expect(e7()).toHaveLength(2);
    expect(e8()).toHaveLength(0);
    expect(reports).toEqual([]);
  });

  it("siwx reaches E7 exactly as decoded", async () => {
    const { handle } = setup();
    const proof = await signIn(evmAgent(), await handle());
    answers("gate_checks", { status: 200, body: gateCheckPass() });
    await handle({ "SIGN-IN-WITH-X": proof });

    const proofJson = Buffer.from(proof, "base64").toString("utf8");
    const sent = e7()[1];
    expect(JSON.stringify((sent.json as { gate_check: { siwx: unknown } }).gate_check.siwx)).toBe(proofJson);
    expect(sent.rawBody).toBe(E7_BODY.slice(0, -2) + `,"siwx":${proofJson}}}`);

    // Unknown keys, nesting and key order survive untouched (Lago reads `siwx` from the raw body).
    const odd = '{"zeta":"z","address":"0xabc","nested":{"b":1,"a":[2,{"y":null,"x":true}]},"issuedAt":"t"}';
    await handle({ "SIGN-IN-WITH-X": safeBase64Encode(odd) });
    expect(e7()[2].rawBody).toBe(E7_BODY.slice(0, -2) + `,"siwx":${odd}}}`);
  });

  it("an agent out of credits gets 402", async () => {
    const { handle, reports, billed } = setup();
    const first = await handle();
    const proof = await signIn(evmAgent(), first);

    const pr = read402(await handle({ "SIGN-IN-WITH-X": proof }));

    expect(pr.error).toBeUndefined();
    expect(signInOf(pr).info.nonce).not.toBe(nonceOf(first));
    expect(e7()[1].rawBody).toContain('"siwx":');
    expect(e8()).toHaveLength(0);
    expect(reports).toEqual([]);
    expect(billed).toEqual([]);
  });

  it.each(SIWX_CODES)("every siwx refusal is 401, never 402 (%s)", async (code) => {
    answers("gate_checks", { status: 422, body: validationErrors({ siwx: [code] }) });
    const { handle, reports, billed } = setup();
    const proof = safeBase64Encode(JSON.stringify({ address: "0xabc", nonce: "abcdef12" }));

    expectRefusal(await handle({ "SIGN-IN-WITH-X": proof }), 401, {
      error: "sign_in_rejected",
      reason: code,
    });

    expect(reports).toEqual([]);
    expect(billed).toEqual([]);
  });

  it.each(["!!!", "", b64("{bad"), b64("[]"), b64("null"), b64('"text"')])(
    "an undecodable SIGN-IN-WITH-X is 401 with no Lago call (%j)",
    async (header) => {
      const { handle, reports } = setup();
      expectRefusal(await handle({ "SIGN-IN-WITH-X": header }), 401, {
        error: "sign_in_rejected",
        reason: "invalid_header",
      });
      expect(lago.requests).toHaveLength(0);
      expect(reports).toEqual([]);
    },
  );

  it("an unknown buyer is 403 and a pending purchase is 503 Retry-After", async () => {
    const { handle, reports } = setup();
    const proof = safeBase64Encode(JSON.stringify({ address: "0xabc" }));

    answers("gate_checks", { status: 422, body: validationErrors({ base: ["buyer_not_recognized"] }) });
    expectRefusal(await handle({ "SIGN-IN-WITH-X": proof }), 403, { error: "buyer_not_recognized" });

    answers("gate_checks", { status: 422, body: validationErrors({ base: ["credit_purchase_pending"] }) });
    expectRefusal(await handle({ "SIGN-IN-WITH-X": proof }), 503, { error: "payment_pending" }, "30");

    expect(reports).toEqual([]);
  });
});

describe("leg 3: PAYMENT-SIGNATURE", () => {
  it("a paid request is matched against a fresh E7 menu and forwarded unchanged apart from resource and extensions.bazaar", async () => {
    const { handle, reports } = setup();
    const { header } = await paidHeader(handle, (payment) => {
      payment.resource = { url: "https://attacker.example/elsewhere", description: "spoofed" };
      payment.extensions = { ...payment.extensions, bazaar: { info: { input: { type: "http" } } } };
    });
    const sent = decoded(header);
    expect(Object.keys(sent.extensions as object)).toEqual([SIGN_IN_WITH_X, "bazaar"]);

    served(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(e7()).toHaveLength(1);
    expect(e7()[0].rawBody).toBe(E7_BODY);
    expect(e8()).toHaveLength(1);
    const raw = e8()[0].rawBody;
    expect(raw).toBe(expectedPurchase(header));
    const purchase = (e8()[0].json as { credit_purchase: Record<string, Record<string, unknown>> })
      .credit_purchase;
    expect(Object.keys(purchase)).toEqual([
      "connection_code",
      "plan_code",
      "wallet_code",
      "wallet",
      "payment",
      "payment_requirements",
    ]);
    expect(purchase.wallet).toStrictEqual(WALLET);
    expect(purchase.payment_requirements).toStrictEqual(sent.accepted);
    expect(purchase.payment.resource).toStrictEqual(RESOURCE);
    expect(Object.keys(purchase.payment)).toEqual(Object.keys(sent));
    expect(Object.keys(purchase.payment.extensions as object)).toEqual([SIGN_IN_WITH_X]);
    expect(purchase.payment.payload).toStrictEqual(sent.payload);
    expect(raw).not.toMatch(/"mode"|agent_address|attacker|spoofed/);
    expect(reports).toEqual([]);
  });

  it("served with PAYMENT-RESPONSE {success, transaction, network, payer} and private Cache-Control", async () => {
    const { handle, reports, billed } = setup();
    const { agent, header } = await paidHeader(handle);
    const answer = settlement();
    answers("credit_purchases", { status: 200, body: answer });

    const outcome = served(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(Object.keys(outcome.headers)).toEqual(["PAYMENT-RESPONSE", "Cache-Control"]);
    expect(outcome.headers["Cache-Control"]).toBe("private");
    expect(agent.http.getPaymentSettleResponse(headerReader(outcome))).toStrictEqual({
      success: true,
      transaction: answer.x402_settlement.transaction_hash,
      network: BASE_SEPOLIA,
      payer: answer.x402_settlement.payer_address,
    });
    expect(billed).toEqual([
      {
        route: "generate",
        externalSubscriptionId: answer.x402_settlement.external_subscription_id,
        billing: outcome.billing,
      },
    ]);
    expect(reports).toEqual([]);
  });

  it.each<[string, Requirement]>([
    ["amount", evmRequirement({ amountCents: 1000 })],
    ["payTo", evmRequirement({ payTo: "0x00000000000000000000000000000000000b0b02" })],
    ["extra", { ...evmRequirement(), extra: { name: "USDC", version: "1" } }],
  ])("%s changed between 402 and payment → fresh 402, no E8 call", async (_field, changed) => {
    const { handle, reports, billed } = setup();
    const first = await handle();
    const agent = evmAgent({ maxAmountPerPayment: "$10" });
    const header = await pay(agent, first);
    answers("gate_checks", challengeWith(changed));
    lago.requests.length = 0;

    const pr = read402(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(pr.error).toBe("stale_challenge");
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({
      amount: changed.amount_atomic,
      payTo: changed.pay_to,
      extra: changed.extra,
    });
    expect(signInOf(pr).info.nonce).not.toBe(nonceOf(first));
    expect(e7()).toHaveLength(1);
    expect(e8()).toHaveLength(0);
    expect(reports).toEqual([]);
    expect(billed).toEqual([]);
  });

  it("extra is compared deeply, whatever its key order", async () => {
    const extra = { name: "USDC", version: "2", nested: { list: [1, { deep: true }], flag: null } };
    const reordered = { nested: { flag: null, list: [1, { deep: true }] }, version: "2", name: "USDC" };
    const changed = { name: "USDC", version: "2", nested: { list: [1, { deep: false }], flag: null } };
    const { handle } = setup();
    answers("gate_checks", challengeWith({ ...evmRequirement(), extra: extra as never }));
    const { header } = await paidHeader(handle);

    answers("gate_checks", challengeWith({ ...evmRequirement(), extra: changed as never }));
    expect(read402(await handle({ "PAYMENT-SIGNATURE": header })).error).toBe("stale_challenge");
    expect(e8()).toHaveLength(0);

    answers("gate_checks", challengeWith({ ...evmRequirement(), extra: reordered as never }));
    served(await handle({ "PAYMENT-SIGNATURE": header }));
    expect(e8()).toHaveLength(1);
    expect(e8()[0].rawBody).toBe(expectedPurchase(header));
  });

  it.each<[string, (accepted: Record<string, unknown>) => void]>([
    ["an added key in accepted", (a) => void (a.description = "one more key")],
    ["a missing extra", (a) => void delete a.extra],
    ["a numeric amount", (a) => void (a.amount = Number(a.amount))],
    ["a string maxTimeoutSeconds", (a) => void (a.maxTimeoutSeconds = String(a.maxTimeoutSeconds))],
    ["an upper-cased payTo", (a) => void (a.payTo = String(a.payTo).toUpperCase())],
    ["an added extra key", (a) => void (a.extra = { ...(a.extra as object), chainId: 84532 })],
  ])("%s → fresh 402, no E8 call", async (_name, tamper) => {
    const { handle, reports } = setup();
    const { header } = await paidHeader(handle, (payment) => tamper(acceptedOf(payment)));

    expect(read402(await handle({ "PAYMENT-SIGNATURE": header })).error).toBe("stale_challenge");

    expect(e7()).toHaveLength(1);
    expect(e8()).toHaveLength(0);
    expect(reports).toEqual([]);
  });

  const FEE_PAYER_402 = "FeePayerOfTheFirstChallengeAAAAAAAAAAAAAAAA1";
  const FEE_PAYER_NOW = "FeePayerOfTheFreshChallengeBBBBBBBBBBBBBBBB2";

  /** A Solana payment built from a 402 whose menu advertised FEE_PAYER_402; E7 now
   * advertises FEE_PAYER_NOW. */
  async function solanaHeader(
    handle: () => Promise<GateOutcome>,
    tamper?: (accepted: Record<string, unknown>) => void,
  ): Promise<string> {
    answers("gate_checks", challengeWith(evmRequirement(), solanaRequirement({ feePayer: FEE_PAYER_402 })));
    const pr = read402(await handle());
    const accepted = structuredClone(pr.accepts[1]);
    tamper?.(accepted as unknown as Record<string, unknown>);
    const header = encodePaymentSignatureHeader(
      solanaPayment(accepted as PaymentRequirements, pr.extensions!),
    );
    answers("gate_checks", challengeWith(evmRequirement(), solanaRequirement({ feePayer: FEE_PAYER_NOW })));
    lago.requests.length = 0;
    return header;
  }

  it("a Solana payment matches when E7 now advertises another fee payer", async () => {
    const { handle, reports } = setup();
    const header = await solanaHeader(handle);
    answers("credit_purchases", {
      status: 200,
      body: settlement({
        network: SOLANA_DEVNET,
        payer_address: "PayerFakeFakeFakeFakeFakeFakeFakeFakeFake3",
      }),
    });

    served(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(e8()).toHaveLength(1);
    expect(e8()[0].rawBody).toBe(expectedPurchase(header));
    const purchase = (e8()[0].json as { credit_purchase: { payment_requirements: { extra: object } } })
      .credit_purchase;
    expect(purchase.payment_requirements.extra).toStrictEqual({ feePayer: FEE_PAYER_402 });
    expect(reports).toEqual([]);
  });

  it.each<[string, (accepted: Record<string, unknown>) => void]>([
    ["amount", (a) => void (a.amount = "1")],
    ["payTo", (a) => void (a.payTo = "PayToOtherOtherOtherOtherOtherOtherOtherOth9")],
    ["asset", (a) => void (a.asset = "AssetOtherOtherOtherOtherOtherOtherOtherOth8")],
    ["maxTimeoutSeconds", (a) => void (a.maxTimeoutSeconds = 120)],
    ["scheme", (a) => void (a.scheme = "upto")],
    ["network", (a) => void (a.network = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")],
    ["an added extra key", (a) => void (a.extra = { ...(a.extra as object), memo: "x" })],
    ["an empty feePayer", (a) => void (a.extra = { feePayer: "" })],
    ["a numeric feePayer", (a) => void (a.extra = { feePayer: 7 })],
    ["no feePayer", (a) => void (a.extra = {})],
    ["an added key in accepted", (a) => void (a.description = "x")],
  ])("a Solana payment with any other field changed does not match (%s)", async (_name, tamper) => {
    const { handle } = setup();
    const header = await solanaHeader(handle, tamper);

    expect(read402(await handle({ "PAYMENT-SIGNATURE": header })).error).toBe("stale_challenge");

    expect(e7()).toHaveLength(1);
    expect(e8()).toHaveLength(0);
  });

  it("both headers: the payment wins and siwx is not sent", async () => {
    const { handle, billed } = setup();
    const agent = evmAgent({ maxAmountPerPayment: "$10" });
    const first = await handle();
    const proof = await signIn(agent, first);
    const header = await pay(agent, first);
    lago.requests.length = 0;
    const answer = settlement();
    answers("credit_purchases", { status: 200, body: answer });

    served(await handle({ "PAYMENT-SIGNATURE": header, "SIGN-IN-WITH-X": proof }));

    expect(e7()).toHaveLength(1);
    expect(e7()[0].rawBody).toBe(E7_BODY);
    expect(e8()).toHaveLength(1);
    expect(e8()[0].rawBody).toBe(expectedPurchase(header));
    const signature = decodeSignInHeader(proof)!.signature as string;
    for (const req of lago.requests) {
      expect(req.rawBody).not.toContain(signature);
      expect(req.rawBody).not.toContain('"siwx"');
    }
    expect(billed.map((b) => b.externalSubscriptionId)).toEqual([
      answer.x402_settlement.external_subscription_id,
    ]);
  });

  it("E8 pending → 503 Retry-After from reconcile_after", async () => {
    const { handle, reports, billed } = setup();
    const { header } = await paidHeader(handle);
    const reconcileAfter = new Date(Date.now() + 90_000).toISOString().replace(/\.\d+Z$/, "Z");
    answers("credit_purchases", {
      status: 200,
      body: settlement({ status: "pending", replayed: true, reconcile_after: reconcileAfter }),
    });

    const r = responded(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toStrictEqual({ error: "payment_pending" });
    expect(r.headers).toStrictEqual({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": expect.stringMatching(/^\d+$/),
    });
    expect(Number(r.headers["Retry-After"])).toBeGreaterThanOrEqual(88);
    expect(Number(r.headers["Retry-After"])).toBeLessThanOrEqual(90);
    expect(e8()).toHaveLength(1);
    expect(reports).toEqual([]);
    expect(billed).toEqual([]);
  });

  it("a replay is served with the original grant's external_subscription_id", async () => {
    const { handle, billed } = setup();
    const { header } = await paidHeader(handle);
    answers("credit_purchases", {
      status: 200,
      body: settlement({ replayed: true, external_subscription_id: "x402_sub_original_grant" }),
    });

    const outcome = served(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(outcome.headers["PAYMENT-RESPONSE"]).toEqual(expect.any(String));
    expect(billed).toEqual([
      { route: "generate", externalSubscriptionId: "x402_sub_original_grant", billing: outcome.billing },
    ]);
  });

  const grantFailed: FakeAnswer = {
    status: 422,
    body: validationErrors({ base: ["credit_grant_failed"] }),
  };

  it("credit_grant_failed → one identical E8 retry → served", async () => {
    const { handle, reports, billed } = setup();
    const { header } = await paidHeader(handle);
    answers("credit_purchases", grantFailed, { status: 200, body: settlement() });

    served(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(e8()).toHaveLength(2);
    expect(e8()[0].rawBody).toBe(expectedPurchase(header));
    expect(e8()[1].rawBody).toBe(e8()[0].rawBody);
    expect(e7()).toHaveLength(1);
    expect(billed).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it("credit_grant_failed twice → 503 Retry-After, never 402", async () => {
    const { handle, reports, billed } = setup();
    const { header } = await paidHeader(handle);
    answers("credit_purchases", grantFailed, grantFailed, { status: 200, body: settlement() });

    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "payment_pending" }, "30");

    expect(e8()).toHaveLength(2);
    expect(e8()[1].rawBody).toBe(e8()[0].rawBody);
    expectReport(reports, "gate.purchase", {
      endpoint: "credit_purchases",
      status: 422,
      errorCodes: { base: ["credit_grant_failed"] },
    });
    expect(billed).toEqual([]);
  });

  it("a destroyed socket on E8 is retried once", async () => {
    const { handle, reports } = setup();
    const { header } = await paidHeader(handle);
    answers("credit_purchases", { status: 200, destroySocket: true }, { status: 200, body: settlement() });

    served(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(e8()).toHaveLength(2);
    expect(e8()[1].rawBody).toBe(e8()[0].rawBody);
    expect(reports).toEqual([]);
  });

  it("two destroyed sockets on E8 → 503 Retry-After 30, reported", async () => {
    const { handle, reports } = setup();
    const { header } = await paidHeader(handle);
    answers("credit_purchases", { status: 200, destroySocket: true });

    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "payment_pending" }, "30");

    expect(e8()).toHaveLength(2);
    expectReport(reports, "gate.purchase", { endpoint: "credit_purchases", reason: "network" });
    expect(reports[0].err).toBeInstanceOf(LagoUnreachableError);
  });

  it("any 5xx from E8 is retried once with the identical body", async () => {
    const { handle, reports } = setup();
    const { header } = await paidHeader(handle);
    let calls = 0;
    lago.on("credit_purchases", () => {
      if (calls++ === 0) throw new Error("Lago crashed after settling"); // the fake answers 500
      return { status: 200, body: settlement({ replayed: true }) };
    });

    served(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(e8()).toHaveLength(2);
    expect(e8()[1].rawBody).toBe(e8()[0].rawBody);
    expect(reports).toEqual([]);
  });

  it("E8 timeout → 503 Retry-After, one E8 call only", async () => {
    const { handle, reports } = setup({ timeouts: { creditPurchaseMs: 300 } });
    const { header } = await paidHeader(handle);
    answers("credit_purchases", { status: 200, body: settlement(), delayMs: 2000 });

    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "payment_pending" }, "30");

    expect(e8()).toHaveLength(1);
    expectReport(reports, "gate.purchase", { endpoint: "credit_purchases", reason: "timeout" });
  });

  it("an E8 retry only runs with at least 1 s of the budget left", async () => {
    const { handle, reports } = setup({ timeouts: { creditPurchaseMs: 1500 } });
    const { header } = await paidHeader(handle);
    answers("credit_purchases", { status: 502, delayMs: 700 }, { status: 200, body: settlement() });

    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "payment_pending" }, "30");

    expect(e8()).toHaveLength(1);
    expectReport(reports, "gate.purchase", { endpoint: "credit_purchases", status: 502 });
  });

  it("the E8 retry's timeout is what remains of the budget", async () => {
    const { handle, reports } = setup({ timeouts: { creditPurchaseMs: 3000 } });
    const { header } = await paidHeader(handle);
    answers(
      "credit_purchases",
      { status: 200, destroySocket: true, delayMs: 1500 },
      { status: 200, body: settlement(), delayMs: 5000 },
    );

    const started = Date.now();
    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "payment_pending" }, "30");
    const elapsed = Date.now() - started;

    expect(e8()).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(3900); // a fresh 3 s timeout would end near 4.5 s
    expectReport(reports, "gate.purchase", { endpoint: "credit_purchases", reason: "timeout" });
  });

  it("an E8 200 that cannot be read is 503 payment_pending, never 402", async () => {
    const { handle, reports, billed } = setup();
    const { header } = await paidHeader(handle);
    answers("credit_purchases", { status: 200, body: { x402_settlement: { status: "settled" } } });

    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "payment_pending" }, "30");

    expect(e8()).toHaveLength(1);
    expectReport(reports, "gate.purchase", {
      endpoint: "credit_purchases",
      status: 200,
      code: "unexpected_answer",
    });
    expect(billed).toEqual([]);
  });

  it.each<[string, FakeAnswer, number, Record<string, string>, string | undefined, boolean]>([
    [
      "recorded_as_invoice_payment",
      { status: 422, body: validationErrors({ payment: ["recorded_as_invoice_payment"] }) },
      409,
      { error: "payment_already_used" },
      undefined,
      true,
    ],
    [
      "buyer_not_recognized",
      { status: 422, body: validationErrors({ base: ["buyer_not_recognized"] }) },
      403,
      { error: "buyer_not_recognized" },
      undefined,
      false,
    ],
    [
      "credit_purchase_pending",
      { status: 422, body: validationErrors({ base: ["credit_purchase_pending"] }) },
      503,
      { error: "payment_pending" },
      "30",
      false,
    ],
    [
      "amount_above_maximum",
      { status: 422, body: validationErrors({ payment_requirements: ["amount_above_maximum"] }) },
      503,
      { error: "unavailable" },
      undefined,
      true,
    ],
    [
      "third_party_error",
      { status: 422, body: thirdPartyError() },
      503,
      { error: "unavailable" },
      undefined,
      true,
    ],
  ])("E8 %s maps through the error table", async (_name, answer, status, body, retryAfter, reported) => {
    const { handle, reports, billed } = setup();
    const { header } = await paidHeader(handle);
    answers("credit_purchases", answer);

    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), status, body, retryAfter);

    expect(e8()).toHaveLength(1);
    expect(reports.map((r) => r.where)).toEqual(reported ? ["gate.purchase"] : []);
    expect(billed).toEqual([]);
  });

  it("an E8 payment refusal answers a fresh 402 from the same E7 menu", async () => {
    const { handle, reports } = setup();
    const first = await handle();
    const header = await pay(evmAgent({ maxAmountPerPayment: "$10" }), first);
    lago.requests.length = 0;
    answers("credit_purchases", {
      status: 422,
      body: validationErrors({ payment: ["invalid_exact_evm_payload_signature"] }),
    });

    const pr = read402(await handle({ "PAYMENT-SIGNATURE": header }));

    expect(pr.error).toBe("invalid_exact_evm_payload_signature");
    expect(pr.accepts).toStrictEqual(read402(first).accepts);
    expect(signInOf(pr).info.nonce).not.toBe(nonceOf(first));
    expect(e7()).toHaveLength(1);
    expect(e8()).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it.each(["!!!", b64("{bad"), b64(JSON.stringify({ x402Version: 1, payload: {}, accepted: {} }))])(
    "an undecodable PAYMENT-SIGNATURE costs one E7 and answers 402 invalid_payment (%j)",
    async (header) => {
      const { handle, reports } = setup();

      expect(read402(await handle({ "PAYMENT-SIGNATURE": header })).error).toBe("invalid_payment");

      expect(e7()).toHaveLength(1);
      expect(e7()[0].rawBody).toBe(E7_BODY);
      expect(e8()).toHaveLength(0);
      expect(reports).toEqual([]);
    },
  );

  it("an E7 pass on leg 3 is 503 and reported, with no E8 call", async () => {
    const { handle, reports } = setup();
    const { header } = await paidHeader(handle);
    answers("gate_checks", { status: 200, body: gateCheckPass() });

    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "unavailable" });

    expect(e8()).toHaveLength(0);
    expectReport(reports, "gate.check", { endpoint: "gate_checks", code: "unexpected_pass" });
  });

  it("an E7 refusal on leg 3 maps like leg 1, with no E8 call", async () => {
    const { handle, reports } = setup();
    const { header } = await paidHeader(handle);
    answers("gate_checks", { status: 404, body: notFound("connection") });

    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "unavailable" });

    expect(e8()).toHaveLength(0);
    expectReport(reports, "gate.check", {
      endpoint: "gate_checks",
      status: 404,
      code: "connection_not_found",
    });
  });

  it("E7 timeout → 503", async () => {
    const { header } = await paidHeader(setup().handle);
    const { handle, reports } = setup({ timeouts: { gateCheckMs: 200 } });
    answers("gate_checks", { ...challengeWith(evmRequirement()), delayMs: 2000 });

    expectRefusal(await handle(), 503, { error: "unavailable" });
    expectRefusal(await handle({ "PAYMENT-SIGNATURE": header }), 503, { error: "unavailable" });

    expect(e8()).toHaveLength(0);
    expect(reports.map((r) => r.where)).toEqual(["gate.check", "gate.check"]);
    for (const { err } of reports) {
      expect(err).toBeInstanceOf(LagoUnreachableError);
      expect(err).toMatchObject({ endpoint: "gate_checks", reason: "timeout" });
    }
  });

  it("Lago port closed → 503", async () => {
    const { handle, reports, billed } = setup({ apiUrl: await closedPortUrl() });
    const proof = safeBase64Encode(JSON.stringify({ address: "0xabc" }));
    const payment = b64(JSON.stringify({ x402Version: 2, accepted: {}, payload: {} }));

    expectRefusal(await handle(), 503, { error: "unavailable" });
    expectRefusal(await handle({ "SIGN-IN-WITH-X": proof }), 503, { error: "unavailable" });
    expectRefusal(await handle({ "PAYMENT-SIGNATURE": payment }), 503, { error: "unavailable" });

    expect(reports.map((r) => r.where)).toEqual(["gate.check", "gate.check", "gate.check"]);
    for (const { err } of reports) expect(err).toMatchObject({ endpoint: "gate_checks", reason: "network" });
    expect(billed).toEqual([]);
  });
});

describe("never rejects", () => {
  it("an unexpected throw becomes 503 unavailable, reported without its message", async () => {
    const secret = "secret-" + randomUUID();
    const { handle, reports } = setup({
      billing: () => {
        throw new TypeError(`billing exploded with ${secret}`);
      },
    });
    const proof = safeBase64Encode(JSON.stringify({ address: "0xabc" }));
    answers("gate_checks", { status: 200, body: gateCheckPass() });

    expectRefusal(await handle({ "SIGN-IN-WITH-X": proof }), 503, { error: "unavailable" });

    expect(reports).toHaveLength(1);
    expect(reports[0].where).toBe("gate.check");
    expect(reports[0].err.message).toContain("TypeError");
    expect(inspect(reports[0].err)).not.toContain(secret);
  });

  it("a throwing reporter does not make the gate reject", async () => {
    const { handle } = setup({
      report: () => {
        throw new Error("reporter down");
      },
    });
    answers("gate_checks", { status: 200, body: gateCheckPass() });
    expectRefusal(await handle(), 503, { error: "unavailable" });
  });
});

describe("security", () => {
  it("Host, X-Forwarded-Host and absolute-form targets never reach domain, uri or resource.url", async () => {
    const { gate, route } = setup();
    const hostile = {
      Host: "attacker.example",
      "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "http",
      Forwarded: "host=attacker.example;proto=http",
    };
    const targets = [
      TARGET,
      "https://attacker.example/v1/generate",
      "http://attacker.example:8080/v1/generate?next=https://attacker.example",
      "//attacker.example/v1/generate",
    ];
    let first: GateOutcome | undefined;
    for (const target of targets) {
      const outcome = await gate.handle(route, request(hostile, target));
      first ??= outcome;
      const pr = read402(outcome);
      expect(pr.resource.url).toBe(RESOURCE_URL);
      expect(signInOf(pr).info.domain).toBe("api.merchant.example");
      expect(signInOf(pr).info.uri).toBe(RESOURCE_URL);
      expect(JSON.stringify(pr)).not.toContain("attacker");
    }

    // Leg 3 behind the same proxy: E8's payment.resource is still the configured origin.
    const header = await pay(evmAgent({ maxAmountPerPayment: "$10" }), first!);
    lago.requests.length = 0;
    served(
      await gate.handle(
        route,
        request({ ...hostile, "PAYMENT-SIGNATURE": header }, "https://attacker.example/v1/generate"),
      ),
    );
    expect(e8()[0].rawBody).toBe(expectedPurchase(header));
    expect(e8()[0].rawBody).not.toContain("attacker");
  });

  it("50 concurrent mixed requests: nonces unique, each E8 body carries its own payment", async () => {
    lago.on("gate_checks", (req) => {
      const siwx = (req.json as { gate_check: { siwx?: { address: string } } }).gate_check.siwx;
      return siwx
        ? { status: 200, body: gateCheckPass({ external_subscription_id: `x402_sub_${siwx.address}` }) }
        : { status: 200, body: gateCheckChallenge() };
    });
    lago.on("credit_purchases", (req) => {
      const { from } = (
        req.json as { credit_purchase: { payment: { payload: { authorization: { from: string } } } } }
      ).credit_purchase.payment.payload.authorization;
      return {
        status: 200,
        body: settlement({
          payer_address: from,
          transaction_hash: hex32("cd"),
          external_subscription_id: `x402_sub_${from}`,
        }),
      };
    });
    const { gate, route, billed, reports } = setup();
    const nonces: string[] = [];
    const challenge = async () => {
      const outcome = await gate.handle(route, request());
      nonces.push(nonceOf(outcome));
      return outcome;
    };

    type Job =
      | { kind: "stranger" }
      | { kind: "signIn"; proof: string; address: string }
      | { kind: "pay"; header: string; address: string };
    const jobs: Job[] = await Promise.all(
      Array.from({ length: 50 }, async (_, i): Promise<Job> => {
        if (i % 3 === 0) return { kind: "stranger" };
        if (i % 3 === 1) {
          const proof = await signIn(evmAgent(), await challenge());
          return { kind: "signIn", proof, address: decodeSignInHeader(proof)!.address as string };
        }
        const agent = evmAgent({ maxAmountPerPayment: "$10" });
        return { kind: "pay", header: await pay(agent, await challenge()), address: agent.account.address };
      }),
    );
    lago.requests.length = 0;

    const outcomes = await Promise.all(
      jobs.map((job) =>
        gate.handle(
          route,
          request(
            job.kind === "stranger"
              ? {}
              : job.kind === "signIn"
                ? { "SIGN-IN-WITH-X": job.proof }
                : { "PAYMENT-SIGNATURE": job.header },
          ),
        ),
      ),
    );

    const agent = evmAgent();
    jobs.forEach((job, i) => {
      const outcome = outcomes[i];
      if (job.kind === "stranger") {
        nonces.push(nonceOf(outcome));
      } else if (job.kind === "signIn") {
        const { billing } = served(outcome);
        expect(billed.find((b) => b.billing === billing)?.externalSubscriptionId).toBe(
          `x402_sub_${job.address}`,
        );
      } else {
        const { billing } = served(outcome);
        expect(agent.http.getPaymentSettleResponse(headerReader(outcome)).payer).toBe(job.address);
        expect(billed.find((b) => b.billing === billing)?.externalSubscriptionId).toBe(
          `x402_sub_${job.address}`,
        );
      }
    });
    expect(nonces).toHaveLength(50);
    expect(new Set(nonces).size).toBe(50);
    const paid = jobs.flatMap((job) => (job.kind === "pay" ? [expectedPurchase(job.header)] : []));
    expect(
      e8()
        .map((r) => r.rawBody)
        .sort(),
    ).toEqual(paid.sort());
    expect(e7()).toHaveLength(50);
    expect(reports).toEqual([]);
  });

  it("outcomes and reports never carry header values, the API key or Lago's free text", async () => {
    const { handle, reports } = setup();
    const signature = "cd".repeat(65);
    const leakyPayment = b64(`{"x402Version":2,"payload":{"signature":${signature}}}`);
    const leakyProof = b64(`{"signature":${signature}`);
    const outcomes: GateOutcome[] = [];

    outcomes.push(await handle({ "PAYMENT-SIGNATURE": leakyPayment }));
    outcomes.push(await handle({ "SIGN-IN-WITH-X": leakyProof }));
    const { header } = await paidHeader(handle);
    answers("credit_purchases", { status: 422, body: thirdPartyError() });
    outcomes.push(await handle({ "PAYMENT-SIGNATURE": header }));
    answers("gate_checks", { status: 422, body: thirdPartyError() });
    outcomes.push(await handle());
    answers("gate_checks", { status: 401, body: unauthorized() });
    const proof = safeBase64Encode(JSON.stringify({ address: "0xabc", signature }));
    outcomes.push(await handle({ "SIGN-IN-WITH-X": proof }));

    expect(reports.length).toBeGreaterThanOrEqual(2);
    const payload = JSON.stringify(decoded(header).payload);
    const texts = [
      ...outcomes.map((o) => {
        const pr = o.headers["PAYMENT-REQUIRED"];
        return JSON.stringify(o) + (pr === undefined ? "" : Buffer.from(pr, "base64").toString("utf8"));
      }),
      ...reports.map(({ err }) => `${err.message} ${inspect(err)} ${JSON.stringify(err)}`),
    ];
    for (const text of texts) {
      for (const secret of [
        signature,
        leakyPayment,
        leakyProof,
        proof,
        header,
        payload,
        apiKey,
        "free text",
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
