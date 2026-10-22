/** Hono-specific behaviour of `lago-x402/hono`: attaching, the promise form, raw-socket request
 * targets as `@hono/node-server` and Hono's router dispatch them, billing on the Node response
 * (and the fallback without Node bindings, `app.request()`), responses whose headers are
 * immutable (`fetch()`), `Cache-Control` however the handler builds its response, and handler
 * failures. The three legs and every row of the README's error table run on Hono in
 * behaviour.test.ts. */
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { Hono, type MiddlewareHandler } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { lagoX402, type LagoX402Variables } from "../../src/hono.js";
import { createLagoX402, LagoX402ConfigError, type LagoX402, type LagoX402Config } from "../../src/index.js";
import type { LagoX402ErrorWhere } from "../../src/index.js";
import { evmAgent } from "../support/agent.js";
import { startFakeLago, type FakeAnswer, type FakeLago, type RecordedRequest } from "../support/fake-lago.js";
import { billableMetric, gateCheckChallenge, gateCheckPass } from "../support/fixtures.js";
import {
  CATCH_ALL_BODY,
  HANDLER_BODY,
  PATH,
  ROUTE,
  honoApp,
  honoNodeListener,
  rawExchange,
  serve,
  startApp,
  type App,
  type HonoEnv,
} from "../support/frameworks.js";

const apiKey = "test-key-" + randomUUID();
const PAYER = "0x00000000000000000000000000000000000b0b01";
/** A decodable SIGN-IN-WITH-X header: the gate forwards it, the fake Lago passes it. */
const SIGN_IN = Buffer.from(JSON.stringify({ address: PAYER })).toString("base64");
const SUBSCRIPTION = "sub_" + randomUUID();
/** The origin of instances used without a server (`app.request()` targets `http://localhost`). */
const ORIGIN = "http://127.0.0.1:3000";

interface Report {
  err: Error;
  where: LagoX402ErrorWhere;
}

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

describe("hono", () => {
  let lago: FakeLago;
  let reports: Report[];
  let warn: MockInstance<typeof console.warn>;
  let cleanups: (() => Promise<unknown>)[];

  beforeEach(async () => {
    lago = await startFakeLago();
    reports = [];
    cleanups = [];
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await lago.close();
    vi.restoreAllMocks();
  });

  function config(origin: string, routeName = ROUTE): LagoX402Config {
    return {
      apiUrl: lago.apiUrl,
      apiKey,
      connectionCode: "conn_test",
      origin,
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

  async function instance(origin: string, routeName = ROUTE): Promise<LagoX402> {
    const x402 = await createLagoX402(config(origin, routeName));
    cleanups.push(() => x402.close({ timeoutMs: 10_000 }));
    return x402;
  }

  const e7 = () => lago.requests.filter((r) => r.route === "gate_checks");
  const events = () =>
    lago.requests
      .filter((r) => r.route === "events")
      .map(
        (r) =>
          (r.json as { event: { external_subscription_id: string; properties: { value: string } } }).event,
      );

  /** A Hono app served by `@hono/node-server` whose routes `mount` attaches, with an instance on
   * the app's origin. `settle()` closes the app (every response finished, so billing ran) and
   * drains the instance. */
  async function bespoke(mount: (app: Hono<HonoEnv>, x402: LagoX402) => void) {
    let x402!: LagoX402;
    const app = await serve(async (origin) => {
      x402 = await instance(origin);
      const hono = honoApp();
      mount(hono, x402);
      return honoNodeListener(hono);
    });
    cleanups.push(app.close);
    lago.requests.length = 0;
    const settle = async () => {
      await app.close();
      await x402.close({ timeoutMs: 10_000 });
      return events();
    };
    return { app, x402, settle };
  }

  /** A Hono app used without a server (`app.request()`): `c.env` has no Node bindings. */
  async function inProcess(mount: (app: Hono<HonoEnv>, x402: LagoX402) => void) {
    const x402 = await instance(ORIGIN);
    const app = honoApp();
    mount(app, x402);
    lago.requests.length = 0;
    const settle = async () => {
      await x402.close({ timeoutMs: 10_000 });
      return events();
    };
    return { app, settle };
  }

  /** The standard app (`frameworks.ts`) on an instance with the app's origin. */
  async function standard(): Promise<App> {
    const app = await startApp("hono", (origin) => instance(origin), { usage: 1 });
    cleanups.push(app.close);
    lago.requests.length = 0;
    return app;
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

  /** Pays from the 402 a POST to `url` answers, with the official client; returns the paid answer. */
  async function pay(url: string): Promise<Response> {
    const agent = evmAgent({ signIn: false, maxAmountPerPayment: "$10" });
    const challenge = await fetch(url, { method: "POST" });
    expect(challenge.status).toBe(402);
    const payment = await agent.client.createPaymentPayload(
      agent.http.getPaymentRequiredResponse((name) => challenge.headers.get(name)),
    );
    return fetch(url, { method: "POST", headers: agent.http.encodePaymentSignatureHeader(payment) });
  }

  const signedIn = (url: string) => fetch(url, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

  describe("attaching", () => {
    it("an unknown route name throws LagoX402ConfigError at attach time", async () => {
      const x402 = await instance(ORIGIN);
      expect(() => lagoX402(x402, "nope")).toThrow(LagoX402ConfigError);
      expect(() => lagoX402(x402, "nope")).toThrow(expect.objectContaining({ route: "nope" }));
    });

    it("a name that could never be a route stays out of the error", async () => {
      const x402 = await instance(ORIGIN);
      let thrown: unknown;
      try {
        lagoX402(x402, "bad\nname");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LagoX402ConfigError);
      expect((thrown as LagoX402ConfigError).route).toBeNull();
      expect((thrown as Error).message).not.toContain("bad");
    });

    it("an object createLagoX402 did not make is refused at attach time", () => {
      const fake = { close: async () => {} } as LagoX402;
      expect(() => lagoX402(fake, ROUTE)).toThrow(LagoX402ConfigError);
    });

    it("attaching a configured route calls nobody", async () => {
      const x402 = await instance(ORIGIN);
      lago.requests.length = 0;
      expect(typeof lagoX402(x402, ROUTE)).toBe("function");
      expect(lago.requests).toHaveLength(0);
    });

    it("LagoX402Variables types the usage the handler reports, with or without Node bindings", async () => {
      const x402 = await instance(ORIGIN);
      const typed = new Hono<{ Variables: LagoX402Variables }>();
      typed.post(PATH, lagoX402(x402, ROUTE), (c) => {
        c.set("lagoUsage", 1);
        // @ts-expect-error usage is a number
        c.set("lagoUsage", "1");
        return c.json(HANDLER_BODY);
      });
      const node = new Hono<{ Bindings: HttpBindings; Variables: LagoX402Variables }>();
      node.post(PATH, lagoX402(x402, ROUTE), (c) => {
        c.set("lagoUsage", c.env.outgoing.statusCode);
        return c.json(HANDLER_BODY);
      });
      const gate: MiddlewareHandler<{ Variables: LagoX402Variables }> = lagoX402(x402, ROUTE);
      new Hono().post(PATH, gate, (c) => {
        c.set("lagoUsage", 1);
        return c.json(HANDLER_BODY);
      });
    });
  });

  describe("given a promise", () => {
    it("each request waits for it, then is gated and served", async () => {
      lago.on("gate_checks", passOnSignIn);
      const pending = deferred<LagoX402>();
      const app = await startApp("hono", pending.promise, { usage: 2 });
      cleanups.push(app.close);

      const challenged = fetch(app.url + PATH, { method: "POST" });
      const served = signedIn(app.url + PATH);
      const x402 = await instance(app.url);
      pending.resolve(x402);

      const res = await challenged;
      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).resource.url).toBe(
        app.url + PATH,
      );
      expect((await served).status).toBe(200);
      await app.close();
      await x402.close({ timeoutMs: 10_000 });
      expect(events()).toHaveLength(1);
      expect(events()[0].external_subscription_id).toBe(SUBSCRIPTION);
    });

    it("a request in flight while boot refuses answers 503, and the refusal is reported though the app never awaited it", async () => {
      // The request's `await` is the only handler on the boot promise, attached before the
      // rejection, so Node raises no unhandled rejection: the report is the only trace.
      const inFlight = deferred<void>();
      lago.on("billable_metrics", async () => {
        await inFlight.promise;
        return { status: 200, body: billableMetric({ aggregation_type: "count_agg" }) };
      });
      const booting = createLagoX402(config(ORIGIN));
      let served = false;
      const app = await serve(() => {
        const hono = honoApp();
        hono.post(
          PATH,
          async (_c, next) => {
            inFlight.resolve();
            await next();
          },
          lagoX402(booting, ROUTE),
          (c) => {
            served = true;
            return c.json(HANDLER_BODY);
          },
        );
        return honoNodeListener(hono);
      });
      cleanups.push(app.close);

      const res = await signedIn(app.url + PATH);

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(served).toBe(false);
      expect(e7()).toHaveLength(0);
      const refusal = await booting.then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(LagoX402ConfigError);
      expect(reports).toHaveLength(1);
      expect(reports[0].where).toBe("boot");
      expect(reports[0].err).toBe(refusal);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(`[lago-x402] boot failed: ${(refusal as Error).message}`);
    });

    it("a promise of an instance without that route answers 503 and reports gate.check", async () => {
      // A resolved instance is checked at attach time; a promised one can only be checked per request.
      const app = await startApp("hono", instance(ORIGIN, "other"), { usage: 1 });
      cleanups.push(app.close);

      const res = await fetch(app.url + PATH, { method: "POST" });

      expect(res.status).toBe(503);
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(reports).toHaveLength(1);
      expect(reports[0].where).toBe("gate.check");
      expect(reports[0].err).toMatchObject({ route: ROUTE });
    });
  });

  describe("raw-socket request targets", () => {
    // [target, what @hono/node-server + Hono's router dispatch it to, the pathname the gate
    // sees]: the gate or the catch-all, never the handler. Hono routes strictly (no trailing
    // slash, case-sensitive), decodes unreserved escapes (`%70` is "p") before matching, and
    // the server resolves dot segments and `\` while building `c.req.url`. Each target is sent
    // with both methods the route is mounted for.
    const TARGETS: [string, "gate" | "catch-all", string?][] = [
      ["/paid%2Fx", "catch-all"],
      ["/paid%5C", "catch-all"],
      ["/paid\\", "catch-all"],
      ["/paid/%0A", "catch-all"],
      ["/paid%0D", "catch-all"],
      ["/paid%E2%80%A8", "catch-all"],
      ["/paid%E2%80%A9", "catch-all"],
      ["/paid%", "catch-all"],
      ["/paid%c0", "catch-all"],
      ["/paid/", "catch-all"],
      ["/PAID", "catch-all"],
      ["/paid;x", "catch-all"],
      ["//attacker.example/paid", "catch-all"],
      ["/paid?next=http://attacker.example", "gate", "/paid"],
      ["/paid#x", "gate", "/paid"],
      ["http://attacker.example/paid", "gate", "/paid"],
      ["/%70aid", "gate", "/%70aid"],
      ["/pa%69d", "gate", "/pa%69d"],
      ["/x/../paid", "gate", "/paid"],
      ["/%2e/paid", "gate", "/paid"],
    ];
    const REQUESTS = (["POST", "GET"] as const).flatMap((method) =>
      TARGETS.map(([target, dispatched, pathname]) => ({ method, target, dispatched, pathname })),
    );

    it.each(REQUESTS)("$method $target → $dispatched", async ({ method, target, dispatched, pathname }) => {
      const app = await standard();

      const reply = await rawExchange(
        app.port,
        `${method} ${target} HTTP/1.1\r\nHost: attacker.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );

      expect(reply.body).not.toBe(JSON.stringify(HANDLER_BODY));
      if (dispatched === "gate") {
        expect(reply.status).toBe(402);
        expect(e7()).toHaveLength(1);
        const pr = decodePaymentRequiredHeader(reply.headers["payment-required"]);
        expect(pr.resource.url).toBe(app.url + pathname);
      } else {
        expect(reply.status).toBe(200);
        expect(reply.body).toBe(CATCH_ALL_BODY);
        expect(e7()).toHaveLength(0);
      }
      await app.close();
      expect(events()).toHaveLength(0);
    });
  });

  describe("without Node bindings (app.request())", () => {
    function mountPaid(hono: Hono<HonoEnv>, x402: LagoX402, status: 200 | 404 = 200): void {
      hono.post(PATH, lagoX402(x402, ROUTE), (c) => {
        c.set("lagoUsage", 4);
        return c.json(HANDLER_BODY, status);
      });
    }

    it("a stranger gets a 402 whose resource.url is on the configured origin, not the request's host", async () => {
      const { app, settle } = await inProcess(mountPaid);

      const res = await app.request(PATH, { method: "POST" });

      expect(res.status).toBe(402);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toBe("{}");
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).resource.url).toBe(
        ORIGIN + PATH,
      );
      expect(await settle()).toStrictEqual([]);
    });

    it("a signed-in call is served and billed exactly once", async () => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await inProcess(mountPaid);

      const res = await app.request(PATH, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(200);
      expect(await res.json()).toStrictEqual(HANDLER_BODY);
      expect(res.headers.get("cache-control")).toBe("private");
      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0]).toMatchObject({ external_subscription_id: SUBSCRIPTION, properties: { value: "4" } });
      expect(reports).toStrictEqual([]);
    });

    it("a paid call carries PAYMENT-RESPONSE and is billed exactly once", async () => {
      const { app, settle } = await inProcess(mountPaid);
      const agent = evmAgent({ signIn: false, maxAmountPerPayment: "$10" });
      const challenge = await app.request(PATH, { method: "POST" });
      const payment = await agent.client.createPaymentPayload(
        agent.http.getPaymentRequiredResponse((name) => challenge.headers.get(name)),
      );

      const res = await app.request(PATH, {
        method: "POST",
        headers: agent.http.encodePaymentSignatureHeader(payment),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
      expect(await settle()).toHaveLength(1);
    });

    it("a 4xx from the handler sends no event", async () => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await inProcess((hono, x402) => mountPaid(hono, x402, 404));

      const res = await app.request(PATH, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it("a handler that throws is answered 500 by Hono and billed nothing", async () => {
      lago.on("gate_checks", passOnSignIn);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const bug = new Error("handler bug");
      const { app, settle } = await inProcess((hono, x402) => {
        hono.post(PATH, lagoX402(x402, ROUTE), (c) => {
          c.set("lagoUsage", 1);
          throw bug;
        });
      });

      const res = await app.request(PATH, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(500);
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
      // Hono's own error handler logs it.
      expect(error).toHaveBeenCalledWith(bug);
    });

    it("a handler that returns no response is answered 500 by Hono and billed nothing", async () => {
      lago.on("gate_checks", passOnSignIn);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { app, settle } = await inProcess((hono, x402) => {
        hono.post(PATH, lagoX402(x402, ROUTE), async (c) => {
          c.set("lagoUsage", 1);
        });
      });

      const res = await app.request(PATH, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(500);
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
      expect(error).toHaveBeenCalledTimes(1);
    });
  });

  describe("a fetch() Response (immutable headers)", () => {
    const UPSTREAM_HEADERS: [string, string][] = [
      ["Cache-Control", "public, max-age=60"],
      ["Content-Type", "text/plain"],
      ["Set-Cookie", "a=1"],
      ["Set-Cookie", "b=2"],
    ];

    function mountProxy(hono: Hono<HonoEnv>, x402: LagoX402, url: string): void {
      hono.post(PATH, lagoX402(x402, ROUTE), async (c) => {
        c.set("lagoUsage", 1);
        const res = await fetch(url);
        expect(() => res.headers.set("X-Probe", "1")).toThrow(TypeError);
        return res;
      });
    }

    it("a paid call through @hono/node-server gets PAYMENT-RESPONSE and private merged in", async () => {
      const url = await upstream(200, UPSTREAM_HEADERS, "upstream");
      const { app, settle } = await bespoke((hono, x402) => mountProxy(hono, x402, url));

      const res = await pay(app.url + PATH);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("upstream");
      expect(res.headers.get("cache-control")).toBe("public, max-age=60, private");
      expect(res.headers.getSetCookie()).toStrictEqual(["a=1", "b=2"]);
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
      expect(await settle()).toHaveLength(1);
      expect(reports).toStrictEqual([]);
    });

    it("a signed-in call through app.request() gets private merged in", async () => {
      lago.on("gate_checks", passOnSignIn);
      const url = await upstream(200, UPSTREAM_HEADERS, "upstream");
      const { app, settle } = await inProcess((hono, x402) => mountProxy(hono, x402, url));

      const res = await app.request(PATH, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("upstream");
      expect(res.headers.get("cache-control")).toBe("public, max-age=60, private");
      expect(res.headers.getSetCookie()).toStrictEqual(["a=1", "b=2"]);
      expect(await settle()).toHaveLength(1);
    });

    it.each([204, 205, 304])("a %i keeps its status and null body", async (status) => {
      const url = await upstream(status, [["Cache-Control", "max-age=60"]]);
      const { app, settle } = await bespoke((hono, x402) => mountProxy(hono, x402, url));

      const res = await pay(app.url + PATH);

      expect(res.status).toBe(status);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe("max-age=60, private");
      expect(res.headers.get("payment-response")).not.toBeNull();
      expect(await settle()).toHaveLength(1);
    });
  });

  describe("Cache-Control, however the handler builds its response", () => {
    interface Builder {
      name: string;
      handle: MiddlewareHandler<HonoEnv>;
      status?: number;
      cacheControl: string;
      /** Another header the handler set, which must arrive untouched. */
      extra?: string;
    }
    const BUILDERS: Builder[] = [
      {
        name: "c.header + c.text",
        handle: async (c) => {
          c.header("Cache-Control", "public, max-age=60");
          return c.text("ok");
        },
        cacheControl: "public, max-age=60, private",
      },
      {
        name: "c.text with headers",
        handle: async (c) => c.text("ok", 200, { "Cache-Control": "no-cache", "X-Extra": "1" }),
        cacheControl: "no-cache, private",
        extra: "1",
      },
      {
        name: "a new Response",
        handle: async () =>
          new Response("ok", { headers: { "Cache-Control": "public, max-age=60", "X-Extra": "1" } }),
        cacheControl: "public, max-age=60, private",
        extra: "1",
      },
      {
        name: "no Cache-Control",
        handle: async (c) => c.text("ok"),
        cacheControl: "private",
      },
      {
        name: "c.body(null, 204)",
        handle: async (c) => c.body(null, 204),
        status: 204,
        cacheControl: "private",
      },
      {
        name: "already private",
        handle: async (c) => c.text("ok", 200, { "Cache-Control": "PRIVATE, max-age=5" }),
        cacheControl: "PRIVATE, max-age=5",
      },
    ];

    it.each(BUILDERS)("$name", async ({ handle, status, cacheControl, extra }) => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await bespoke((hono, x402) => {
        hono.post(
          PATH,
          lagoX402(x402, ROUTE),
          async (c, next) => {
            c.set("lagoUsage", 1);
            await next();
          },
          handle,
        );
      });

      const res = await signedIn(app.url + PATH);

      expect(res.status).toBe(status ?? 200);
      expect(await res.text()).toBe(status === 204 ? "" : "ok");
      expect(res.headers.get("cache-control")).toBe(cacheControl);
      if (extra !== undefined) expect(res.headers.get("x-extra")).toBe(extra);
      expect(await settle()).toHaveLength(1);
    });

    // An earlier middleware's headers reach Hono either as prepared headers (`c.header` before
    // anything was built) or on `c.res` itself (`hono/cors` writes there).
    const EARLIER: [string, MiddlewareHandler<HonoEnv>][] = [
      [
        "c.header",
        async (c, next) => {
          c.header("X-Earlier", "1");
          c.header("Cache-Control", "public, max-age=3600");
          c.header("Content-Type", "text/html");
          await next();
        },
      ],
      [
        "c.res.headers",
        async (c, next) => {
          c.res.headers.set("X-Earlier", "1");
          c.res.headers.set("Cache-Control", "public, max-age=3600");
          c.res.headers.set("Content-Type", "text/html");
          await next();
        },
      ],
    ];

    it.each(EARLIER)(
      "headers an earlier middleware set (%s) stay on the 402, which is never cacheable",
      async (_name, earlier) => {
        const { app } = await bespoke((hono, x402) => {
          hono.post(PATH, earlier, lagoX402(x402, ROUTE), (c) => c.json(HANDLER_BODY));
        });

        const res = await fetch(app.url + PATH, { method: "POST" });

        expect(res.status).toBe(402);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(res.headers.get("x-earlier")).toBe("1");
        expect(await res.text()).toBe("{}");
      },
    );

    it.each(EARLIER)(
      "headers an earlier middleware set (%s) stay on a served response, with private merged in",
      async (_name, earlier) => {
        lago.on("gate_checks", passOnSignIn);
        const { app, settle } = await bespoke((hono, x402) => {
          hono.post(PATH, earlier, lagoX402(x402, ROUTE), (c) => {
            c.set("lagoUsage", 1);
            return c.json(HANDLER_BODY);
          });
        });

        const res = await signedIn(app.url + PATH);

        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=3600, private");
        expect(res.headers.get("x-earlier")).toBe("1");
        expect(await settle()).toHaveLength(1);
      },
    );
  });

  describe("billing on the Node response", () => {
    it("a client that aborts after the headers were sent is billed exactly once", async () => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await bespoke((hono, x402) => {
        hono.post("/stream", lagoX402(x402, ROUTE), (c) => {
          c.set("lagoUsage", 5);
          // Never closes: the server cancels it when the client goes away.
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
            },
          });
          return c.body(stream, 200, { "Content-Type": "text/plain" });
        });
      });

      const head = await new Promise<string>((resolve, reject) => {
        const socket = connect(app.port, "127.0.0.1");
        let data = "";
        socket.setEncoding("latin1");
        socket.on("error", reject);
        socket.on("data", (chunk: string) => {
          data += chunk;
          if (data.includes("partial")) {
            socket.destroy();
            resolve(data);
          }
        });
        socket.write(
          `POST /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nSIGN-IN-WITH-X: ${SIGN_IN}\r\nContent-Length: 0\r\n\r\n`,
        );
      });

      expect(head).toMatch(/^HTTP\/1\.1 200 /);
      expect(head.toLowerCase()).toContain("cache-control: private");
      const billed = await settle();
      expect(billed).toHaveLength(1);
      expect(billed[0]).toMatchObject({ external_subscription_id: SUBSCRIPTION, properties: { value: "5" } });
      expect(reports).toStrictEqual([]);
    });

    it("a client that aborts before any header was sent is not billed, though the handler then answers 200", async () => {
      lago.on("gate_checks", passOnSignIn);
      const started = deferred<void>();
      const answered = deferred<void>();
      const { app, settle } = await bespoke((hono, x402) => {
        hono.post("/slow", lagoX402(x402, ROUTE), async (c) => {
          c.set("lagoUsage", 5);
          const aborted = new Promise((resolve) => c.req.raw.signal.addEventListener("abort", resolve));
          started.resolve();
          await aborted;
          answered.resolve();
          return c.text("late");
        });
      });

      const socket = connect(app.port, "127.0.0.1");
      socket.on("error", () => {});
      socket.write(
        `POST /slow HTTP/1.1\r\nHost: 127.0.0.1\r\nSIGN-IN-WITH-X: ${SIGN_IN}\r\nContent-Length: 0\r\n\r\n`,
      );
      await started.promise;
      socket.destroy();
      await answered.promise;

      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it("the status that went out counts: an outer middleware's 5xx sends no event", async () => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await bespoke((hono, x402) => {
        hono.use(PATH, async (c, next) => {
          await next();
          c.res = new Response("replaced", { status: 502 });
        });
        hono.post(PATH, lagoX402(x402, ROUTE), (c) => {
          c.set("lagoUsage", 1);
          return c.json(HANDLER_BODY);
        });
      });

      const res = await signedIn(app.url + PATH);

      expect(res.status).toBe(502);
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });
  });

  describe("never throws into Hono", () => {
    it("an unexpected throw inside the adapter answers 503 unavailable and never serves", async () => {
      let served = false;
      const { app } = await bespoke((hono, x402) => {
        hono.post(
          PATH,
          async (c, next) => {
            Object.defineProperty(c.req, "url", {
              get() {
                throw new Error("boom");
              },
            });
            await next();
          },
          lagoX402(x402, ROUTE),
          (c) => {
            served = true;
            return c.json(HANDLER_BODY);
          },
        );
      });

      const res = await signedIn(app.url + PATH);

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(served).toBe(false);
    });

    it("a response that cannot be made private is replaced by 503 unavailable and billed nothing", async () => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await bespoke((hono, x402) => {
        hono.post(PATH, lagoX402(x402, ROUTE), (c) => {
          c.set("lagoUsage", 1);
          return Response.error();
        });
      });

      const res = await signedIn(app.url + PATH);

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(await settle()).toStrictEqual([]);
    });

    it("after a payment, a response that cannot be made private is replaced by 503 payment_pending, reported, billed nothing", async () => {
      const { app, settle } = await bespoke((hono, x402) => {
        hono.post(PATH, lagoX402(x402, ROUTE), (c) => {
          c.set("lagoUsage", 1);
          return Response.error();
        });
      });

      const res = await pay(app.url + PATH);

      expect(lago.requests.filter((r) => r.route === "credit_purchases")).toHaveLength(1);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("retry-after")).toBe("30");
      expect(res.headers.get("payment-response")).toBeNull();
      expect(await res.json()).toStrictEqual({ error: "payment_pending" });
      expect(await settle()).toStrictEqual([]);
      expect(reports.map((r) => r.where)).toStrictEqual(["gate.purchase"]);
      expect(reports[0].err.message).toBe(
        `lago-x402 route "${ROUTE}": a paid call's response could not be served`,
      );
    });

    it("a handler that throws is answered 500 by Hono, still private, and billed nothing", async () => {
      lago.on("gate_checks", passOnSignIn);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const bug = new Error("handler bug");
      const { app, settle } = await bespoke((hono, x402) => {
        hono.post(PATH, lagoX402(x402, ROUTE), (c) => {
          c.set("lagoUsage", 1);
          throw bug;
        });
      });

      const res = await signedIn(app.url + PATH);

      expect(res.status).toBe(500);
      expect(res.headers.get("cache-control")).toBe("private");
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
      expect(error).toHaveBeenCalledWith(bug);
    });

    it("a handler that throws a non-Error is answered 500 by the server and billed nothing", async () => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await bespoke((hono, x402) => {
        hono.post(PATH, lagoX402(x402, ROUTE), (c) => {
          c.set("lagoUsage", 1);
          throw "not an Error";
        });
      });

      const res = await signedIn(app.url + PATH);

      expect(res.status).toBe(500);
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });
  });

  describe("request translation", () => {
    it("a sub-app mounted under a prefix gates the full URL's pathname", async () => {
      const { app } = await bespoke((hono, x402) => {
        const api = new Hono<HonoEnv>();
        api.post(PATH, lagoX402(x402, ROUTE), (c) => c.json(HANDLER_BODY));
        hono.route("/api", api);
      });

      const res = await fetch(app.url + "/api/paid?x=1", { method: "POST" });

      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).resource.url).toBe(
        app.url + "/api/paid",
      );
    });
  });
});
