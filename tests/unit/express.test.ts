/** Express-specific behaviour of `lago-x402/express`, on Express 5 and Express 4: attaching,
 * the promise form, raw-socket request targets upstream's middleware was bypassed with, billing
 * when the client goes away, `Cache-Control` whatever way the handler writes its headers, and
 * never letting a throw reach Express (Express 4 does not catch a rejected middleware). The three
 * legs and every §3 row run on both majors in behaviour.test.ts. */
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { Express, NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { lagoX402 } from "../../src/express.js";
import { createLagoX402, LagoX402ConfigError, type LagoX402, type LagoX402Config } from "../../src/index.js";
import type { LagoX402ErrorWhere } from "../../src/index.js";
import { evmAgent } from "../support/agent.js";
import { startFakeLago, type FakeAnswer, type FakeLago, type RecordedRequest } from "../support/fake-lago.js";
import { gateCheckChallenge, gateCheckPass } from "../support/fixtures.js";
import {
  CATCH_ALL_BODY,
  EXPRESS,
  HANDLER_BODY,
  PATH,
  ROUTE,
  serve,
  startApp,
  type App,
} from "../support/frameworks.js";

const apiKey = "test-key-" + randomUUID();
const PAYER = "0x00000000000000000000000000000000000b0b01";
/** A decodable SIGN-IN-WITH-X header: the gate forwards it, the fake Lago passes it. */
const SIGN_IN = Buffer.from(JSON.stringify({ address: PAYER })).toString("base64");
const SUBSCRIPTION = "sub_" + randomUUID();

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

interface RawReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function parseReply(data: string): RawReply {
  const end = data.indexOf("\r\n\r\n");
  const [statusLine, ...lines] = data.slice(0, end).split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  let body = data.slice(end + 4);
  if (headers["transfer-encoding"] === "chunked") {
    let out = "";
    for (let at = 0; ;) {
      const lineEnd = body.indexOf("\r\n", at);
      const size = parseInt(body.slice(at, lineEnd), 16);
      if (!size) break;
      out += body.slice(lineEnd + 2, lineEnd + 2 + size);
      at = lineEnd + 2 + size + 2;
    }
    body = out;
  }
  return { status: Number(statusLine.split(" ")[1]), headers, body };
}

/** Sends `request` verbatim over a raw socket: no client normalises the target. */
function rawExchange(port: number, request: string): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("error", reject);
    socket.on("end", () => resolve(parseReply(data)));
    socket.write(request);
  });
}

describe.each(["express", "express4"] as const)("%s", (fw) => {
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
    warn.mockRestore();
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

  /** An app whose routes `mount` attaches, with an instance on the app's origin. */
  async function bespoke(mount: (app: Express, x402: LagoX402) => void) {
    let x402!: LagoX402;
    const app = await serve(async (origin) => {
      x402 = await instance(origin);
      const express = EXPRESS[fw]();
      mount(express, x402);
      return express;
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

  /** The standard app (`frameworks.ts`) on an instance with the app's origin. */
  async function standard(): Promise<App> {
    const app = await startApp(fw, (origin) => instance(origin), { usage: 1 });
    cleanups.push(app.close);
    lago.requests.length = 0;
    return app;
  }

  describe("attaching", () => {
    it("an unknown route name throws LagoX402ConfigError at attach time", async () => {
      const x402 = await instance("http://127.0.0.1:3000");
      expect(() => lagoX402(x402, "nope")).toThrow(LagoX402ConfigError);
      expect(() => lagoX402(x402, "nope")).toThrow(expect.objectContaining({ route: "nope" }));
    });

    it("a name that could never be a route stays out of the error", async () => {
      const x402 = await instance("http://127.0.0.1:3000");
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
      const x402 = await instance("http://127.0.0.1:3000");
      lago.requests.length = 0;
      expect(typeof lagoX402(x402, ROUTE)).toBe("function");
      expect(lago.requests).toHaveLength(0);
    });
  });

  describe("given a promise", () => {
    it("each request waits for it, then is gated and served", async () => {
      lago.on("gate_checks", passOnSignIn);
      const pending = deferred<LagoX402>();
      const app = await startApp(fw, pending.promise, { usage: 2 });
      cleanups.push(app.close);

      const challenged = fetch(app.url + PATH, { method: "POST" });
      const signedIn = fetch(app.url + PATH, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });
      const x402 = await instance(app.url);
      pending.resolve(x402);

      const res = await challenged;
      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).resource.url).toBe(
        app.url + PATH,
      );
      expect((await signedIn).status).toBe(200);
      await app.close();
      await x402.close({ timeoutMs: 10_000 });
      expect(events()).toHaveLength(1);
      expect(events()[0].external_subscription_id).toBe(SUBSCRIPTION);
    });

    it("a rejected promise answers 503 unavailable, never serves, and reports nothing", async () => {
      const rejected = Promise.reject(new LagoX402ConfigError(ROUTE, "refused by Lago"));
      rejected.catch(() => {}); // the app's own await of createLagoX402 surfaces it
      const app = await startApp(fw, rejected, { usage: 1 });
      cleanups.push(app.close);

      const res = await fetch(app.url + PATH, { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(lago.requests).toHaveLength(0);
      expect(warn).not.toHaveBeenCalled();
    });

    it("a promise of an instance without that route answers 503 and reports gate.check", async () => {
      // A resolved instance is checked at attach time; a promised one can only be checked per request.
      const app = await startApp(fw, instance("http://127.0.0.1:3000", "other"), { usage: 1 });
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
    // [target, what Express dispatches it to]: the gate, or the catch-all; never the handler.
    // Every target is sent with both methods the route is mounted for.
    const TARGETS: [string, "gate" | "catch-all", string?][] = [
      ["/paid%2Fx", "catch-all"],
      ["/paid/%0A", "catch-all"],
      ["/paid%", "catch-all"],
      ["/paid%c0", "catch-all"],
      ["/paid%E2%80%A8", "catch-all"],
      ["/paid/", "gate", "/paid/"],
      ["/PAID", "gate", "/PAID"],
      ["/paid?next=http://attacker.example", "gate", "/paid"],
      ["http://attacker.example/paid", "gate", "/paid"],
      ["//attacker.example/paid", "catch-all"],
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

  describe("billing when the client goes away", () => {
    function streamingApp(started: { resolve: (v: void) => void }, writeFirst: boolean) {
      return bespoke((app, x402) => {
        app.post("/stream", lagoX402(x402, ROUTE), (_req: Request, res: Response) => {
          res.locals.lagoUsage = 5;
          if (writeFirst) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.write("partial");
          }
          started.resolve();
          res.on("close", () => {
            try {
              res.end("late");
            } catch {
              // Writing after the client left is the handler's own business.
            }
          });
        });
      });
    }

    it("a client that aborts after the headers were sent is billed exactly once", async () => {
      lago.on("gate_checks", passOnSignIn);
      const started = deferred<void>();
      const { app, settle } = await streamingApp(started, true);

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

    it("a client that aborts before any header was sent is not billed", async () => {
      lago.on("gate_checks", passOnSignIn);
      const started = deferred<void>();
      const { app, settle } = await streamingApp(started, false);

      const socket = connect(app.port, "127.0.0.1");
      socket.on("error", () => {});
      socket.write(
        `POST /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nSIGN-IN-WITH-X: ${SIGN_IN}\r\nContent-Length: 0\r\n\r\n`,
      );
      await started.promise;
      socket.destroy();

      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });
  });

  describe("Cache-Control, however the handler writes its headers", () => {
    interface Writer {
      name: string;
      write: (res: Response) => void;
      cacheControl: string;
      /** Other headers the handler wrote, which must arrive untouched. */
      extra?: string;
      statusText?: string;
    }
    const WRITERS: Writer[] = [
      {
        name: "res.writeHead(status, headers)",
        write: (res) =>
          res.writeHead(200, { "Cache-Control": "public, max-age=60", "X-Extra": "1" }).end("ok"),
        cacheControl: "public, max-age=60, private",
        extra: "1",
      },
      {
        name: "res.writeHead(status, reason, headers)",
        write: (res) => res.writeHead(200, "Fine", { "cache-control": "public, max-age=60" }).end("ok"),
        cacheControl: "public, max-age=60, private",
        statusText: "Fine",
      },
      {
        name: "res.writeHead(status, [flat raw headers])",
        write: (res) => res.writeHead(200, ["Cache-Control", "public, max-age=60", "X-Extra", "1"]).end("ok"),
        cacheControl: "public, max-age=60, private",
        extra: "1",
      },
      {
        name: "res.writeHead(status)",
        write: (res) => res.writeHead(200).end("ok"),
        cacheControl: "private",
      },
      {
        name: "res.set + res.send (implicit header)",
        write: (res) => void res.set("Cache-Control", "public, max-age=60").send("ok"),
        cacheControl: "public, max-age=60, private",
      },
      {
        name: "an array value",
        write: (res) => {
          res.setHeader("Cache-Control", ["public", "max-age=60"]);
          res.end("ok");
        },
        cacheControl: "public, max-age=60, private",
      },
      {
        name: "removed by the handler",
        write: (res) => {
          res.removeHeader("Cache-Control");
          res.end("ok");
        },
        cacheControl: "private",
      },
      {
        name: "flushHeaders",
        write: (res) => {
          res.setHeader("Cache-Control", "public, max-age=60");
          res.flushHeaders();
          res.end("ok");
        },
        cacheControl: "public, max-age=60, private",
      },
      {
        name: "already private",
        write: (res) => res.writeHead(200, { "Cache-Control": "PRIVATE, max-age=5" }).end("ok"),
        cacheControl: "PRIVATE, max-age=5",
      },
    ];

    it.each(WRITERS)("$name", async ({ write, cacheControl, extra, statusText }) => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await bespoke((express, x402) => {
        express.post("/write", lagoX402(x402, ROUTE), (_req: Request, res: Response) => {
          res.locals.lagoUsage = 1;
          write(res);
        });
      });

      const res = await fetch(app.url + "/write", { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(res.headers.get("cache-control")).toBe(cacheControl);
      if (extra !== undefined) expect(res.headers.get("x-extra")).toBe(extra);
      if (statusText !== undefined) expect(res.statusText).toBe(statusText);
      expect(await settle()).toHaveLength(1);
    });

    it("a paid response keeps PAYMENT-RESPONSE when the handler writes its own headers", async () => {
      const { app, settle } = await bespoke((express, x402) => {
        express.post("/write", lagoX402(x402, ROUTE), (_req: Request, res: Response) => {
          res.locals.lagoUsage = 1;
          res.writeHead(200, { "Cache-Control": "public, max-age=60", "Content-Type": "text/plain" });
          res.end("ok");
        });
      });
      const url = app.url + "/write";
      const agent = evmAgent({ signIn: false, maxAmountPerPayment: "$10" });
      const challenge = await fetch(url, { method: "POST" });
      const payment = await agent.client.createPaymentPayload(
        agent.http.getPaymentRequiredResponse((name) => challenge.headers.get(name)),
      );

      const res = await fetch(url, {
        method: "POST",
        headers: agent.http.encodePaymentSignatureHeader(payment),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60, private");
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
      expect(await settle()).toHaveLength(1);
    });
  });

  describe("never throws into Express", () => {
    it("an unexpected throw inside the adapter answers 503 unavailable and never serves", async () => {
      let served = false;
      const { app } = await bespoke((express, x402) => {
        express.post(
          "/boom",
          (req: Request, _res: Response, next: NextFunction) => {
            Object.defineProperty(req, "originalUrl", {
              get() {
                throw new Error("boom");
              },
            });
            next();
          },
          lagoX402(x402, ROUTE),
          (_req: Request, res: Response) => {
            served = true;
            res.json(HANDLER_BODY);
          },
        );
      });

      const res = await fetch(app.url + "/boom", { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toStrictEqual({ error: "unavailable" });
      expect(served).toBe(false);
    });

    it("an outcome that arrives after someone else answered never reaches the handler", async () => {
      lago.on("gate_checks", passOnSignIn);
      let served = false;
      const attempted = deferred<void>();
      const { app, settle } = await bespoke((express, x402) => {
        express.post(
          "/early",
          (_req: Request, res: Response, next: NextFunction) => {
            res.status(504).json({ error: "gateway_timeout" });
            const setHeader = res.setHeader.bind(res);
            res.setHeader = ((name: string, value: string | number | readonly string[]) => {
              attempted.resolve();
              return setHeader(name, value);
            }) as typeof res.setHeader;
            next();
          },
          lagoX402(x402, ROUTE),
          (_req: Request, res: Response) => {
            served = true;
            res.locals.lagoUsage = 1;
            res.json(HANDLER_BODY);
          },
        );
      });

      const res = await fetch(app.url + "/early", { method: "POST", headers: { "SIGN-IN-WITH-X": SIGN_IN } });
      expect(res.status).toBe(504);
      await attempted.promise;

      expect(served).toBe(false);
      expect(await settle()).toStrictEqual([]);
    });

    it("a handler that throws is answered 500 by Express and billed nothing", async () => {
      lago.on("gate_checks", passOnSignIn);
      const { app, settle } = await bespoke((express, x402) => {
        express.post("/throws", lagoX402(x402, ROUTE), (_req: Request, res: Response) => {
          res.locals.lagoUsage = 1;
          throw new Error("handler bug");
        });
      });

      const res = await fetch(app.url + "/throws", {
        method: "POST",
        headers: { "SIGN-IN-WITH-X": SIGN_IN },
      });

      expect(res.status).toBe(500);
      expect(await settle()).toStrictEqual([]);
      expect(reports).toStrictEqual([]);
    });

    it.skipIf(fw === "express4")(
      "an async handler that rejects is answered 500 and billed nothing",
      async () => {
        lago.on("gate_checks", passOnSignIn);
        const { app, settle } = await bespoke((express, x402) => {
          express.post("/rejects", lagoX402(x402, ROUTE), async (_req: Request, res: Response) => {
            res.locals.lagoUsage = 1;
            await Promise.resolve();
            throw new Error("handler bug");
          });
        });

        const res = await fetch(app.url + "/rejects", {
          method: "POST",
          headers: { "SIGN-IN-WITH-X": SIGN_IN },
        });

        expect(res.status).toBe(500);
        expect(await settle()).toStrictEqual([]);
      },
    );
  });

  describe("request translation", () => {
    it("a router mounted under a prefix gates the full original URL", async () => {
      const { app } = await bespoke((express, x402) => {
        const router = EXPRESS[fw].Router();
        router.post(
          PATH,
          lagoX402(x402, ROUTE),
          (_req: Request, res: Response) => void res.json(HANDLER_BODY),
        );
        express.use("/api", router);
      });

      const res = await fetch(app.url + "/api/paid?x=1", { method: "POST" });

      expect(res.status).toBe(402);
      expect(decodePaymentRequiredHeader(res.headers.get("payment-required")!).resource.url).toBe(
        app.url + "/api/paid",
      );
    });
  });
});
