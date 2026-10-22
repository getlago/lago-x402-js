/** One app per supported framework on 127.0.0.1, for the behaviour suite and the adapter
 * suites. Each mounts the gated handler on `POST /paid` and `GET /paid` (route name `paid`) and
 * answers every other path with a catch-all 200 whose body differs from the handler's, so "the
 * gate was skipped" is told apart from a 404 and from a served call.
 *
 * Adding a framework (Next) = a name in `FRAMEWORKS` and a branch in `listenerFor`. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import express5 from "express";
import express4 from "express4";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { lagoX402 } from "../../src/express.js";
import { lagoX402 as honoLagoX402, type LagoX402Variables } from "../../src/hono.js";
import type { LagoX402 } from "../../src/x402.js";

export const FRAMEWORKS = ["express", "express4", "hono"] as const;
export type Framework = (typeof FRAMEWORKS)[number];
export const EXPRESS = { express: express5, express4 } as const;

/** The route name every app attaches the gate with. */
export const ROUTE = "paid";
export const PATH = "/paid";
/** What the gated handler answers (JSON) and what the catch-all answers (text). */
export const HANDLER_BODY = { served: true };
export const CATCH_ALL_BODY = "catch-all";
/** The message of the error a throwing usage getter raises: it must never reach a report. */
export const USAGE_GETTER_MESSAGE = "usage getter failed: customer secret";

/** What the gated handler does. */
export interface Handler {
  /** Its status (default 200). */
  status?: number;
  /** The usage it reports (`res.locals.lagoUsage` on Express, `c.set("lagoUsage", n)` on Hono);
   * not reported when undefined. */
  usage?: unknown;
  /** Reading the reported usage throws (a throwing getter) instead of giving `usage`. */
  throws?: boolean;
  /** The app trusts `X-Forwarded-*` headers (Express's `trust proxy`; Hono has no such setting
   * and always builds `c.req.url` from `Host`). */
  trustProxy?: boolean;
  /** A `Cache-Control` the handler sets itself. */
  cacheControl?: string;
}

/** The instance the gate is attached with: a resolved instance, a promise of one (each request
 * awaits it), or a factory called with the app's origin before routes are attached, so the
 * instance's `origin` can equal the app's (the sign-in client signs only for its own origin). */
export type X402Source = LagoX402 | PromiseLike<LagoX402> | ((origin: string) => Promise<LagoX402>);

export interface App {
  /** `http://127.0.0.1:<port>`, also the origin. */
  url: string;
  port: number;
  /** Idempotent. Resolves once the server is closed and every response has emitted `close`,
   * so whatever the adapter does on `finish` or `close` (billing) has run by then. */
  close(): Promise<void>;
}

export type Listener = (req: IncomingMessage, res: ServerResponse) => void;

/** Listens on 127.0.0.1 first, then builds the request listener with the origin it got. */
export async function serve(build: (origin: string) => Listener | Promise<Listener>): Promise<App> {
  let listener: Listener = (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  // A response emits `close` once it finished or its client went away. For an aborted client
  // that comes from the socket's close callback, after the server may already report itself
  // closed, so `close()` also waits for every response. This listener runs before the app's,
  // so it defers its count by one macrotask: the app's `close` listeners have run by then.
  let open = 0;
  const onIdle: (() => void)[] = [];
  const server: Server = createServer((req, res) => {
    open++;
    res.once("close", () => {
      setImmediate(() => {
        if (--open === 0) for (const resolve of onIdle.splice(0)) resolve();
      });
    });
    listener(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      if (open > 0) await new Promise<void>((resolve) => onIdle.push(resolve));
    })());

  try {
    listener = await build(url);
  } catch (err) {
    await close();
    throw err;
  }
  return { url, port, close };
}

function expressListener(fw: "express" | "express4", x402: LagoX402 | PromiseLike<LagoX402>, h: Handler) {
  const app = EXPRESS[fw]();
  if (h.trustProxy) app.set("trust proxy", true);
  const gate = lagoX402(x402, ROUTE);
  const handler = (_req: express5.Request, res: express5.Response): void => {
    if (h.cacheControl !== undefined) res.setHeader("Cache-Control", h.cacheControl);
    if (h.throws) {
      Object.defineProperty(res.locals, "lagoUsage", {
        get() {
          throw new Error(USAGE_GETTER_MESSAGE);
        },
      });
    } else if (h.usage !== undefined) {
      res.locals.lagoUsage = h.usage;
    }
    res.status(h.status ?? 200).json(HANDLER_BODY);
  };
  app.post(PATH, gate, handler);
  app.get(PATH, gate, handler);
  app.use((_req, res) => {
    res.status(200).type("text/plain").send(CATCH_ALL_BODY);
  });
  return app;
}

export type HonoEnv = { Variables: LagoX402Variables };

/** A Hono request listener as `@hono/node-server` serves it (its `serve()` wraps the same
 * listener), so `c.env` carries the Node `incoming`/`outgoing` bindings. */
export function honoNodeListener(app: Hono<HonoEnv>): Listener {
  const listener = getRequestListener(app.fetch);
  return (req, res) => void listener(req, res);
}

/** Everything no route matches answers the catch-all, including paths Hono's `*` wildcard cannot
 * match (a decoded line terminator). */
export function honoApp(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.notFound((c) => c.text(CATCH_ALL_BODY, 200));
  return app;
}

function honoListener(x402: LagoX402 | PromiseLike<LagoX402>, h: Handler): Listener {
  const app = honoApp();
  const gate = honoLagoX402(x402, ROUTE);
  const handler = (c: Context<HonoEnv>) => {
    if (h.cacheControl !== undefined) c.header("Cache-Control", h.cacheControl);
    if (h.throws) {
      // `c.set` stores a plain value; the adapter reads it back through `c.get`.
      const get = c.get;
      c.get = ((key: "lagoUsage") => {
        if (key === "lagoUsage") throw new Error(USAGE_GETTER_MESSAGE);
        return get(key);
      }) as typeof c.get;
    } else if (h.usage !== undefined) {
      c.set("lagoUsage", h.usage as number);
    }
    return c.json(HANDLER_BODY, (h.status ?? 200) as ContentfulStatusCode);
  };
  app.post(PATH, gate, handler);
  app.get(PATH, gate, handler);
  return honoNodeListener(app);
}

function listenerFor(fw: Framework, x402: LagoX402 | PromiseLike<LagoX402>, h: Handler): Listener {
  switch (fw) {
    case "express":
    case "express4":
      return expressListener(fw, x402, h);
    case "hono":
      return honoListener(x402, h);
  }
}

/** Starts `fw` on 127.0.0.1 with the gate in front of the `paid` route. */
export function startApp(fw: Framework, x402: X402Source, h: Handler = {}): Promise<App> {
  return serve(async (origin) => listenerFor(fw, typeof x402 === "function" ? await x402(origin) : x402, h));
}

export interface RawReply {
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
export function rawExchange(port: number, request: string): Promise<RawReply> {
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
