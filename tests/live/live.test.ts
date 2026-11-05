/** Live: the three legs against a real Lago, paying a real top-up on Base Sepolia.
 *
 * Skipped unless LAGO_API_URL (Lago's API base, e.g. https://lago.example/api/v1), LAGO_API_KEY
 * and X402_BUYER_EVM_PRIVATE_KEY (a funded Base Sepolia buyer) are set. Optional, with the
 * defaults scripts/live-setup.mjs creates: LAGO_X402_CONNECTION_CODE, LIVE_PLAN_CODE,
 * LIVE_METRIC_CODE, LIVE_WALLET_CODE, LIVE_ORIGIN (http://localhost:4021), LIVE_TOP_UP_CENTS (3),
 * LIVE_WALLET_TIMEOUT_MS (420000), LIVE_EVENT_CLOCK_OFFSET_MS (5000),
 * LIVE_LOSE_FIRST_PURCHASE_ANSWER (unset; `1` has the proxy drop the answer to step 2's first
 * credit purchase after Lago has processed it, so the middleware's own retry is answered from
 * Lago's record and served). Run `node scripts/live-setup.mjs` once first.
 *
 * An Express app on LIVE_ORIGIN's port gates POST /live with `lagoX402`, whose `apiUrl` is a
 * loopback proxy that forwards everything to LAGO_API_URL unchanged and records the usage events
 * it relays (no API change to the package). Its usage events are stamped by a clock
 * LIVE_EVENT_CLOCK_OFFSET_MS behind this host's, a merchant server lagging Lago, and the agent's
 * subscription is terminated first, so step 2's purchase opens a fresh one that starts just
 * before the paid call is served. By default the lag outlasts steps 2 and 3, so both calls are
 * billed only through the subscription start Lago returns. Then:
 *   1. a plain fetch gets a 402 whose every requirement is on Base Sepolia or Solana devnet;
 *   2. an agent without the sign-in extension pays the top-up and is served with PAYMENT-RESPONSE
 *      (should Lago still be settling it, 503 payment_pending: the agent waits, then signs in);
 *   3. the same key with the sign-in extension is served from its credits and never pays;
 *   4. the paid call's PAYMENT-SIGNATURE, sent again, is refused by Lago (it carries another
 *      request's key), answered 409, and neither served nor billed;
 *   5. ten gate checks, counting the distinct Solana fee payers they offer (they rotate);
 *   6. `x402.close()` drains; Lago has both events and bills both, and the wallet's ongoing usage
 *      rose.
 *
 * Money moves once per run: LIVE_TOP_UP_CENTS on Base Sepolia, never more (the agent's spend cap
 * is that amount), never on any other network (only Base Sepolia is registered, and a 402
 * offering anything but Base Sepolia or Solana devnet aborts before signing). Nothing here prints
 * an environment value, a request header or a raw body; the key goes only to LAGO_API_URL,
 * directly or through the proxy. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createSIWxClientExtension } from "@x402/extensions/sign-in-with-x";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import express from "express";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lagoX402 } from "../../src/express.js";
import type { LagoX402, LagoX402ErrorWhere } from "../../src/index.js";
import { createLagoX402 } from "../../src/x402.js";

const env = process.env;
const LIVE = Boolean(env.LAGO_API_URL && env.LAGO_API_KEY && env.X402_BUYER_EVM_PRIVATE_KEY);

const BASE_SEPOLIA = "eip155:84532";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/** The only networks this test lets an agent see offered, let alone pay on. */
const TESTNETS = [BASE_SEPOLIA, SOLANA_DEVNET];
const ROUTE = "live";
const PATH = "/live";

function setting(name: string, fallback: string): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

function positiveInteger(name: string, fallback: string): number {
  const value = Number(setting(name, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Lago's API base, ending in /api/v1 (appended when missing). */
function apiBase(raw: string): URL {
  const url = new URL(raw.replace(/\/+$/, ""));
  if (!url.pathname.endsWith("/api/v1")) url.pathname = url.pathname.replace(/\/+$/, "") + "/api/v1";
  return url;
}

/** The buyer, from X402_BUYER_EVM_PRIVATE_KEY; the key itself never appears in an error. */
function buyer(): PrivateKeyAccount {
  const raw = (env.X402_BUYER_EVM_PRIVATE_KEY ?? "").trim();
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("X402_BUYER_EVM_PRIVATE_KEY is not a 32-byte hex key");
  return privateKeyToAccount(key as `0x${string}`);
}

const log = (line: string): void => console.log(`[live] ${line}`);

// ---------------------------------------------------------------------------------------------
// The recording proxy between the middleware and Lago

interface Relay {
  method: string;
  /** Relative to LAGO_API_URL, without its query string. */
  path: string;
  status: number;
  /** A credit purchase whose answer the proxy dropped after Lago had processed it. */
  lost?: boolean;
  /** A credit purchase answered from Lago's record of the payment. */
  replayed?: boolean;
}

interface RelayedEvent {
  transactionId: string;
  code: string;
  externalSubscriptionId: string;
  properties: Record<string, unknown>;
  status: number;
}

interface RecordingProxy {
  /** What the middleware gets as `apiUrl`: loopback, with LAGO_API_URL's path. */
  apiUrl: string;
  relays: Relay[];
  events: RelayedEvent[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Forwards every request to `upstream` unchanged (method, path, query, Authorization, Accept,
 * Content-Type, body; never following a redirect) and answers with Lago's status, Content-Type and
 * body. Records each relay's method, path and status, whether a credit purchase was a replay, and
 * each usage event it relays. With `loseFirstPurchaseAnswer`, the first credit purchase reaches
 * Lago but its answer is dropped with the socket. Logs nothing. */
async function startRecordingProxy(upstream: URL, loseFirstPurchaseAnswer: boolean): Promise<RecordingProxy> {
  const prefix = upstream.pathname.replace(/\/+$/, "");
  const relays: Relay[] = [];
  const events: RelayedEvent[] = [];
  let losePurchaseAnswer = loseFirstPurchaseAnswer;

  async function relay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? "/";
    const path = target.split("?")[0];
    const method = req.method ?? "GET";
    const body = await readBody(req);
    let status = 502;
    try {
      const headers: Record<string, string> = {};
      for (const name of ["authorization", "accept", "content-type"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const answer = await fetch(upstream.origin + target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(body),
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      status = answer.status;
      const payload = Buffer.from(await answer.arrayBuffer());
      if (method === "POST" && path === `${prefix}/x402/credit_purchases`) {
        const replayed = replayedOf(status, payload);
        if (losePurchaseAnswer) {
          losePurchaseAnswer = false;
          req.socket.destroy();
          relays.push({ method, path: path.slice(prefix.length), status, lost: true, replayed });
          return;
        }
        relays.push({ method, path: path.slice(prefix.length), status, replayed });
        res.writeHead(status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
        res.end(payload);
        return;
      }
      const out: Record<string, string> = {};
      for (const name of ["content-type", "location"]) {
        const value = answer.headers.get(name);
        if (value !== null) out[name] = value;
      }
      res.writeHead(status, out);
      res.end(payload);
    } catch {
      res.writeHead(502);
      res.end();
    }
    relays.push({ method, path: path.startsWith(prefix) ? path.slice(prefix.length) : path, status });
    if (method === "POST" && path === `${prefix}/events`) {
      try {
        const { event } = JSON.parse(body.toString("utf8")) as {
          event: {
            transaction_id: string;
            code: string;
            external_subscription_id: string;
            properties: Record<string, unknown>;
          };
        };
        events.push({
          transactionId: event.transaction_id,
          code: event.code,
          externalSubscriptionId: event.external_subscription_id,
          properties: event.properties,
          status,
        });
      } catch {
        // Not an event the middleware sent; nothing to record.
      }
    }
  }

  /** `replayed` of a 200 credit purchase; undefined for anything else. */
  function replayedOf(status: number, payload: Buffer): boolean | undefined {
    if (status !== 200) return undefined;
    try {
      const body = JSON.parse(payload.toString("utf8")) as { x402_settlement?: { replayed?: unknown } };
      return body.x402_settlement?.replayed === true;
    } catch {
      return undefined;
    }
  }

  const server = createServer((req, res) => void relay(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${port}${prefix}`,
    relays,
    events,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// Lago, read directly (the key goes to LAGO_API_URL only)

interface Wallet {
  code: string;
  balance_cents: number;
  ongoing_balance_cents: number;
  ongoing_usage_balance_cents: number;
}

interface ChargeUsage {
  units: string;
  billable_metric: { code: string };
}

interface LagoEvent {
  transaction_id: string;
  code: string;
  external_subscription_id: string;
  properties: Record<string, unknown>;
}

async function poll<T>(
  what: string,
  timeoutMs: number,
  intervalMs: number,
  attempt: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (Date.now() + intervalMs > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------------------------
// Agents (the official x402 client libraries)

interface RecordingFetch {
  fetch: typeof fetch;
  /** The headers of every request it sent, in order. */
  sent: Headers[];
}

function recordingFetch(): RecordingFetch {
  const sent: Headers[] = [];
  const recorder: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push(new Headers(request.headers));
    return fetch(request);
  };
  return { fetch: recorder, sent };
}

/** Refuses, before anything is signed, a 402 offering a network that is not a testnet. */
function testnetsOnly(paymentRequired: PaymentRequired): string | null {
  const off = paymentRequired.accepts.filter((entry) => !TESTNETS.includes(entry.network));
  return off.length === 0 ? null : `refusing a 402 that offers ${off.map((e) => e.network).join(", ")}`;
}

/** Without the sign-in extension: pays the route's top-up on Base Sepolia, and nothing else. */
function payingClient(account: PrivateKeyAccount, topUpCents: number): x402Client {
  const client = new x402Client();
  client.register(BASE_SEPOLIA, new ExactEvmScheme(account));
  client.registerPolicy((_version, requirements) => requirements.filter((r) => r.network === BASE_SEPOLIA));
  // "Raised just enough": the cap is the top-up itself.
  client.setSpendControls({ maxAmountPerPayment: `$${(topUpCents / 100).toFixed(2)}` });
  client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
    const refusal = testnetsOnly(paymentRequired);
    if (refusal !== null) return { abort: true, reason: refusal };
    if (selectedRequirements.network !== BASE_SEPOLIA) return { abort: true, reason: "not Base Sepolia" };
    if (selectedRequirements.amount !== String(topUpCents * 10_000)) {
      return { abort: true, reason: "the amount is not the route's top-up" };
    }
    return undefined;
  });
  return client;
}

/** With the sign-in extension; any attempt to pay aborts before signing (the wrapped fetch then
 * throws). */
function signingClient(account: PrivateKeyAccount): x402Client {
  const client = new x402Client();
  client.register(BASE_SEPOLIA, new ExactEvmScheme(account));
  client.registerExtension(createSIWxClientExtension({ signers: [account] }));
  client.onBeforePaymentCreation(async () => ({
    abort: true,
    reason: "a signed-in call must be served from credits, never paid",
  }));
  return client;
}

/** True for the middleware's 503 `payment_pending`. */
async function isPending(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    return ((await res.clone().json()) as { error?: string }).error === "payment_pending";
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------

describe.skipIf(!LIVE)("live: lago-x402 against a real Lago on Base Sepolia", () => {
  const connectionCode = setting("LAGO_X402_CONNECTION_CODE", "lago_x402_js_live");
  const planCode = setting("LIVE_PLAN_CODE", "lago_x402_js_live_plan");
  const metricCode = setting("LIVE_METRIC_CODE", "lago_x402_js_live_units");
  const walletCode = setting("LIVE_WALLET_CODE", "lago_x402_js_live_credits");
  const origin = setting("LIVE_ORIGIN", "http://localhost:4021");

  let routeUrl: string;
  let topUpCents: number;
  let walletTimeoutMs: number;
  let eventClockOffsetMs: number;
  let loseFirstPurchaseAnswer: boolean;
  let api: URL;
  let account: PrivateKeyAccount;
  let proxy: RecordingProxy | undefined;
  let x402: LagoX402 | undefined;
  const servers: Server[] = [];
  const reports: { err: unknown; where: LagoX402ErrorWhere }[] = [];

  const state: {
    challenged?: boolean;
    /** The paid call's PAYMENT-SIGNATURE, sent again in step 4. */
    payment?: string;
    toppedUp?: boolean;
    baseline?: Wallet;
    signedIn?: boolean;
  } = {};

  async function lagoGet(path: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(api.href + path, {
      headers: { Authorization: `Bearer ${env.LAGO_API_KEY}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Not JSON: no body to read.
    }
    return { status: res.status, body };
  }

  const subscriptionId = () => `x402_${account.address}_${planCode}`;

  /** Ends the agent's subscription from an earlier run, if any; 404 when there is none. */
  async function terminateSubscription(): Promise<void> {
    const res = await fetch(`${api.href}/subscriptions/${encodeURIComponent(subscriptionId())}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.LAGO_API_KEY}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200 && res.status !== 404) {
      throw new Error(`terminating the agent's subscription answered ${res.status}`);
    }
  }

  /** The units the agent's subscription bills for the route's metric so far. */
  async function readUnits(): Promise<string | undefined> {
    const customer = encodeURIComponent(`x402_${account.address}`);
    const subscription = encodeURIComponent(subscriptionId());
    const { status, body } = await lagoGet(
      `/customers/${customer}/current_usage?external_subscription_id=${subscription}`,
    );
    if (status !== 200) return undefined;
    const charges = (body as { customer_usage?: { charges_usage?: ChargeUsage[] } } | null)?.customer_usage
      ?.charges_usage;
    return charges?.find((charge) => charge.billable_metric.code === metricCode)?.units;
  }

  async function readWallet(): Promise<Wallet | undefined> {
    const customer = encodeURIComponent(`x402_${account.address}`);
    const { status, body } = await lagoGet(`/wallets?external_customer_id=${customer}`);
    if (status !== 200) return undefined;
    const wallets = (body as { wallets?: Wallet[] } | null)?.wallets ?? [];
    return wallets.find((wallet) => wallet.code === walletCode);
  }

  const newReports = (from: number) =>
    reports.slice(from).map(({ err, where }) => `${where}: ${(err as Error).message}`);

  /** After a 503 `payment_pending`: waits its `Retry-After` and signs in, again until the credits
   * the top-up bought are granted. Resending the payment would not serve it: a settled payment
   * presented again is refused (409). */
  async function signInOncePaid(pending: Response): Promise<Response> {
    const signIn = wrapFetchWithPayment(fetch, new x402HTTPClient(signingClient(account)));
    let res = pending;
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = Math.min(60, Math.max(1, Number(res.headers.get("retry-after") ?? "30")));
      log(`step 2: payment pending; signing in in ${wait} s`);
      await sleep(wait * 1000);
      try {
        res = await signIn(routeUrl, { method: "POST" });
      } catch {
        // A 402: no credits granted yet, and the signing client refused to pay it.
        res = new Response(null, { status: 402 });
        continue;
      }
      if (!(await isPending(res))) return res;
    }
    return res;
  }

  /** Listens on LIVE_ORIGIN's port on every loopback address its host names. */
  async function listen(app: express.Express): Promise<void> {
    const url = new URL(origin);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("LIVE_ORIGIN must be http://localhost, http://127.0.0.1 or http://[::1] with a port");
    }
    const port = Number(url.port || "80");
    const hosts =
      url.hostname === "localhost" ? ["127.0.0.1", "::1"] : [url.hostname === "[::1]" ? "::1" : "127.0.0.1"];
    for (const [i, host] of hosts.entries()) {
      const server = createServer(app);
      const listening = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          // localhost's IPv6 address is a bonus when the machine has none.
          if (i > 0 && err.code === "EADDRNOTAVAIL") resolve(false);
          else reject(new Error(`cannot listen on ${host} port ${port} (${err.code ?? "error"})`));
        });
        server.listen(port, host, () => resolve(true));
      });
      if (listening) servers.push(server);
    }
  }

  beforeAll(async () => {
    routeUrl = new URL(PATH, origin).href;
    topUpCents = positiveInteger("LIVE_TOP_UP_CENTS", "3");
    walletTimeoutMs = positiveInteger("LIVE_WALLET_TIMEOUT_MS", "420000");
    eventClockOffsetMs = positiveInteger("LIVE_EVENT_CLOCK_OFFSET_MS", "5000");
    api = apiBase(env.LAGO_API_URL ?? "");
    account = buyer();
    await terminateSubscription();
    loseFirstPurchaseAnswer = setting("LIVE_LOSE_FIRST_PURCHASE_ANSWER", "") === "1";
    proxy = await startRecordingProxy(api, loseFirstPurchaseAnswer);
    x402 = await createLagoX402(
      {
        apiUrl: proxy.apiUrl,
        apiKey: env.LAGO_API_KEY ?? "",
        connectionCode,
        origin,
        routes: {
          [ROUTE]: {
            billableMetric: metricCode,
            planCode,
            walletCode,
            topUpAmountCents: topUpCents,
            estimatedCallCostCents: 1,
            fallbackUsage: 1,
            wallet: { name: "lago-x402-js live credits", rateAmount: "1" },
            resource: { description: "lago-x402-js live test", mimeType: "application/json" },
          },
        },
        onError: (err, where) => {
          reports.push({ err, where });
          log(`onError ${where}: ${(err as Error).message}`);
        },
      },
      { now: () => Date.now() - eventClockOffsetMs },
    );
    const app = express();
    app.post(PATH, lagoX402(x402, ROUTE), (_req, res) => {
      res.locals.lagoUsage = 1;
      res.json({ served: true });
    });
    await listen(app);
    log(`buyer ${account.address}`);
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    await x402?.close({ timeoutMs: 60_000 });
    await proxy?.close();
    if (proxy !== undefined) {
      log(`relayed to Lago: ${proxy.relays.map((r) => `${r.method} ${r.path} ${r.status}`).join("; ")}`);
    }
  });

  it("1 · a plain fetch gets a 402 offering only Base Sepolia and Solana devnet", async () => {
    const from = reports.length;
    const res = await fetch(routeUrl, { method: "POST" });

    expect(res.status).toBe(402);
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(testnetsOnly(pr)).toBeNull();
    const base = pr.accepts.find((entry) => entry.network === BASE_SEPOLIA);
    expect(base?.amount).toBe(String(topUpCents * 10_000));
    expect(pr.resource.url).toBe(routeUrl);
    const signIn = (pr.extensions?.["sign-in-with-x"] as { info: { domain: string; uri: string } }).info;
    expect(signIn).toMatchObject({ domain: new URL(origin).host, uri: routeUrl });
    expect(newReports(from)).toStrictEqual([]);
    log(`step 1: 402 offering ${pr.accepts.map((e) => e.network).join(", ")}`);
    state.challenged = true;
  });

  it("2 · an agent without sign-in pays the top-up and is served with PAYMENT-RESPONSE", async () => {
    expect(state.challenged, "step 1 must pass before anything is paid").toBe(true);
    const from = reports.length;
    const relaysFrom = proxy!.relays.length;
    const recorder = recordingFetch();
    const pay = wrapFetchWithPayment(recorder.fetch, new x402HTTPClient(payingClient(account, topUpCents)));

    const paid = await pay(routeUrl, { method: "POST" });
    expect(recorder.sent.map((h) => [h.has("sign-in-with-x"), h.has("payment-signature")])).toStrictEqual([
      [false, false],
      [false, true],
    ]);
    state.payment = recorder.sent[1].get("payment-signature")!;
    const purchaseRelays = () =>
      proxy!.relays.slice(relaysFrom).filter((r) => r.path.endsWith("/x402/credit_purchases"));
    const purchases = () => purchaseRelays().length;
    // One paid call: its credit purchase, plus at most the middleware's one retry of it.
    const paidCallPurchases = purchases();
    expect(paidCallPurchases).toBeGreaterThanOrEqual(1);
    expect(paidCallPurchases).toBeLessThanOrEqual(2);
    if (loseFirstPurchaseAnswer) {
      // The first answer was lost after Lago had processed it; the retry, under the same key, is
      // answered from Lago's record of the payment.
      const [first, retry] = purchaseRelays();
      expect(first.lost).toBe(true);
      expect(retry).toMatchObject({ status: 200, replayed: true });
      log("step 2: the first credit purchase's answer was lost; the retry was answered from Lago's record");
    }

    if (await isPending(paid)) {
      // Lago is still settling: the credits are the agent's once it has, so it signs in for them.
      const res = await signInOncePaid(paid);
      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual({ served: true });
      expect(res.headers.get("payment-response")).toBeNull();
      log("step 2: payment pending, then served from the credits it bought after signing in");
    } else {
      expect(paid.status).toBe(200);
      expect(await paid.json()).toStrictEqual({ served: true });
      const settled = decodePaymentResponseHeader(paid.headers.get("payment-response")!);
      expect(settled.success).toBe(true);
      expect(settled.network).toBe(BASE_SEPOLIA);
      expect(settled.transaction).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(settled.payer?.toLowerCase()).toBe(account.address.toLowerCase());
      log(`step 2: served; settled ${settled.transaction} on ${settled.network}`);
    }
    // Signing in never sends a payment.
    expect(purchases()).toBe(paidCallPurchases);
    expect(newReports(from)).toStrictEqual([]);
    state.toppedUp = true;

    // The baseline the wallet's ongoing usage must rise from (step 6).
    state.baseline = await poll("the buyer's wallet", 60_000, 2000, readWallet);
    const { balance_cents, ongoing_balance_cents, ongoing_usage_balance_cents } = state.baseline;
    log(
      `step 2: wallet baseline balance ${balance_cents}, ongoing balance ${ongoing_balance_cents}, ` +
        `ongoing usage ${ongoing_usage_balance_cents} (cents)`,
    );
  });

  it("3 · the same key, signing in, is served from its credits and never sends PAYMENT-SIGNATURE", async () => {
    expect(state.toppedUp, "step 2 must have topped the wallet up").toBe(true);
    const from = reports.length;
    const relaysFrom = proxy!.relays.length;
    const recorder = recordingFetch();
    const signIn = wrapFetchWithPayment(recorder.fetch, new x402HTTPClient(signingClient(account)));

    const res = await signIn(routeUrl, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ served: true });
    expect(res.headers.get("payment-response")).toBeNull();
    expect(recorder.sent.map((h) => [h.has("sign-in-with-x"), h.has("payment-signature")])).toStrictEqual([
      [false, false],
      [true, false],
    ]);
    expect(proxy!.relays.slice(relaysFrom).some((r) => r.path.endsWith("/x402/credit_purchases"))).toBe(
      false,
    );
    expect(newReports(from)).toStrictEqual([]);
    log("step 3: served from credits after signing in; no payment sent");
    state.signedIn = true;
  });

  it("4 · the paid call's PAYMENT-SIGNATURE, sent again, is refused 409 and neither served nor billed", async () => {
    expect(state.payment, "step 2 must have paid").toBeDefined();
    const from = reports.length;
    const relaysFrom = proxy!.relays.length;

    const res = await fetch(routeUrl, { method: "POST", headers: { "PAYMENT-SIGNATURE": state.payment! } });

    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("payment-response")).toBeNull();
    expect(await res.json()).toStrictEqual({ error: "payment_already_settled" });
    // Lago refused the settled payment presented under a new request's key.
    const purchases = proxy!.relays
      .slice(relaysFrom)
      .filter((r) => r.path.endsWith("/x402/credit_purchases"));
    expect(purchases.map((r) => r.status)).toStrictEqual([422]);
    expect(newReports(from)).toStrictEqual([]);
    log("step 4: the paid call's payment, sent again, was refused 409 payment_already_settled");
  });

  it("5 · ten gate checks: how many distinct Solana fee payers they offer", async () => {
    const relaysFrom = proxy!.relays.length;
    const feePayers: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await fetch(routeUrl, { method: "POST" });
      expect(res.status).toBe(402);
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(testnetsOnly(pr)).toBeNull();
      for (const entry of pr.accepts) {
        const feePayer = (entry.extra as { feePayer?: unknown } | undefined)?.feePayer;
        if (entry.network === SOLANA_DEVNET && typeof feePayer === "string") feePayers.push(feePayer);
      }
    }
    const gateChecks = proxy!.relays.slice(relaysFrom).filter((r) => r.path.endsWith("/x402/gate_checks"));
    expect(gateChecks).toHaveLength(10);
    if (feePayers.length === 0) {
      log("step 5: the connection offers no Solana devnet entry; fee payers not measured");
      return;
    }
    expect(feePayers).toHaveLength(10);
    const distinct = [...new Set(feePayers)];
    log(`step 5: ${distinct.length} distinct Solana fee payers in 10 gate checks: ${distinct.join(", ")}`);
  });

  it("6 · close() drains; Lago has both events and bills both, and the wallet's ongoing usage rose", async () => {
    expect(state.toppedUp && state.signedIn, "steps 2 and 3 must have been served").toBe(true);
    await x402!.close({ timeoutMs: 60_000 });

    // One event per served call (a retried delivery is relayed again with the same id): steps 2
    // and 3, and none for step 4's refused payment.
    const delivered = [
      ...new Map(
        proxy!.events.filter((e) => e.status >= 200 && e.status < 300).map((e) => [e.transactionId, e]),
      ).values(),
    ];
    expect(delivered).toHaveLength(2);
    expect(new Set(proxy!.events.map((e) => e.transactionId)).size).toBe(2);
    const subscription = `x402_${account.address}_${planCode}`;
    for (const sent of delivered) {
      const event = await poll(`event ${sent.transactionId}`, 120_000, 2000, async () => {
        const { status, body } = await lagoGet(`/events/${encodeURIComponent(sent.transactionId)}`);
        return status === 200 ? (body as { event: LagoEvent }).event : undefined;
      });
      expect(event.transaction_id).toBe(sent.transactionId);
      expect(event.code).toBe(metricCode);
      expect(event.external_subscription_id).toBe(sent.externalSubscriptionId);
      expect(event.external_subscription_id).toBe(subscription);
      expect(event.properties).toMatchObject({ value: "1", target_wallet_code: walletCode });
    }
    log(`step 6: Lago has both events (${delivered.map((e) => e.transactionId).join(", ")})`);

    // Stamped by a clock LIVE_EVENT_CLOCK_OFFSET_MS behind, both calls still fall inside the
    // subscription the purchase opened: both are billed.
    const billed = await poll("both calls to be billed", walletTimeoutMs, 10_000, async () => {
      const units = await readUnits();
      return units !== undefined && Number(units) >= 2 ? units : undefined;
    });
    expect(Number(billed)).toBe(2);
    log(
      `step 6: the subscription bills ${billed} units with the event clock ${eventClockOffsetMs} ms behind`,
    );

    const baseline = state.baseline!;
    const risen = await poll("the wallet's ongoing usage to rise", walletTimeoutMs, 10_000, async () => {
      const wallet = await readWallet();
      return wallet !== undefined && wallet.ongoing_usage_balance_cents > baseline.ongoing_usage_balance_cents
        ? wallet
        : undefined;
    });
    expect(risen.ongoing_usage_balance_cents).toBeGreaterThan(baseline.ongoing_usage_balance_cents);
    log(
      `step 6: ongoing usage ${baseline.ongoing_usage_balance_cents} -> ${risen.ongoing_usage_balance_cents}, ` +
        `ongoing balance ${baseline.ongoing_balance_cents} -> ${risen.ongoing_balance_cents} (cents)`,
    );
    expect(reports.map((r) => r.where)).toStrictEqual([]);
  });
});
