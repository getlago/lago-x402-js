/** One app per supported framework on 127.0.0.1, for the behaviour suite and the adapter
 * suites. Each mounts the gated handler on `POST /paid` and `GET /paid` (route name `paid`) and
 * answers every other path with a catch-all 200 whose body differs from the handler's, so "the
 * gate was skipped" is told apart from a 404 and from a served call.
 *
 * Adding a framework (Hono, Next) = a name in `FRAMEWORKS` and a branch in `listenerFor`. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import express5 from "express";
import express4 from "express4";
import { lagoX402 } from "../../src/express.js";
import type { LagoX402 } from "../../src/x402.js";

export const FRAMEWORKS = ["express", "express4"] as const;
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
  /** The usage it reports (`res.locals.lagoUsage` on Express); not reported when undefined. */
  usage?: unknown;
  /** Reporting usage throws (a throwing getter) instead of reporting `usage`. */
  throws?: boolean;
  /** The app trusts `X-Forwarded-*` headers (`trust proxy`). */
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

function listenerFor(fw: Framework, x402: LagoX402 | PromiseLike<LagoX402>, h: Handler): Listener {
  switch (fw) {
    case "express":
    case "express4":
      return expressListener(fw, x402, h);
  }
}

/** Starts `fw` on 127.0.0.1 with the gate in front of the `paid` route. */
export function startApp(fw: Framework, x402: X402Source, h: Handler = {}): Promise<App> {
  return serve(async (origin) => listenerFor(fw, typeof x402 === "function" ? await x402(origin) : x402, h));
}
