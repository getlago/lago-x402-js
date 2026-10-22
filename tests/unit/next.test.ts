/** Next-specific behaviour of `lago-x402/next`: wrapping, the promise form, the usage a handler
 * returns, billing through `after()` (never before the response) and when `after()` throws, a
 * handler that throws or returns no response, responses whose headers are immutable (`fetch()`,
 * `Response.redirect()`) or that have no body, and request translation. The wrapped handler is
 * called directly, as Next calls a route handler, with `after()` mocked as Next runs it on Node.
 * The three legs and every row of the README's error table run on Next in behaviour.test.ts;
 * tests/integration/next.test.ts runs the adapter in a real `next build && next start`. */
import { randomUUID } from "node:crypto";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { after, NextResponse } from "next/server.js";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createLagoX402,
  LagoX402ConfigError,
  LagoX402UsageError,
  type LagoX402,
  type LagoX402Config,
  type LagoX402ErrorWhere,
} from "../../src/index.js";
import { withLagoX402, type LagoX402Result } from "../../src/next.js";
import { evmAgent } from "../support/agent.js";
import { startFakeLago, type FakeAnswer, type FakeLago, type RecordedRequest } from "../support/fake-lago.js";
import { billableMetric, gateCheckChallenge, gateCheckPass } from "../support/fixtures.js";
import {
  HANDLER_BODY,
  PATH,
  ROUTE,
  inRequestScope,
  nextListener,
  runAfterTasks,
  serve,
  type NextContext,
} from "../support/frameworks.js";

// The real `next/server` (its `NextResponse`), with `after()` as Next runs it on a Node server.
vi.mock("next/server.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../support/frameworks.js")).nextServer,
}));

const apiKey = "test-key-" + randomUUID();
const PAYER = "0x00000000000000000000000000000000000b0b01";
/** A decodable SIGN-IN-WITH-X header: the gate forwards it, the fake Lago passes it. */
const SIGN_IN = Buffer.from(JSON.stringify({ address: PAYER })).toString("base64");
const SUBSCRIPTION = "sub_" + randomUUID();
const ORIGIN = "http://127.0.0.1:3000";
const URL_ = ORIGIN + PATH;

interface Report {
  err: Error;
  where: LagoX402ErrorWhere;
}

type Wrapped = (req: Request, ctx: NextContext) => Promise<Response>;

/** E7: a pass when the request carries `siwx`, else a challenge. */
function passOnSignIn(r: RecordedRequest): FakeAnswer {
  const signedIn = (r.json as { gate_check: { siwx?: unknown } }).gate_check.siwx !== undefined;
  return signedIn
    ? { status: 200, body: gateCheckPass({ external_subscription_id: SUBSCRIPTION }) }
    : { status: 200, body: gateCheckChallenge() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const context = (): NextContext => ({ params: Promise.resolve({}) });
const stranger = () => new Request(URL_, { method: "POST" });
const signedIn = (init: RequestInit = {}) =>
  new Request(URL_, { method: "POST", ...init, headers: { "SIGN-IN-WITH-X": SIGN_IN } });
const served =
  (usage = 1) =>
  async (): Promise<LagoX402Result> => ({ response: Response.json(HANDLER_BODY), usage });

describe("next", () => {
  let lago: FakeLago;
  let reports: Report[];
  let warn: MockInstance<typeof console.warn>;
  let cleanups: (() => Promise<unknown>)[];

  beforeEach(async () => {
    lago = await startFakeLago();
    lago.on("gate_checks", passOnSignIn);
    reports = [];
    cleanups = [];
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(after).mockClear();
  });
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await lago.close();
    vi.restoreAllMocks();
  });

  function config(routeName = ROUTE): LagoX402Config {
    return {
      apiUrl: lago.apiUrl,
      apiKey,
      connectionCode: "conn_test",
      origin: ORIGIN,
      routes: {
        [routeName]: {
          billableMetric: "tokens",
          planCode: "agents_plan",
          walletCode: "agents_wallet",
          topUpAmountCents: 500,
          estimatedCallCostCents: 2,
          wallet: { name: "Agent credits", rateAmount: "1" },
        },
      },
      onError: (err, where) => void reports.push({ err: err as Error, where }),
    };
  }

  async function instance(routeName = ROUTE): Promise<LagoX402> {
    const x402 = await createLagoX402(config(routeName));
    cleanups.push(() => x402.close({ timeoutMs: 10_000 }));
    return x402;
  }

  /** An instance with the `paid` route, boot's requests forgotten; `settle()` drains it. */
  async function booted() {
    const x402 = await instance();
    lago.requests.length = 0;
    const settle = async () => {
      await x402.close({ timeoutMs: 10_000 });
      return events();
    };
    return { x402, settle };
  }

  const e7 = () => lago.requests.filter((r) => r.route === "gate_checks");
  const events = () =>
    lago.requests
      .filter((r) => r.route === "events")
      .map(
        (r) =>
          (r.json as { event: { external_subscription_id: string; properties: { value: string } } }).event,
      );

  /** One request as Next serves it: the response, and the `after()` tasks it queued, unrun. */
  const call = (handler: Wrapped, req: Request, ctx = context()) => inRequestScope(() => handler(req, ctx));

  /** A paid request: the official client pays from the 402 the wrapped handler answers. */
  async function paidRequest(handler: Wrapped): Promise<Request> {
    const agent = evmAgent({ signIn: false, maxAmountPerPayment: "$10" });
    const challenge = await handler(stranger(), context());
    expect(challenge.status).toBe(402);
    const payment = await agent.client.createPaymentPayload(
      agent.http.getPaymentRequiredResponse((name) => challenge.headers.get(name)),
    );
    return new Request(URL_, { method: "POST", headers: agent.http.encodePaymentSignatureHeader(payment) });
  }

  /** A server on 127.0.0.1 a handler can `fetch()` from, answering every request the same way. */
  async function upstream(status: number, headers: [string, string][], body?: string): Promise<string> {
    const app = await serve(() => (_req, res) => {
      res.writeHead(status, headers.flat());
      res.end(body);
    });
    cleanups.push(app.close);
    return app.url + "/upstream";
  }

  describe("wrapping", () => {
    it("an unknown route name throws LagoX402ConfigError at wrap time", async () => {
      const x402 = await instance();
      expect(() => withLagoX402(x402, "nope", served())).toThrow(LagoX402ConfigError);
      expect(() => withLagoX402(x402, "nope", served())).toThrow(expect.objectContaining({ route: "nope" }));
    });

    it("a name that could never be a route stays out of the error", async () => {
      const x402 = await instance();
      let thrown: unknown;
      try {
        withLagoX402(x402, "bad\nname", served());
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LagoX402ConfigError);
      expect((thrown as LagoX402ConfigError).route).toBeNull();
      expect((thrown as Error).message).toContain("withLagoX402");
      expect((thrown as Error).message).not.toContain("bad");
    });

    it("an object createLagoX402 did not make is refused at wrap time", () => {
      const fake = { close: async () => {} } as LagoX402;
      expect(() => withLagoX402(fake, ROUTE, served())).toThrow(LagoX402ConfigError);
    });

    it("a handler that is not a function is refused at wrap time", async () => {
      const x402 = await instance();
      expect(() => withLagoX402(x402, ROUTE, undefined as never)).toThrow(TypeError);
    });

    it("wrapping a configured route calls nobody", async () => {
      const x402 = await instance();
      lago.requests.length = 0;
      const handler = vi.fn(served());
      withLagoX402(x402, ROUTE, handler);
      withLagoX402(Promise.resolve(x402), ROUTE, handler);
      expect(lago.requests).toHaveLength(0);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("given a promise", () => {
    it("each request waits for it, then is gated and served", async () => {
      const pending = deferred<LagoX402>();
      const handler = withLagoX402(pending.promise, ROUTE, served(2));

      const challenged = call(handler, stranger());
      const paid = call(handler, signedIn());
      const x402 = await instance();
      lago.requests.length = 0;
      await new Promise((r) => setTimeout(r, 20));
      // Both requests are parked on the promise: neither has reached the gate.
      expect(e7()).toHaveLength(0);
      pending.resolve(x402);

      const { result: challenge } = await challenged;
      expect(challenge.status).toBe(402);
      expect(decodePaymentRequiredHeader(challenge.headers.get("payment-required")!).resource.url).toBe(URL_);
      const { result: res, tasks } = await paid;
      expect(res.status).toBe(200);
      await runAfterTasks(tasks);
      await x402.close({ timeoutMs: 10_000 });
      expect(events()).toHaveLength(1);
      expect(events()[0]).toMatchObject({
        external_subscription_id: SUBSCRIPTION,
        properties: { value: "2" },
      });
    });

    it("a rejected promise answers 503 unavailable, never calls the handler and reports nothing", async () => {
      const refused = Promise.reject(new LagoX402ConfigError(ROUTE, "refused"));
      refused.catch(() => {}); // The app's own await of createLagoX402 is what surfaces it.
      const handler = vi.fn(served());

      const { result: res, tasks } = await call(withLagoX402(refused, ROUTE, handler), signedIn());

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(handler).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
      expect(lago.requests).toHaveLength(0);
      expect(reports).toStrictEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("a request in flight while boot refuses answers 503, and the refusal is reported though the app never awaited it", async () => {
      const inFlight = deferred<void>();
      lago.on("billable_metrics", async () => {
        await inFlight.promise;
        return { status: 200, body: billableMetric({ aggregation_type: "count_agg" }) };
      });
      const booting = createLagoX402(config());
      const handler = vi.fn(served());
      const wrapped = withLagoX402(booting, ROUTE, handler);

      const answer = call(wrapped, signedIn());
      inFlight.resolve();
      const { result: res } = await answer;

      expect(res.status).toBe(503);
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(handler).not.toHaveBeenCalled();
      const refusal = await booting.then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(LagoX402ConfigError);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ where: "boot", err: refusal });
    });

    it("a promise of an instance without that route answers 503 and reports gate.check", async () => {
      const handler = vi.fn(served());
      const { result: res } = await call(withLagoX402(instance("other"), ROUTE, handler), stranger());

      expect(res.status).toBe(503);
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(handler).not.toHaveBeenCalled();
      expect(reports).toHaveLength(1);
      expect(reports[0].where).toBe("gate.check");
      expect(reports[0].err).toMatchObject({ route: ROUTE });
    });
  });

  describe("the gate's own answer", () => {
    it("is a Response the handler never sees, on the configured origin whatever host the request names", async () => {
      const { x402 } = await booted();
      const handler = vi.fn(served());
      const req = new Request("http://attacker.example/paid?next=http://attacker.example", {
        method: "POST",
      });

      const { result: res, tasks } = await call(withLagoX402(x402, ROUTE, handler), req);

      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(402);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("{}");
      const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(pr.resource.url).toBe(URL_);
      expect(handler).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
      expect(tasks).toHaveLength(0);
    });
  });

  describe("usage", () => {
    it("a bare Response with status < 400 reports usage.extract (missing) and sends no event", async () => {
      const { x402, settle } = await booted();
      const handler = withLagoX402(x402, ROUTE, async () => Response.json(HANDLER_BODY));

      const { result: res, tasks } = await call(handler, signedIn());
      await runAfterTasks(tasks);

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(await settle()).toStrictEqual([]);
      expect(reports).toHaveLength(1);
      expect(reports[0].where).toBe("usage.extract");
      expect(reports[0].err).toBeInstanceOf(LagoX402UsageError);
      expect(reports[0].err).toMatchObject({ reason: "missing" });
    });

    it("a bare Response with status >= 400 sends no event and reports nothing", async () => {
      const { x402, settle } = await booted();
      const handler = withLagoX402(x402, ROUTE, async () => Response.json(HANDLER_BODY, { status: 422 }));

      const { result: res, tasks } = await call(handler, signedIn());
      await runAfterTasks(tasks);

      expect(res.status).toBe(422);
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it("{ response, usage } is read only when the after() task runs, and sent as the event's value", async () => {
      const { x402, settle } = await booted();
      let reads = 0;
      const handler = withLagoX402(x402, ROUTE, async () => ({
        response: Response.json(HANDLER_BODY),
        get usage() {
          reads++;
          return 5;
        },
      }));

      const { result: res, tasks } = await call(handler, signedIn());
      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual(HANDLER_BODY);
      expect(reads).toBe(0);
      await runAfterTasks(tasks);
      expect(reads).toBe(1);

      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0]).toMatchObject({ external_subscription_id: SUBSCRIPTION, properties: { value: "5" } });
      expect(reports).toStrictEqual([]);
    });
  });

  describe("billing through after()", () => {
    it("the event is sent from after(), never before the response, and after() holds it until Lago answers", async () => {
      const answered = deferred<void>();
      lago.on("events", async () => {
        await answered.promise;
        return { status: 200, body: {} };
      });
      const { x402, settle } = await booted();
      const handler = withLagoX402(x402, ROUTE, served(3));

      const { result: res, tasks } = await call(handler, signedIn());

      // The response is out; billing is only queued with after().
      expect(res.status).toBe(200);
      expect(after).toHaveBeenCalledTimes(1);
      expect(tasks).toHaveLength(1);
      expect(typeof tasks[0]).toBe("function");
      await new Promise((r) => setTimeout(r, 50));
      expect(events()).toHaveLength(0);

      let done = false;
      const running = runAfterTasks(tasks).then(() => (done = true));
      await vi.waitFor(() => expect(events()).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 50));
      expect(done).toBe(false);
      answered.resolve();
      await running;
      expect(done).toBe(true);

      expect(await settle()).toHaveLength(1);
      expect(events()[0]).toMatchObject({ properties: { value: "3" } });
      expect(reports).toStrictEqual([]);
    });

    it("after() throwing (outside a request scope) still bills exactly once after a payment, and never throws", async () => {
      const { x402, settle } = await booted();
      const handler = withLagoX402(x402, ROUTE, served(4));
      const req = await paidRequest(handler);

      // Called outside any request scope: the mocked after() throws as Next's does.
      const res = await handler(req, context());

      expect(after).toHaveBeenCalledTimes(1);
      expect(vi.mocked(after).mock.results[0].type).toBe("throw");
      expect(res.status).toBe(200);
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
      expect(res.headers.get("cache-control")).toBe("private");
      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0].properties.value).toBe("4");
      expect(reports).toStrictEqual([]);
    });

    it("after() throwing inside a request scope bills at once, exactly once", async () => {
      const { x402, settle } = await booted();
      vi.mocked(after).mockImplementationOnce(() => {
        throw new Error("after is unavailable");
      });
      const handler = withLagoX402(x402, ROUTE, served(6));

      const { result: res, tasks } = await call(handler, signedIn());

      expect(res.status).toBe(200);
      expect(tasks).toHaveLength(0);
      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0].properties.value).toBe("6");
      expect(reports).toStrictEqual([]);
    });

    it("running the after() task twice bills once", async () => {
      const { x402, settle } = await booted();
      const { tasks } = await call(withLagoX402(x402, ROUTE, served(1)), signedIn());
      const task = tasks[0] as () => Promise<void>;

      await Promise.all([task(), task()]);

      expect(await settle()).toHaveLength(1);
    });
  });

  describe("a handler that fails", () => {
    it("a throw propagates for Next to answer 500: after() is never called, nothing billed or reported", async () => {
      const { x402, settle } = await booted();
      const thrown = new Error("handler failed");
      const handler = withLagoX402(x402, ROUTE, async () => {
        throw thrown;
      });

      await expect(call(handler, signedIn())).rejects.toBe(thrown);

      expect(after).not.toHaveBeenCalled();
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it("a throw after a payment propagates too, and nothing is billed", async () => {
      const { x402, settle } = await booted();
      // The 402 that paidRequest pays from never reaches the handler.
      const handler = withLagoX402(x402, ROUTE, async (): Promise<Response> => {
        throw new Error("handler failed");
      });
      const req = await paidRequest(handler);

      await expect(call(handler, req)).rejects.toThrow("handler failed");

      expect(lago.requests.filter((r) => r.route === "credit_purchases")).toHaveLength(1);
      expect(after).not.toHaveBeenCalled();
      expect(await settle()).toStrictEqual([]);
    });

    it.each<[string, unknown]>([
      ["undefined", undefined],
      ["a plain object", { ok: true }],
      ["{ response } that is not a Response", { response: "ok", usage: 1 }],
      ["{ usage } without a response", { usage: 1 }],
    ])("returning %s rejects with a TypeError, and nothing is billed", async (_name, value) => {
      const { x402, settle } = await booted();
      const handler = withLagoX402(x402, ROUTE, async () => value as Response);

      await expect(call(handler, signedIn())).rejects.toThrow(TypeError);

      expect(after).not.toHaveBeenCalled();
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it("a thrown handler is answered 500 through a server, and nothing is billed", async () => {
      const { x402, settle } = await booted();
      const handler = withLagoX402(x402, ROUTE, async (): Promise<Response> => {
        throw new Error("handler failed");
      });
      const app = await serve((origin) => nextListener(origin, { POST: handler }));
      cleanups.push(app.close);

      const res = await fetch(app.url + PATH, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(500);
      await app.close();
      expect(await settle()).toStrictEqual([]);
    });
  });

  describe("responses with immutable headers or no body", () => {
    it("a fetch() Response is rebuilt with PAYMENT-RESPONSE and private merged in, body intact", async () => {
      const { x402, settle } = await booted();
      const url = await upstream(200, [["Cache-Control", "public, max-age=60"]], "upstream body");
      const handler = withLagoX402(x402, ROUTE, async () => ({ response: await fetch(url), usage: 2 }));
      const req = await paidRequest(handler);

      const { result: res, tasks } = await call(handler, req);
      await runAfterTasks(tasks);

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60, private");
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
      expect(await res.text()).toBe("upstream body");
      expect(await settle()).toHaveLength(1);
    });

    it("Response.redirect() (immutable headers) keeps its status and Location", async () => {
      const { x402 } = await booted();
      const handler = withLagoX402(x402, ROUTE, async () => ({
        response: Response.redirect(ORIGIN + "/elsewhere", 307),
        usage: 1,
      }));

      const { result: res } = await call(handler, signedIn());

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(ORIGIN + "/elsewhere");
      expect(res.headers.get("cache-control")).toBe("private");
    });

    it.each([204, 205, 304])("a fetch() %i keeps its status and null body", async (status) => {
      const { x402, settle } = await booted();
      const url = await upstream(status, [["ETag", '"v1"']]);
      const handler = withLagoX402(x402, ROUTE, async () => ({ response: await fetch(url), usage: 1 }));

      const { result: res, tasks } = await call(handler, signedIn());
      await runAfterTasks(tasks);

      expect(res.status).toBe(status);
      expect(res.body).toBeNull();
      expect(res.headers.get("etag")).toBe('"v1"');
      expect(res.headers.get("cache-control")).toBe("private");
      expect(await settle()).toHaveLength(1);
    });

    it("a Response without an HTTP status (Response.error()) is replaced by 503 unavailable and billed nothing", async () => {
      const { x402, settle } = await booted();
      const handler = withLagoX402(x402, ROUTE, async () => ({ response: Response.error(), usage: 1 }));

      const { result: res, tasks } = await call(handler, signedIn());

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(tasks).toHaveLength(0);
      expect(await settle()).toStrictEqual([]);
    });

    it("after a payment, a Response without an HTTP status is replaced by 503 payment_pending, reported, billed nothing", async () => {
      const { x402, settle } = await booted();
      const handler = withLagoX402(x402, ROUTE, async () => ({ response: Response.error(), usage: 1 }));
      const req = await paidRequest(handler);

      const { result: res, tasks } = await call(handler, req);

      expect(lago.requests.filter((r) => r.route === "credit_purchases")).toHaveLength(1);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("retry-after")).toBe("30");
      expect(res.headers.get("payment-response")).toBeNull();
      expect(await res.json()).toStrictEqual({ error: "payment_pending" });
      expect(tasks).toHaveLength(0);
      expect(await settle()).toStrictEqual([]);
      expect(reports.map((r) => r.where)).toStrictEqual(["gate.purchase"]);
      expect(reports[0].err.message).toBe(
        `lago-x402 route "${ROUTE}": a paid call's response could not be served`,
      );
    });

    it("a NextResponse keeps its cookies and its own headers, with private merged in", async () => {
      const { x402 } = await booted();
      const handler = withLagoX402(x402, ROUTE, async () => {
        const response = NextResponse.json(HANDLER_BODY, { headers: { "Cache-Control": "no-cache" } });
        response.cookies.set("session", "abc");
        return { response, usage: 1 };
      });

      const { result: res } = await call(handler, signedIn());

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache, private");
      expect(res.headers.getSetCookie()).toStrictEqual(["session=abc; Path=/"]);
      expect(await res.json()).toStrictEqual(HANDLER_BODY);
    });
  });

  describe("request translation", () => {
    it("the handler gets the request (body unread) and the context it was called with", async () => {
      const { x402 } = await booted();
      const seen: { req?: Request; ctx?: unknown; body?: unknown } = {};
      const handler = withLagoX402(x402, ROUTE, async (req: Request, ctx: NextContext) => {
        Object.assign(seen, { req, ctx, body: await req.json() });
        return { response: Response.json(HANDLER_BODY), usage: 1 };
      });
      const req = signedIn({ body: JSON.stringify({ prompt: "hi" }) });
      const ctx = context();

      const { result: res } = await call(handler, req, ctx);

      expect(res.status).toBe(200);
      expect(seen.req).toBe(req);
      expect(seen.ctx).toBe(ctx);
      expect(seen.body).toStrictEqual({ prompt: "hi" });
    });

    it("GET is gated with its method and the request's headers", async () => {
      const { x402 } = await booted();
      const handler = withLagoX402(x402, ROUTE, served());

      const { result: challenge } = await call(handler, new Request(URL_));
      const { result: res } = await call(
        handler,
        new Request(URL_, { headers: { "sign-in-with-x": SIGN_IN } }),
      );

      expect(challenge.status).toBe(402);
      expect(res.status).toBe(200);
      expect(e7().map((r) => (r.json as { gate_check: { siwx?: unknown } }).gate_check.siwx)).toStrictEqual([
        undefined,
        { address: PAYER },
      ]);
    });
  });
});
