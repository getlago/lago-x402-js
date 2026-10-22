/** One app per supported framework on 127.0.0.1, for the behaviour suite and the adapter
 * suites. Each mounts the gated handler on `POST /paid` and `GET /paid` (route name `paid`) and
 * answers every other path with a catch-all 200 whose body differs from the handler's, so "the
 * gate was skipped" is told apart from a 404 and from a served call.
 *
 * Adding a framework = a name in `FRAMEWORKS` and a branch in `listenerFor`. Next runs through
 * `nextListener`, a `node:http` bridge that serves a wrapped route handler the way `next start`
 * does; a test file that starts one mocks `next/server.js` with `nextServer` (`vi.mock`), whose
 * `after` queues the request's tasks for the bridge to run once the response has gone out. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import express5 from "express";
import express4 from "express4";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { vi } from "vitest";
import { lagoX402 } from "../../src/express.js";
import { lagoX402 as honoLagoX402, type LagoX402Variables } from "../../src/hono.js";
import type { LagoX402Result } from "../../src/next.js";
import type { LagoX402 } from "../../src/x402.js";

export const FRAMEWORKS = ["express", "express4", "hono", "next"] as const;
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
  /** The usage it reports (`res.locals.lagoUsage` on Express, `c.set("lagoUsage", n)` on Hono,
   * `{ response, usage }` on Next); not reported when undefined (Next: a bare `Response`). */
  usage?: unknown;
  /** Reading the reported usage throws (a throwing getter) instead of giving `usage`. */
  throws?: boolean;
  /** The app trusts `X-Forwarded-*` headers (Express's `trust proxy`; Hono has no such setting
   * and always builds `c.req.url` from `Host`; Next has none either and builds `req.url` from
   * its own host and port). */
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

/** Where `after()` queues its tasks: the tasks of the request a route handler runs for. */
const afterTasks = new AsyncLocalStorage<unknown[]>();

/** What tests mock `next/server.js` with, from a factory that imports this module dynamically
 * (`vi.mock("next/server.js", async () => (await import("…/frameworks.js")).nextServer)`); this
 * module imports `src/next.ts` only lazily, so the two never wait on each other.
 * `after` behaves as Next's does on a Node server: it queues the task (a function or a promise)
 * for the request in scope, which `nextListener` runs once the response has gone out, and throws
 * outside of one. */
export const nextServer = {
  after: vi.fn((task: unknown): void => {
    const tasks = afterTasks.getStore();
    if (tasks === undefined) throw new Error("`after` was called outside a request scope.");
    tasks.push(task);
  }),
};

/** Runs `fn` as a request scope for `after()`; the tasks it queued are returned, not run. */
export async function inRequestScope<T>(fn: () => Promise<T>): Promise<{ result: T; tasks: unknown[] }> {
  const tasks: unknown[] = [];
  const result = await afterTasks.run(tasks, fn);
  return { result, tasks };
}

/** Runs queued `after()` tasks as Next does, none of them able to break another. */
export function runAfterTasks(tasks: unknown[]): Promise<unknown[]> {
  return Promise.all(
    tasks.splice(0).map(async (task) => {
      try {
        return await (typeof task === "function" ? task() : task);
      } catch {
        return undefined;
      }
    }),
  );
}

/** The context Next passes a route handler as its second argument. */
export type NextContext = { params: Promise<Record<string, string | string[]>> };
export type RouteHandler = (req: Request, ctx: NextContext) => Promise<Response>;

/** Serves App Router route handlers (`/paid`, POST and GET) the way `next start` does on Node:
 * the `Request` URL is built from the server's own origin, never from `Host` (Next ignores it
 * unless `trustHostHeader` is set), its protocol from `X-Forwarded-Proto`; a method the route
 * does not export answers 405, any other path the catch-all, a throwing handler 500 (as Next
 * renders it). The response is written as returned, and the `after()` tasks the request queued
 * run once it has closed (finished, or its client went away). */
export function nextListener(origin: string, route: Partial<Record<"POST" | "GET", RouteHandler>>): Listener {
  return (req, res) => {
    const tasks: unknown[] = [];
    res.once("close", () => void runAfterTasks(tasks));
    void (async () => {
      let response: Response;
      try {
        const request = await nextRequest(origin, req);
        const handler = route[request.method as "POST" | "GET"];
        if (new URL(request.url).pathname !== PATH) {
          response = new Response(CATCH_ALL_BODY, { status: 200, headers: { "Content-Type": "text/plain" } });
        } else if (handler === undefined) {
          response = new Response(null, { status: 405 });
        } else {
          const ctx: NextContext = { params: Promise.resolve({}) };
          response = await afterTasks.run(tasks, () => handler(request, ctx));
        }
      } catch {
        response = new Response("Internal Server Error", { status: 500 });
      }
      await writeResponse(res, response);
    })();
  };
}

async function nextRequest(origin: string, req: IncomingMessage): Promise<Request> {
  const base = new URL(origin);
  if (String(req.headers["x-forwarded-proto"] ?? "").includes("https")) base.protocol = "https:";
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
  return new Request(new URL(req.url ?? "/", base), { method, headers, body });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  try {
    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") res.setHeader(name, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader("Set-Cookie", cookies);
    res.end(response.body === null ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch {
    res.destroy();
  }
}

/** The standard app on Next: the gated handler answers `HANDLER_BODY`, with `{ response, usage }`
 * when it reports usage and a bare `Response` when it does not. */
async function nextAppListener(origin: string, x402: LagoX402 | PromiseLike<LagoX402>, h: Handler) {
  // Imported here, once `next/server.js` is mocked, so the mock's factory can import this module.
  const { withLagoX402 } = await import("../../src/next.js");
  const handler = withLagoX402(x402, ROUTE, async (): Promise<Response | LagoX402Result> => {
    const headers = h.cacheControl === undefined ? undefined : { "Cache-Control": h.cacheControl };
    const response = Response.json(HANDLER_BODY, { status: h.status ?? 200, headers });
    if (h.throws) {
      return {
        response,
        get usage(): number {
          throw new Error(USAGE_GETTER_MESSAGE);
        },
      };
    }
    return h.usage === undefined ? response : { response, usage: h.usage as number };
  });
  return nextListener(origin, { POST: handler, GET: handler });
}

async function listenerFor(
  fw: Framework,
  origin: string,
  x402: LagoX402 | PromiseLike<LagoX402>,
  h: Handler,
): Promise<Listener> {
  switch (fw) {
    case "express":
    case "express4":
      return expressListener(fw, x402, h);
    case "hono":
      return honoListener(x402, h);
    case "next":
      return nextAppListener(origin, x402, h);
  }
}

/** Starts `fw` on 127.0.0.1 with the gate in front of the `paid` route. */
export function startApp(fw: Framework, x402: X402Source, h: Handler = {}): Promise<App> {
  return serve(async (origin) =>
    listenerFor(fw, origin, typeof x402 === "function" ? await x402(origin) : x402, h),
  );
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
