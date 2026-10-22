/** No secret ever leaks (Global Constraints; Review Focus 5).
 *
 * Every failure the rest of the suite exercises (legs 1–3 refusals and the §3 rows, malformed and
 * oversized headers, timeouts, a lost E8 answer, usage extract/send failures, boot refusals and
 * unreachable boots) runs through the core (`handleRequest`) and through every adapter over real
 * HTTP, with headers the official x402 clients built over a real 402, so they carry real
 * signatures. Fake-Lago bodies carry planted markers in every place the middleware must not
 * surface. Everything an agent, an operator or a log could see is captured: each response's
 * status, headers (raw and decoded) and body, each `onError` argument (`message`, `stack`,
 * `JSON.stringify`, `util.inspect`, every own property), each boot rejection, each usage event
 * body and every `console.*` call. None may contain the API key, either header's value, the
 * payment's signature or EIP-3009 nonce, the sign-in's signature, a handler's exception text or
 * a marker; for the key and the cryptographic values not even a 10-character fragment (V8's
 * `JSON.parse` error quotes 10 characters of its input), and for the headers no 24-character
 * fragment that is not public 402 content. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { format, inspect } from "node:util";
import { createSIWxClientExtension } from "@x402/extensions/sign-in-with-x";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentRequired } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it, vi, type ExpectStatic, type MockInstance } from "vitest";
import type { LagoX402Config, LagoX402ErrorWhere } from "../../src/config.js";
import type { GateOutcome, GateRequest } from "../../src/gate.js";
import { createLagoX402, handleRequest, type LagoX402 } from "../../src/x402.js";
import { evmAgent, solanaSigner } from "../support/agent.js";
import {
  startFakeLago,
  type FakeAnswer,
  type FakeHandler,
  type FakeLago,
  type FakeRoute,
  type RecordedRequest,
} from "../support/fake-lago.js";
import {
  BASE_SEPOLIA,
  SOLANA_DEVNET,
  billableMetric,
  evmRequirement,
  gateCheckChallenge,
  gateCheckPass,
  hex32,
  notFound,
  settlement,
  thirdPartyError,
  validationErrors,
} from "../support/fixtures.js";
import {
  FRAMEWORKS,
  PATH,
  ROUTE,
  USAGE_GETTER_MESSAGE,
  startApp,
  type App,
  type Framework,
  type Handler,
} from "../support/frameworks.js";

// Next's `after()` as on a Node server, scoped to each request the bridge serves.
vi.mock("next/server.js", async () => (await import("../support/frameworks.js")).nextServer);

type Driver = "core" | Framework;
const DRIVERS: readonly Driver[] = ["core", ...FRAMEWORKS];

const ORIGIN = "https://api.merchant.example";
const apiKeySecret = randomUUID().replaceAll("-", "");
const apiKey = `lago-x402-security-${apiKeySecret}`;
/** Background boot retries every 10 ms, 20 ms, … */
const FAST = { bootRetryBaseMs: 10 };

/** Planted in fake-Lago bodies: free text (spaces, dashes), so no sanitizer may keep it. */
const MARK = "leak-marker";
const marker = (): string => `${MARK} ${randomUUID()}`;

/** V8's `JSON.parse` SyntaxError quotes up to 10 characters of its input. */
const MATERIAL_FRAGMENT = 10;
const HEADER_FRAGMENT = 24;
/** Under Node's 16 KiB header limit, so it reaches the gate; the core takes 1 MiB. */
const HTTP_OVERSIZED = 12 * 1024;
const CORE_OVERSIZED = 1024 * 1024;
const oversized = (driver: Driver): number => (driver === "core" ? CORE_OVERSIZED : HTTP_OVERSIZED);

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const unb64 = (text: string): string => Buffer.from(text, "base64").toString("utf8");
/** A hex signature from its first letter in a–e on (`f` starts `false`): `JSON.parse` of it
 * fails on that letter and quotes 10 characters ("Unexpected token 'c', "c3f2…"... is not
 * valid JSON"). */
const quotable = (signature: string): string => {
  const hex = signature.replace(/^0x/, "");
  return hex.slice(Math.max(0, hex.search(/[a-e]/i)));
};

// ---------------------------------------------------------------------------------------------
// What must never surface

function windows(text: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= text.length; i++) out.push(text.slice(i, i + n));
  return out;
}

/** One run's secrets: whole values, fragments of cryptographic material (case-insensitive) and
 * fragments of the headers that are not public 402 content (the 402 the agent paid from, at the
 * three base64 alignments, and the agent's public addresses). */
class Secrets {
  readonly #exact = new Map<string, string>();
  readonly #material = new Map<string, string>();
  readonly #header = new Map<string, string>();
  readonly #public = new Set<string>();

  constructor(publicTexts: string[] = []) {
    for (const text of publicTexts) {
      for (const variant of [text, b64(text), b64("_" + text), b64("__" + text)]) {
        for (const w of windows(variant, HEADER_FRAGMENT)) this.#public.add(w);
      }
    }
  }

  exact(label: string, value: string): this {
    if (value.length > 0) this.#exact.set(value, label);
    return this;
  }

  /** A key, signature or nonce: no fragment of it, with or without its `0x`. */
  material(label: string, value: string): this {
    this.exact(label, value);
    const lower = value.toLowerCase();
    for (const text of [lower, lower.replace(/^0x/, "")]) {
      for (const w of windows(text, MATERIAL_FRAGMENT)) this.#material.set(w, `a fragment of ${label}`);
    }
    return this;
  }

  /** A raw header value: never whole, and no fragment that is not public content. */
  header(label: string, value: string): this {
    this.exact(label, value);
    const parts = value.length > 16_384 ? [value.slice(0, 8192), value.slice(-8192)] : [value];
    for (const part of parts) {
      for (const w of windows(part, HEADER_FRAGMENT)) {
        if (!this.#public.has(w)) this.#header.set(w, `a fragment of ${label}`);
      }
    }
    return this;
  }

  /** Whole values and fragments of cryptographic material (header fragments stay per run). */
  merge(other: Secrets): this {
    for (const [k, v] of other.#exact) this.#exact.set(k, v);
    for (const [k, v] of other.#material) this.#material.set(k, v);
    return this;
  }

  /** What `text` gives away, if anything. */
  leakIn(text: string): string | null {
    for (const [value, label] of this.#exact) if (text.includes(value)) return label;
    const lower = text.toLowerCase();
    for (let i = 0; i + MATERIAL_FRAGMENT <= lower.length; i++) {
      const label = this.#material.get(lower.slice(i, i + MATERIAL_FRAGMENT));
      if (label !== undefined) return label;
    }
    for (let i = 0; i + HEADER_FRAGMENT <= text.length; i++) {
      const label = this.#header.get(text.slice(i, i + HEADER_FRAGMENT));
      if (label !== undefined) return label;
    }
    return null;
  }
}

/** Every secret of every run, for the console check at the end. */
const everySecret = new Secrets()
  .exact("a marker", MARK)
  .exact("the API key", apiKey)
  .material("the API key", apiKeySecret);

function baseSecrets(publicTexts: string[] = []): Secrets {
  return new Secrets(publicTexts)
    .exact("a marker", MARK)
    .exact("the handler's exception text", USAGE_GETTER_MESSAGE)
    .exact("the API key", apiKey)
    .material("the API key", apiKeySecret);
}

interface Text {
  label: string;
  text: string;
}

function leaks(texts: Text[], secrets: Secrets): string[] {
  return texts.flatMap(({ label, text }) => {
    const leak = secrets.leakIn(text);
    return leak === null ? [] : [`${label} gives away ${leak}`];
  });
}

// ---------------------------------------------------------------------------------------------
// Capture: console (whole file), onError, responses

const CONSOLE_METHODS = ["debug", "dir", "error", "info", "log", "table", "trace", "warn"] as const;
interface ConsoleLine {
  method: string;
  formatted: string;
  inspected: string;
}
const consoleLines: ConsoleLine[] = [];
const consoleSpies: MockInstance<(...args: unknown[]) => void>[] = [];

// For the whole file: every run's lines are checked against its own secrets, and every line
// against every run's at the end (concurrent runs share the console).
beforeAll(() => {
  for (const method of CONSOLE_METHODS) {
    const spy = vi.spyOn(console, method) as unknown as MockInstance<(...args: unknown[]) => void>;
    spy.mockImplementation((...args: unknown[]) => {
      consoleLines.push({ method, formatted: format(...args), inspected: inspect(args, { depth: 5 }) });
    });
    consoleSpies.push(spy);
  }
});
afterAll(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

function consoleTexts(from: number): Text[] {
  return consoleLines.slice(from).flatMap((line, i) => [
    { label: `console.${line.method}#${from + i}`, text: line.formatted },
    { label: `console.${line.method}#${from + i} (inspect)`, text: line.inspected },
  ]);
}

interface Report {
  err: unknown;
  where: LagoX402ErrorWhere;
}

/** Everything an `onError` (or a `catch`) could print of `err`. */
function errorTexts(label: string, err: unknown): Text[] {
  const out: Text[] = [];
  const add = (suffix: string, read: () => unknown): void => {
    try {
      const value = read();
      out.push({ label: `${label} ${suffix}`, text: typeof value === "string" ? value : inspect(value) });
    } catch {
      // A property that cannot be read cannot be printed either.
    }
  };
  add("String()", () => String(err));
  add("JSON.stringify", () => JSON.stringify(err) ?? "");
  add("util.inspect", () => inspect(err, { depth: 5 }));
  add("util.inspect (hidden)", () => inspect(err, { depth: 5, showHidden: true }));
  if (err instanceof Error) {
    add("message", () => err.message);
    add("stack", () => err.stack ?? "");
  }
  if (typeof err === "object" && err !== null) {
    for (const key of Reflect.ownKeys(err)) {
      add(`.${String(key)}`, () => inspect((err as Record<PropertyKey, unknown>)[key], { depth: 5 }));
    }
  }
  return out;
}

function reportTexts(reports: Report[]): Text[] {
  return reports.flatMap(({ err, where }, i) => [
    { label: `onError#${i} where`, text: where },
    ...errorTexts(`onError#${i}`, err),
  ]);
}

interface Exchange {
  status: number;
  paymentRequired: string | null;
  texts: Text[];
}

function headerTexts(label: string, headers: [string, string][]): Text[] {
  const texts: Text[] = [
    { label: `${label} headers`, text: headers.map(([k, v]) => `${k}: ${v}`).join("\n") },
  ];
  for (const [name, value] of headers) {
    if (/^payment-(required|response)$/i.test(name)) {
      texts.push({ label: `${label} ${name} (decoded)`, text: unb64(value) });
    }
  }
  return texts;
}

/** A request as an adapter hands it to the core: case-insensitive header lookup. */
function gateRequest(headers: Record<string, string>): GateRequest {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method: "POST", target: PATH, header: (name) => map.get(name.toLowerCase()) };
}

/** The usage the handler reports, as the adapters read it. */
function readUsage(h: Handler): unknown {
  if (h.throws) throw new Error(USAGE_GETTER_MESSAGE);
  return h.usage;
}

/** The core as an adapter drives it: a served call is answered `h.status` and billed. */
async function coreExchange(x402: LagoX402, headers: Record<string, string>, h: Handler): Promise<Exchange> {
  const outcome: GateOutcome = await handleRequest(x402, ROUTE, gateRequest(headers));
  if (outcome.action === "respond") {
    return {
      status: outcome.status,
      paymentRequired: outcome.headers["PAYMENT-REQUIRED"] ?? null,
      texts: [
        { label: "outcome", text: JSON.stringify(outcome) },
        ...headerTexts("outcome", Object.entries(outcome.headers)),
        { label: "outcome body", text: outcome.body },
      ],
    };
  }
  const status = h.status ?? 200;
  await outcome.billing.finish(status, () => readUsage(h));
  return { status, paymentRequired: null, texts: headerTexts("outcome", Object.entries(outcome.headers)) };
}

/** A real HTTP exchange; `mayReset` tolerates Node refusing the request before any app ran. */
async function httpExchange(
  url: string,
  headers: Record<string, string>,
  mayReset = false,
): Promise<Exchange> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers });
  } catch (err) {
    if (mayReset) return { status: 0, paymentRequired: null, texts: [] };
    throw err;
  }
  const body = await res.text();
  const received: [string, string][] = [];
  res.headers.forEach((value, name) => received.push([name, value]));
  return {
    status: res.status,
    paymentRequired: res.headers.get("payment-required"),
    texts: [
      { label: "response status", text: `${res.status} ${res.statusText}` },
      ...headerTexts("response", received),
      { label: "response body", text: body },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Real headers, from the official clients

interface Kit {
  /** PAYMENT-SIGNATURE: `@x402/fetch`'s client paying the 402's first entry (EIP-3009). */
  payment: string;
  /** The decoded payment, key order kept. */
  paymentJson: string;
  signature: string;
  /** SIGN-IN-WITH-X: the official sign-in extension with the same EVM account. */
  signIn: string;
  signInJson: string;
  /** SIGN-IN-WITH-X: the official sign-in extension with an ed25519 (Solana) signer. */
  solanaSignIn: string;
  secrets: Secrets;
}

async function proofHeader(
  http: x402HTTPClient,
  paymentRequired: PaymentRequired,
  url: string,
): Promise<string> {
  const headers = await http.handlePaymentRequired(paymentRequired, url);
  const proof = new Headers(headers ?? {}).get("SIGN-IN-WITH-X");
  if (proof === null) throw new Error("the agent did not sign in");
  return proof;
}

/** Real headers over a real 402 (`paymentRequired`, served for `url`). */
async function buildKit(paymentRequired: string, url: string): Promise<Kit> {
  const agent = evmAgent({ maxAmountPerPayment: "$10" });
  const pr = agent.http.getPaymentRequiredResponse((name) =>
    new Headers({ "PAYMENT-REQUIRED": paymentRequired }).get(name),
  );
  const paid = await agent.client.createPaymentPayload(pr);
  const payment = agent.http.encodePaymentSignatureHeader(paid)["PAYMENT-SIGNATURE"];
  const { signature, authorization } = paid.payload as unknown as {
    signature: string;
    authorization: { nonce: string };
  };
  const signIn = await proofHeader(agent.http, pr, url);
  const solana = solanaSigner();
  const solanaHttp = new x402HTTPClient(
    new x402Client().registerExtension(createSIWxClientExtension({ signers: [solana] })),
  );
  const solanaSignIn = await proofHeader(solanaHttp, pr, url);
  const signInJson = unb64(signIn);
  const solanaSignInJson = unb64(solanaSignIn);

  // Public: the 402 the agent paid from, and its addresses as JSON values (`PAYMENT-RESPONSE`
  // names the payer).
  const addresses = [agent.account.address, solana.publicKey].map((address) => `":"${address}"`);
  const secrets = baseSecrets([unb64(paymentRequired), ...addresses])
    .header("the PAYMENT-SIGNATURE value", payment)
    .header("the SIGN-IN-WITH-X value", signIn)
    .header("the Solana SIGN-IN-WITH-X value", solanaSignIn)
    .material("the payment's signature", signature)
    .material("the payment's authorization nonce", authorization.nonce)
    .material("the sign-in's signature", (JSON.parse(signInJson) as { signature: string }).signature)
    .material(
      "the Solana sign-in's signature",
      (JSON.parse(solanaSignInJson) as { signature: string }).signature,
    );
  return {
    payment,
    paymentJson: unb64(payment),
    signature,
    signIn,
    signInJson,
    solanaSignIn,
    secrets,
  };
}

/** `json` with a `padding` string added at `path` (an object inside it), so the result is
 * about `length` characters long once base64-encoded. */
function padded(json: string, length: number, path: "payload" | null): string {
  const value = JSON.parse(json) as Record<string, unknown>;
  const target = path === null ? value : (value[path] as Record<string, unknown>);
  target.padding = "";
  const room = Math.max(0, Math.floor((length * 3) / 4) - JSON.stringify(value).length);
  target.padding = "A".repeat(room);
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------------------------
// Lago answers carrying markers where the middleware must not look

type Step = FakeAnswer | FakeHandler;
/** One answer for every call, or a sequence whose last step repeats. */
type Answer = Step | Step[];

function install(lago: FakeLago, answers: Partial<Record<FakeRoute, Answer>>): void {
  for (const [route, answer] of Object.entries(answers) as [FakeRoute, Answer][]) {
    const steps = Array.isArray(answer) ? answer : [answer];
    let i = 0;
    lago.on(route, (req) => {
      const step = steps[Math.min(i++, steps.length - 1)];
      return typeof step === "function" ? step(req) : step;
    });
  }
}

/** An error envelope with free text in every field the sanitizer must drop. */
function leaky(status: number, body: Record<string, unknown> = { status }): FakeAnswer {
  return {
    status,
    body: { ...body, error: marker(), message: marker(), backtrace: [marker(), marker()] },
  };
}

/** A 422 carrying `codes`, each field with a free-text code next to its own, and (unless
 * `foreignField` is false, which keeps a payment refusal purely a payment refusal) a field whose
 * name is free text. */
function leakyValidation(codes: Record<string, string[]>, foreignField = true): FakeAnswer {
  const details: Record<string, string[]> = foreignField ? { [marker()]: ["value_is_invalid"] } : {};
  for (const field of Object.keys(codes)) details[field] = [...codes[field], marker()];
  return leaky(422, validationErrors(details));
}

function leakyThirdParty(): FakeAnswer {
  const body = thirdPartyError();
  return leaky(422, {
    ...body,
    error_details: { third_party: marker(), thirdparty_error: marker(), [marker()]: [marker()] },
  });
}

/** E7's challenge, rendered fields untouched (so a paid entry still matches it), markers in the
 * fields a 402 never shows: Lago's asset code, unknown keys, the balance, a sign-in chain of an
 * unknown namespace. */
function leakyChallenge(requirement: Record<string, unknown> = { ...evmRequirement() }): FakeAnswer {
  return {
    status: 200,
    body: {
      gate_check: {
        ...gateCheckChallenge().gate_check,
        balance_credits: marker(),
        requirements: [{ ...requirement, asset: marker(), lago_note: marker() }],
        sign_in_chains: [BASE_SEPOLIA, SOLANA_DEVNET, `${MARK}:${randomUUID()}`],
        debug: marker(),
      },
      meta: marker(),
    },
  };
}

function leakyPass(): FakeAnswer {
  return {
    status: 200,
    body: { gate_check: { ...gateCheckPass().gate_check, balance_credits: marker(), debug: marker() } },
  };
}

/** A settled purchase, for the payer the forwarded payment names (as Lago reports it), with
 * markers in every field `PAYMENT-RESPONSE` must not carry. */
function leakySettled(req: RecordedRequest): FakeAnswer {
  const { payment } = (
    req.json as { credit_purchase: { payment: { payload: { authorization: { from: string } } } } }
  ).credit_purchase;
  const { x402_settlement } = settlement({
    transaction_hash: hex32("cd"),
    payer_address: payment.payload.authorization.from,
  });
  return {
    status: 200,
    body: {
      x402_settlement: {
        ...x402_settlement,
        lago_customer_id: marker(),
        lago_wallet_transaction_id: marker(),
        credits_granted: marker(),
        debug: marker(),
      },
    },
  };
}

/** The same purchase answered again from Lago's row (`replayed: true`). */
function leakyReplay(req: RecordedRequest): FakeAnswer {
  const answer = leakySettled(req);
  const { x402_settlement } = answer.body as { x402_settlement: Record<string, unknown> };
  return { ...answer, body: { x402_settlement: { ...x402_settlement, replayed: true } } };
}

function leakyPending(): FakeAnswer {
  const { x402_settlement } = settlement({ status: "pending" });
  return {
    status: 200,
    body: { x402_settlement: { ...x402_settlement, lago_customer_id: marker(), debug: marker() } },
  };
}

const leakyEventAccepted = (): FakeAnswer => ({ status: 200, body: { event: { debug: marker() } } });

// ---------------------------------------------------------------------------------------------
// Request scenarios

interface Scenario {
  name: string;
  /** The request's headers, built from real ones. */
  send: (kit: Kit, driver: Driver) => Record<string, string>;
  /** Lago's answers once the real headers are built. */
  lago?: Partial<Record<FakeRoute, Answer>>;
  handler?: Handler;
  timeouts?: LagoX402Config["timeouts"];
  /** The answer the agent gets (0: Node reset the connection). */
  status: number | number[];
  /** Exactly what `onError` hears. */
  reports: LagoX402ErrorWhere[];
  /** The sign-in proof must never reach Lago. */
  signInNeverForwarded?: boolean;
  drivers?: (driver: Driver) => boolean;
  /** Seconds of event retries: run by the core and one adapter only, in a group of their own. */
  slow?: boolean;
  mayReset?: boolean;
}

const none = (): Record<string, string> => ({});
const signedIn = (kit: Kit): Record<string, string> => ({ "SIGN-IN-WITH-X": kit.signIn });
const paid = (kit: Kit): Record<string, string> => ({ "PAYMENT-SIGNATURE": kit.payment });
const SERVED: Handler = { usage: 1 };
/** E7 answering after E7_TIMEOUT has fired. The timeout leaves room for the healthy 402 the real
 * headers are built from, under this file's concurrency on a slow runner. */
const E7_SLOW: Partial<Record<FakeRoute, Answer>> = {
  gate_checks: { status: 200, body: gateCheckChallenge(), delayMs: 3000 },
};
const E7_TIMEOUT = { gateCheckMs: 1000 };
const SLOW_DRIVERS: readonly Driver[] = ["core", "express"];

const SCENARIOS: Scenario[] = [
  // Leg 1: no header.
  {
    name: "leg 1: E7 challenge with markers off the rendered fields",
    send: none,
    lago: { gate_checks: leakyChallenge() },
    status: 402,
    reports: [],
  },
  {
    name: "leg 1: E7 pass",
    send: none,
    lago: { gate_checks: leakyPass() },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 404 connection_not_found",
    send: none,
    lago: { gate_checks: leaky(404, notFound("connection")) },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 403 with a free-text code",
    send: none,
    lago: { gate_checks: leaky(403, { status: 403, code: marker() }) },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 401",
    send: none,
    lago: { gate_checks: leaky(401) },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 422 route refusal with free-text codes",
    send: none,
    lago: { gate_checks: leakyValidation({ base: ["plan_not_usage_only"] }) },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 third_party_error",
    send: none,
    lago: { gate_checks: leakyThirdParty() },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 500",
    send: none,
    lago: { gate_checks: leaky(500) },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 502 with a bare string body",
    send: none,
    lago: { gate_checks: { status: 502, body: marker() } },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 unreadable 200",
    send: none,
    lago: {
      gate_checks: {
        status: 200,
        body: { gate_check: { requirements: marker(), sign_in_chains: [marker()] }, debug: marker() },
      },
    },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 timeout",
    send: none,
    lago: E7_SLOW,
    timeouts: E7_TIMEOUT,
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 1: E7 socket destroyed",
    send: none,
    lago: { gate_checks: { status: 200, destroySocket: true } },
    status: 503,
    reports: ["gate.check"],
  },

  // Leg 2: SIGN-IN-WITH-X.
  {
    name: "leg 2: siwx refused (invalid_signature)",
    send: signedIn,
    lago: { gate_checks: leakyValidation({ siwx: ["invalid_signature"] }) },
    status: 401,
    reports: [],
  },
  {
    name: "leg 2: siwx refused with a free-text code only",
    send: signedIn,
    lago: { gate_checks: leaky(422, validationErrors({ siwx: [marker()] })) },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 2: Solana sign-in refused (nonce_already_used)",
    send: (kit) => ({ "SIGN-IN-WITH-X": kit.solanaSignIn }),
    lago: { gate_checks: leakyValidation({ siwx: ["nonce_already_used"] }) },
    status: 401,
    reports: [],
  },
  {
    name: "leg 2: buyer_not_recognized",
    send: signedIn,
    lago: { gate_checks: leaky(422, validationErrors({ base: ["buyer_not_recognized"] })) },
    status: 403,
    reports: [],
  },
  {
    name: "leg 2: E7 credit_purchase_pending",
    send: signedIn,
    lago: { gate_checks: leaky(422, validationErrors({ base: ["credit_purchase_pending"] })) },
    status: 503,
    reports: [],
  },
  {
    name: "leg 2: out of credits (E7 challenge)",
    send: signedIn,
    lago: { gate_checks: leakyChallenge() },
    status: 402,
    reports: [],
  },
  {
    name: "leg 2: E7 404 plan_not_found",
    send: signedIn,
    lago: { gate_checks: leaky(404, notFound("plan")) },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 2: E7 timeout",
    send: signedIn,
    lago: E7_SLOW,
    timeouts: E7_TIMEOUT,
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 2: the proof's JSON, not base64",
    send: (kit) => ({ "SIGN-IN-WITH-X": kit.signInJson }),
    status: 401,
    reports: [],
  },
  {
    name: "leg 2: base64 of the proof's JSON, broken before its signature",
    send: (kit) => ({ "SIGN-IN-WITH-X": b64(kit.signInJson.replace('"signature":"', '"signature":')) }),
    status: 401,
    reports: [],
  },
  {
    name: "leg 2: base64 of the proof's signature alone (V8 quotes it)",
    send: (kit) => ({
      "SIGN-IN-WITH-X": b64(quotable((JSON.parse(kit.signInJson) as { signature: string }).signature)),
    }),
    status: 401,
    reports: [],
  },
  {
    name: "leg 2: base64 of the proof inside an array",
    send: (kit) => ({ "SIGN-IN-WITH-X": b64(`[${kit.signInJson}]`) }),
    status: 401,
    reports: [],
  },
  {
    name: "leg 2: oversized proof (padded), refused by Lago",
    send: (kit, d) => ({ "SIGN-IN-WITH-X": b64(padded(kit.signInJson, oversized(d), null)) }),
    lago: { gate_checks: leakyValidation({ siwx: ["value_is_invalid"] }) },
    status: 401,
    reports: [],
  },
  {
    name: "leg 2: oversized garbage around the proof",
    send: (kit, d) => ({ "SIGN-IN-WITH-X": "!".repeat(oversized(d) - kit.signIn.length) + kit.signIn }),
    status: 401,
    reports: [],
  },
  {
    name: "leg 2: served, usage missing",
    send: signedIn,
    lago: { gate_checks: leakyPass() },
    handler: {},
    status: 200,
    reports: ["usage.extract"],
  },
  {
    name: "leg 2: served, usage is free text",
    send: signedIn,
    lago: { gate_checks: leakyPass() },
    handler: { usage: marker() },
    status: 200,
    reports: ["usage.extract"],
  },
  {
    name: "leg 2: served, the usage getter throws",
    send: signedIn,
    lago: { gate_checks: leakyPass() },
    handler: { throws: true },
    status: 200,
    reports: ["usage.extract"],
  },
  {
    name: "leg 2: served, event refused with a 400",
    send: signedIn,
    lago: { gate_checks: leakyPass(), events: leaky(400) },
    handler: SERVED,
    status: 200,
    reports: ["usage.send"],
  },
  {
    name: "leg 2: served, event refused with free-text codes",
    send: signedIn,
    lago: { gate_checks: leakyPass(), events: leakyValidation({ transaction_id: ["value_is_invalid"] }) },
    handler: SERVED,
    status: 200,
    reports: ["usage.send"],
  },
  {
    name: "leg 2: served, event delivered",
    send: signedIn,
    lago: { gate_checks: leakyPass(), events: leakyEventAccepted() },
    handler: SERVED,
    status: 200,
    reports: [],
  },
  {
    name: "leg 2: served, event 500s until it gives up",
    send: signedIn,
    lago: { gate_checks: leakyPass(), events: leaky(500) },
    handler: SERVED,
    status: 200,
    reports: ["usage.send"],
    slow: true,
  },
  {
    name: "leg 2: served, event timeouts until it gives up",
    send: signedIn,
    lago: { gate_checks: leakyPass(), events: { ...leakyEventAccepted(), delayMs: 2000 } },
    handler: SERVED,
    timeouts: { eventMs: 100 },
    status: 200,
    reports: ["usage.send"],
    slow: true,
  },

  // Leg 3: PAYMENT-SIGNATURE.
  {
    name: "leg 3: settled with markers off PAYMENT-RESPONSE",
    send: paid,
    lago: { gate_checks: leakyChallenge(), credit_purchases: leakySettled, events: leakyEventAccepted() },
    handler: SERVED,
    status: 200,
    reports: [],
  },
  {
    name: "leg 3: settled, the usage getter throws",
    send: paid,
    lago: { credit_purchases: leakySettled },
    handler: { throws: true },
    status: 200,
    reports: ["usage.extract"],
  },
  {
    name: "leg 3: E7 pass",
    send: paid,
    lago: { gate_checks: leakyPass() },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 3: E7 404 connection_not_found",
    send: paid,
    lago: { gate_checks: leaky(404, notFound("connection")) },
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 3: E7 timeout",
    send: paid,
    lago: E7_SLOW,
    timeouts: E7_TIMEOUT,
    status: 503,
    reports: ["gate.check"],
  },
  {
    name: "leg 3: stale challenge (the top-up changed)",
    send: paid,
    lago: { gate_checks: leakyChallenge({ ...evmRequirement({ amountCents: 600 }) }) },
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: the payment's JSON, not base64",
    send: (kit) => ({ "PAYMENT-SIGNATURE": kit.paymentJson }),
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: base64 of the payment's JSON, broken before its signature",
    send: (kit) => ({ "PAYMENT-SIGNATURE": b64(kit.paymentJson.replace('"signature":"', '"signature":')) }),
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: base64 of the payment's signature alone (V8 quotes it)",
    send: (kit) => ({ "PAYMENT-SIGNATURE": b64(quotable(kit.signature)) }),
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: the payment as x402 v1",
    send: (kit) => ({
      "PAYMENT-SIGNATURE": b64(kit.paymentJson.replace('"x402Version":2', '"x402Version":1')),
    }),
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: the payment truncated",
    send: (kit) => ({ "PAYMENT-SIGNATURE": kit.payment.slice(0, Math.floor(kit.payment.length / 2)) }),
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: oversized payment (padded payload), refused by Lago",
    send: (kit, d) => ({ "PAYMENT-SIGNATURE": b64(padded(kit.paymentJson, oversized(d), "payload")) }),
    lago: { credit_purchases: leakyValidation({ payment: ["invalid_exact_evm_payload_signature"] }, false) },
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: oversized garbage around the payment",
    send: (kit, d) => ({ "PAYMENT-SIGNATURE": "!".repeat(oversized(d) - kit.payment.length) + kit.payment }),
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: E8 payment refusal",
    send: paid,
    lago: { credit_purchases: leakyValidation({ payment: ["invalid_exact_evm_payload_signature"] }, false) },
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: E8 payment refusal with free-text codes only",
    send: paid,
    lago: { credit_purchases: leaky(422, validationErrors({ payment: [marker()] })) },
    status: 402,
    reports: [],
  },
  {
    name: "leg 3: E8 amount_above_maximum",
    send: paid,
    lago: { credit_purchases: leakyValidation({ payment_requirements: ["amount_above_maximum"] }, false) },
    status: 503,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: E8 recorded_as_invoice_payment",
    send: paid,
    lago: { credit_purchases: leakyValidation({ payment: ["recorded_as_invoice_payment"] }, false) },
    status: 409,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: E8 buyer_not_recognized",
    send: paid,
    lago: { credit_purchases: leaky(422, validationErrors({ base: ["buyer_not_recognized"] })) },
    status: 403,
    reports: [],
  },
  {
    name: "leg 3: E8 credit_purchase_pending",
    send: paid,
    lago: { credit_purchases: leaky(422, validationErrors({ base: ["credit_purchase_pending"] })) },
    status: 503,
    reports: [],
  },
  {
    name: "leg 3: E8 pending",
    send: paid,
    lago: { credit_purchases: leakyPending() },
    status: 503,
    reports: [],
  },
  {
    name: "leg 3: E8 credit_grant_failed twice",
    send: paid,
    lago: { credit_purchases: leaky(422, validationErrors({ base: ["credit_grant_failed"] })) },
    status: 503,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: E8 lost answer, then settled",
    send: paid,
    lago: { credit_purchases: [{ status: 200, destroySocket: true }, leakySettled] },
    handler: SERVED,
    status: 200,
    reports: [],
  },
  {
    name: "leg 3: E8 settled replay on the first attempt",
    send: paid,
    lago: { credit_purchases: leakyReplay },
    status: 409,
    reports: [],
  },
  {
    name: "leg 3: E8 lost answer, then a settled replay",
    send: paid,
    lago: { credit_purchases: [{ status: 200, destroySocket: true }, leakyReplay] },
    handler: SERVED,
    status: 200,
    reports: [],
  },
  {
    name: "leg 3: E8 lost answer twice",
    send: paid,
    lago: { credit_purchases: { status: 200, destroySocket: true } },
    status: 503,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: E8 500 twice",
    send: paid,
    lago: { credit_purchases: leaky(500) },
    status: 503,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: E8 timeout",
    send: paid,
    lago: { credit_purchases: (req) => ({ ...leakySettled(req), delayMs: 3000 }) },
    timeouts: { creditPurchaseMs: 500 },
    status: 503,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: E8 unreadable 200",
    send: paid,
    lago: {
      credit_purchases: { status: 200, body: { x402_settlement: { status: "settled", debug: marker() } } },
    },
    status: 503,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: E8 third_party_error",
    send: paid,
    lago: { credit_purchases: leakyThirdParty() },
    status: 503,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: E8 401",
    send: paid,
    lago: { credit_purchases: leaky(401) },
    status: 503,
    reports: ["gate.purchase"],
  },
  {
    name: "leg 3: both headers (the payment wins), E8 refusal",
    send: (kit) => ({ ...paid(kit), ...signedIn(kit) }),
    lago: { credit_purchases: leakyValidation({ payment: ["invalid_exact_evm_payload_signature"] }, false) },
    status: 402,
    reports: [],
    signInNeverForwarded: true,
  },

  // Node itself: a header past its limit never reaches an app.
  {
    name: "a header past Node's 16 KiB limit",
    send: (kit) => ({ "PAYMENT-SIGNATURE": kit.payment.padEnd(20 * 1024, "A") }),
    status: [431, 0],
    reports: [],
    drivers: (d) => d !== "core",
    mayReset: true,
  },
];

// ---------------------------------------------------------------------------------------------
// Boot scenarios

interface BootScenario {
  name: string;
  lago?: Partial<Record<FakeRoute, Answer>>;
  /** Config changes (an invalid config, an unreachable apiUrl). */
  config?: (base: LagoX402Config) => Promise<LagoX402Config> | LagoX402Config;
  timeouts?: LagoX402Config["timeouts"];
  outcome: "refused" | "unreachable" | "invalid";
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/api/v1`;
}

const metric = (o: Record<string, unknown>): FakeAnswer => ({
  status: 200,
  body: {
    billable_metric: { ...billableMetric().billable_metric, name: marker(), description: marker(), ...o },
    meta: marker(),
  },
});

const BOOT_SCENARIOS: BootScenario[] = [
  {
    name: "refused: metric count_agg",
    lago: { billable_metrics: metric({ aggregation_type: "count_agg" }) },
    outcome: "refused",
  },
  {
    name: "refused: metric aggregation is free text",
    lago: { billable_metrics: metric({ aggregation_type: marker() }) },
    outcome: "refused",
  },
  {
    name: "refused: metric with an expression",
    lago: { billable_metrics: metric({ expression: marker(), field_name: marker() }) },
    outcome: "refused",
  },
  {
    name: "refused: metric 404",
    lago: { billable_metrics: leaky(404, notFound("billable_metric")) },
    outcome: "refused",
  },
  { name: "refused: metric 401", lago: { billable_metrics: leaky(401) }, outcome: "refused" },
  {
    name: "refused: metric answer of the wrong shape",
    lago: { billable_metrics: { status: 200, body: { billable_metric: marker() } } },
    outcome: "refused",
  },
  {
    name: "refused: E7 404 plan_not_found",
    lago: { gate_checks: leaky(404, notFound("plan")) },
    outcome: "refused",
  },
  {
    name: "refused: E7 422 with free-text codes",
    lago: { gate_checks: leakyValidation({ base: ["charge_not_targeted"] }) },
    outcome: "refused",
  },
  {
    name: "refused: E7 403 with a free-text code",
    lago: { gate_checks: leaky(403, { status: 403, code: marker() }) },
    outcome: "refused",
  },
  {
    name: "refused: E7 challenge without sign_in_chains",
    lago: {
      gate_checks: {
        status: 200,
        body: {
          gate_check: { ...gateCheckChallenge().gate_check, sign_in_chains: undefined, debug: marker() },
        },
      },
    },
    outcome: "refused",
  },
  {
    name: "refused: E7 sign-in chains no agent can sign with",
    lago: {
      gate_checks: { status: 200, body: gateCheckChallenge({ sign_in_chains: [`${MARK}:${randomUUID()}`] }) },
    },
    outcome: "refused",
  },
  { name: "refused: E7 pass without a sign-in", lago: { gate_checks: leakyPass() }, outcome: "refused" },
  {
    name: "refused: E7 unreadable 200",
    lago: { gate_checks: { status: 200, body: { gate_check: marker() } } },
    outcome: "refused",
  },
  { name: "unreachable: metric 503", lago: { billable_metrics: leaky(503) }, outcome: "unreachable" },
  {
    name: "unreachable: metric timeout",
    lago: { billable_metrics: { ...metric({}), delayMs: 3000 } },
    timeouts: { gateCheckMs: 300 },
    outcome: "unreachable",
  },
  { name: "unreachable: E7 500", lago: { gate_checks: leaky(500) }, outcome: "unreachable" },
  { name: "unreachable: E7 429", lago: { gate_checks: leaky(429) }, outcome: "unreachable" },
  {
    name: "unreachable: E7 third_party_error",
    lago: { gate_checks: leakyThirdParty() },
    outcome: "unreachable",
  },
  {
    name: "unreachable: Lago's port closed",
    config: async (c) => ({ ...c, apiUrl: await closedPortUrl() }),
    outcome: "unreachable",
  },
  {
    name: "invalid: an apiUrl carrying the key as credentials",
    config: (c) => ({ ...c, apiUrl: `https://user:${apiKey}@lago.example/api/v1` }),
    outcome: "invalid",
  },
  {
    name: "invalid: an apiUrl carrying the key in its query",
    config: (c) => ({ ...c, apiUrl: `https://lago.example/api/v1?api_key=${apiKey}` }),
    outcome: "invalid",
  },
  {
    name: "invalid: an apiKey with a line break",
    config: (c) => ({ ...c, apiKey: `${apiKey}\n${marker()}` }),
    outcome: "invalid",
  },
  {
    name: "invalid: an origin naming the key",
    config: (c) => ({ ...c, origin: `http://${apiKeySecret}.example` }),
    outcome: "invalid",
  },
];

// ---------------------------------------------------------------------------------------------
// Runs

function routeConfig(
  apiUrl: string,
  origin: string,
  reports: Report[],
  timeouts?: LagoX402Config["timeouts"],
): LagoX402Config {
  return {
    apiUrl,
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
        wallet: { name: "Agent credits", rateAmount: "1" },
      },
    },
    ...(timeouts === undefined ? {} : { timeouts }),
    onError: (err, where) => void reports.push({ err, where }),
  };
}

interface Target {
  /** The URL the agent signs in and pays for. */
  url: string;
  exchange(headers: Record<string, string>, mayReset?: boolean): Promise<Exchange>;
  /** Every response finished (billing ran), then the instance drained. */
  close(): Promise<void>;
}

async function target(
  driver: Driver,
  lago: FakeLago,
  reports: Report[],
  h: Handler,
  timeouts?: LagoX402Config["timeouts"],
): Promise<Target> {
  if (driver === "core") {
    const x402 = await createLagoX402(routeConfig(lago.apiUrl, ORIGIN, reports, timeouts), FAST);
    return {
      url: ORIGIN + PATH,
      exchange: (headers) => coreExchange(x402, headers, h),
      close: () => x402.close({ timeoutMs: 10_000 }),
    };
  }
  let x402: LagoX402 | undefined;
  const app: App = await startApp(
    driver,
    async (origin) =>
      (x402 = await createLagoX402(routeConfig(lago.apiUrl, origin, reports, timeouts), FAST)),
    h,
  );
  const url = app.url + PATH;
  return {
    url,
    exchange: (headers, mayReset) => httpExchange(url, headers, mayReset),
    close: async () => {
      await app.close();
      await x402?.close({ timeoutMs: 10_000 });
    },
  };
}

interface RunResult {
  status: number;
  reports: LagoX402ErrorWhere[];
  leaks: string[];
  /** A Lago request carried the key outside its Authorization header, or the sign-in when it
   * must not have. */
  lagoLeaks: string[];
  missingLogLines: string[];
}

function logged(reports: Report[]): string[] {
  const lines = new Set(consoleLines.filter((l) => l.method === "warn").map((l) => l.formatted));
  return reports
    .map(({ err, where }) => `[lago-x402] ${where} failed: ${(err as Error).message}`)
    .filter((line) => !lines.has(line));
}

function lagoTexts(lago: FakeLago): Text[] {
  return lago.requests
    .filter((r) => r.route === "events")
    .map((r, i) => ({ label: `event body #${i}`, text: r.rawBody }));
}

function lagoLeaks(lago: FakeLago, kit: Kit, s: { signInNeverForwarded?: boolean }): string[] {
  const out: string[] = [];
  const signature = (JSON.parse(kit.signInJson) as { signature: string }).signature;
  for (const r of lago.requests) {
    if (r.headers.authorization !== `Bearer ${apiKey}`)
      out.push(`${r.method} ${r.path} without the Bearer key`);
    if (r.rawBody.includes(apiKey) || r.path.includes(apiKeySecret))
      out.push(`${r.method} ${r.path} carries the key`);
    if (s.signInNeverForwarded && r.rawBody.includes(signature))
      out.push(`${r.method} ${r.path} carries the sign-in`);
  }
  return out;
}

async function runScenario(driver: Driver, s: Scenario): Promise<RunResult> {
  const lago = await startFakeLago();
  const reports: Report[] = [];
  let close: (() => Promise<void>) | undefined;
  try {
    const t = await target(driver, lago, reports, s.handler ?? SERVED, s.timeouts);
    close = t.close;
    const challenge = await t.exchange({});
    if (challenge.status !== 402 || challenge.paymentRequired === null) throw new Error("no healthy 402");
    const kit = await buildKit(challenge.paymentRequired, t.url);
    const headers = s.send(kit, driver);
    // What this request sends is secret too, however mangled.
    for (const [name, value] of Object.entries(headers)) kit.secrets.header(`the ${name} sent`, value);
    everySecret.merge(kit.secrets);
    lago.requests.length = 0;
    install(lago, s.lago ?? {});
    const from = consoleLines.length;

    const answer = await t.exchange(headers, s.mayReset);
    await t.close();
    close = undefined;

    const texts = [...answer.texts, ...reportTexts(reports), ...lagoTexts(lago), ...consoleTexts(from)];
    return {
      status: answer.status,
      reports: reports.map((r) => r.where),
      leaks: leaks(texts, kit.secrets),
      lagoLeaks: lagoLeaks(lago, kit, s),
      missingLogLines: logged(reports),
    };
  } finally {
    await close?.();
    await lago.close();
  }
}

interface BootResult {
  statuses: number[];
  reports: LagoX402ErrorWhere[];
  rejected: boolean;
  leaks: string[];
  missingLogLines: string[];
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runBoot(driver: Driver, s: BootScenario): Promise<BootResult> {
  const lago = await startFakeLago();
  const reports: Report[] = [];
  let app: App | undefined;
  let instance: LagoX402 | undefined;
  try {
    // Real headers over a real 402 from a healthy instance, before Lago turns hostile.
    const healthy = await createLagoX402(routeConfig(lago.apiUrl, ORIGIN, []), FAST);
    const challenge = await coreExchange(healthy, {}, SERVED);
    await healthy.close();
    const kit = await buildKit(challenge.paymentRequired!, ORIGIN + PATH);
    everySecret.merge(kit.secrets);
    install(lago, s.lago ?? {});
    const from = consoleLines.length;

    const base = routeConfig(lago.apiUrl, ORIGIN, reports, s.timeouts);
    const booting = createLagoX402(s.config ? await s.config(base) : base, FAST);
    // Handled at once: a rejection must not wait for a request to be observed.
    const settled = booting.then(
      (x402) => ({ x402, err: null }),
      (err: unknown) => ({ x402: null, err }),
    );
    const requests = [none(), signedIn(kit), paid(kit)];
    const exchanges: Exchange[] = [];
    if (driver === "core") {
      const { x402 } = await settled;
      if (x402 !== null)
        for (const headers of requests) exchanges.push(await coreExchange(x402, headers, SERVED));
    } else {
      app = await startApp(driver, booting, SERVED);
      for (const headers of requests) exchanges.push(await httpExchange(app.url + PATH, headers));
    }
    const { x402, err } = await settled;
    if (x402 !== null) {
      instance = x402;
      // A background retry is reported too.
      await waitFor(() => reports.length >= 2);
      await x402.close({ timeoutMs: 1000 });
      instance = undefined;
    }
    await app?.close();
    app = undefined;

    const texts = [
      ...exchanges.flatMap((e) => e.texts),
      ...reportTexts(reports),
      ...(err === null ? [] : errorTexts("rejection", err)),
      ...consoleTexts(from),
    ];
    return {
      statuses: exchanges.map((e) => e.status),
      reports: reports.map((r) => r.where),
      rejected: err !== null,
      leaks: leaks(texts, kit.secrets),
      missingLogLines: logged(reports),
    };
  } finally {
    await app?.close();
    await instance?.close({ timeoutMs: 1000 });
    await lago.close();
  }
}

// ---------------------------------------------------------------------------------------------

async function expectNoLeak(driver: Driver, s: Scenario, expect: ExpectStatic): Promise<void> {
  const result = await runScenario(driver, s);

  expect(Array.isArray(s.status) ? s.status : [s.status]).toContain(result.status);
  expect(result.reports).toStrictEqual(s.reports);
  expect(result.leaks).toStrictEqual([]);
  expect(result.lagoLeaks).toStrictEqual([]);
  expect(result.missingLogLines).toStrictEqual([]);
}

describe.concurrent.each(DRIVERS)("%s", (driver) => {
  const applies = (s: Scenario): boolean => s.drivers?.(driver) ?? true;

  describe.concurrent("requests", () => {
    it.for(SCENARIOS.filter((s) => applies(s) && !s.slow))("$name", (s, { expect }) =>
      expectNoLeak(driver, s, expect),
    );
  });

  // Seconds of backoff each: a group of their own, so they never hold the others up.
  if (SLOW_DRIVERS.includes(driver)) {
    describe.concurrent("event retries", () => {
      it.for(SCENARIOS.filter((s) => applies(s) && s.slow))("$name", (s, { expect }) =>
        expectNoLeak(driver, s, expect),
      );
    });
  }

  describe.concurrent("boot", () => {
    it.for(BOOT_SCENARIOS)("$name", async (s, { expect }) => {
      const result = await runBoot(driver, s);

      // Nothing is ever served while a route is refused, unreachable or misconfigured.
      const expected = driver === "core" && s.outcome !== "unreachable" ? [] : [503, 503, 503];
      expect(result.statuses).toStrictEqual(expected);
      expect(result.rejected).toBe(s.outcome !== "unreachable");
      // R28: a refusal is reported once before rejecting, an invalid config is left to Node, and an
      // unreachable route is reported on its first check and on every background retry.
      if (s.outcome === "unreachable") {
        expect(result.reports.length).toBeGreaterThanOrEqual(2);
        expect(new Set(result.reports)).toStrictEqual(new Set(["boot"]));
      } else {
        expect(result.reports).toStrictEqual(s.outcome === "invalid" ? [] : ["boot"]);
      }
      expect(result.leaks).toStrictEqual([]);
      expect(result.missingLogLines).toStrictEqual([]);
    });
  });
});

describe("the log", () => {
  it("every console call was a report line, and none carried a secret of any run", () => {
    expect(consoleLines.length).toBeGreaterThan(0);
    const foreign = consoleLines.filter(
      (l) =>
        l.method !== "warn" ||
        !/^\[lago-x402\] (boot|gate\.check|gate\.purchase|usage\.extract|usage\.send) failed: [^\n]+$/.test(
          l.formatted,
        ),
    );
    expect(foreign).toStrictEqual([]);
    expect(leaks(consoleTexts(0), everySecret)).toStrictEqual([]);
  });
});

describe("the checks themselves", () => {
  it("catch a whole value, a fragment of a signature and a fragment of a header, but not public 402 content", async () => {
    const lago = await startFakeLago();
    try {
      const x402 = await createLagoX402(routeConfig(lago.apiUrl, ORIGIN, []), FAST);
      const challenge = await coreExchange(x402, {}, SERVED);
      await x402.close();
      const kit = await buildKit(challenge.paymentRequired!, ORIGIN + PATH);
      let quoted = "";
      try {
        JSON.parse(quotable(kit.signature));
      } catch (err) {
        quoted = (err as Error).message;
      }
      expect(quoted).toMatch(/^Unexpected token '[a-e]', "[0-9a-f]{10}"\.\.\. is not valid JSON$/);

      expect(kit.secrets.leakIn(`key=${apiKey}`)).toBe("the API key");
      expect(kit.secrets.leakIn(`id ${apiKeySecret.slice(5, 15)}`)).toBe("a fragment of the API key");
      expect(kit.secrets.leakIn(quoted)).toBe("a fragment of the payment's signature");
      expect(kit.secrets.leakIn(kit.signature)).toBe("the payment's signature");
      expect(kit.secrets.leakIn(kit.signature.toUpperCase())).toBe("a fragment of the payment's signature");
      const at = Math.ceil(kit.paymentJson.indexOf(kit.signature) / 3) * 4 + 8;
      expect(kit.secrets.leakIn(kit.payment.slice(at, at + 40))).toBe(
        "a fragment of the PAYMENT-SIGNATURE value",
      );
      expect(kit.secrets.leakIn(`${MARK} there`)).toBe("a marker");
      // The 402 the agent paid from is public, encoded or not, and so is the agent's address.
      expect(kit.secrets.leakIn(challenge.paymentRequired!)).toBeNull();
      expect(kit.secrets.leakIn(unb64(challenge.paymentRequired!))).toBeNull();
      expect(kit.secrets.leakIn(kit.payment.slice(0, 24))).toBeNull();
    } finally {
      await lago.close();
    }
  });
});
