/** `lago-x402/hono`: the gate as Hono middleware, attached per route through Hono's own router,
 * so the gate never decides on a path of its own:
 *
 *   const app = new Hono<{ Variables: LagoX402Variables }>();
 *   app.post("/v1/generate", lagoX402(x402, "generate"), (c) => {
 *     c.set("lagoUsage", n);
 *     return c.json(result);
 *   });
 *
 * Supported on Node, served by `@hono/node-server`: the call is billed once the Node response
 * has gone out (`finish`, or `close` once the headers were sent), with the status that went
 * out. Without Node bindings in `c.env` (`app.request()` in tests, other runtimes) it is billed
 * as soon as the middleware has the final `c.res`, a fallback that cannot see a client going
 * away or a later middleware changing the status.
 *
 * Served responses get `private` merged into whatever `Cache-Control` the handler sends. The
 * gate's own answers are `Response`s and never reach the handler. Nothing here throws into Hono:
 * an unexpected failure answers 503 `unavailable` and never serves. Only Hono's types are
 * imported; the package never loads `hono` at runtime. */
import type { Context, MiddlewareHandler, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  bill,
  checkRoute,
  decide,
  responseOf,
  withServeHeaders,
  type Respond,
  type Serve,
} from "./adapter.js";
import { unavailable, type CallBilling, type GateRequest } from "./gate.js";
import type { LagoX402 } from "./x402.js";

/** The variable the handler reports usage through: `c.set("lagoUsage", n)`. */
export type LagoX402Variables = { lagoUsage: number };

type Env = { Variables: LagoX402Variables };

/** The part of a Node `ServerResponse` (or `Http2ServerResponse`) billing needs. */
interface NodeOutgoing {
  readonly headersSent: boolean;
  readonly statusCode: number;
  on(event: "finish" | "close", listener: () => void): unknown;
}

/** The gate for the configured route `route`. Given an instance, an unknown route name throws
 * `LagoX402ConfigError` now; given a promise, each request awaits it, and a rejected promise
 * answers 503 `unavailable` (the app's own `await createLagoX402` surfaces the error). */
export function lagoX402(
  x402: LagoX402 | PromiseLike<LagoX402>,
  route: string,
): MiddlewareHandler<{ Variables: LagoX402Variables }> {
  checkRoute(x402, route, "lagoX402");
  return async (c, next) => {
    const outcome = await decide(x402, route, () => gateRequest(c));
    if (outcome.action === "respond") return respond(c, outcome);
    await serve(c, next, outcome);
  };
}

/** The request as received: `c.req.url` (the gate keeps only its pathname, never its host),
 * headers through `c.req.header`, strings only. */
function gateRequest(c: Context<Env>): GateRequest {
  return {
    method: c.req.method,
    target: c.req.url,
    header(name) {
      const value = c.req.header(name);
      return typeof value === "string" ? value : undefined;
    },
  };
}

/** The gate's answer, through Hono so headers an earlier middleware set (CORS, …) are kept,
 * but the gate's own win: assigning `c.res` lays the headers already on it over the new one. */
function respond(c: Context<Env>, outcome: Respond): Response {
  try {
    c.res = c.body(outcome.body, {
      status: outcome.status as ContentfulStatusCode,
      headers: outcome.headers,
    });
    for (const [name, value] of Object.entries(outcome.headers)) c.res.headers.set(name, value);
  } catch {
    replace(c, responseOf(outcome));
  }
  return c.res;
}

/** Makes `response` the answer as is: clearing `c.res` first stops Hono merging the old one's
 * headers into it. */
function replace(c: Context<Env>, response: Response): void {
  c.res = undefined;
  c.res = response;
}

/** Runs the handler, then makes its response private and adds the serve headers. Billing is
 * bound to the Node response before the handler runs, so a client that leaves first is seen;
 * without Node bindings it runs once the response is final. A rejection from `next()` (a
 * non-Error thrown by the handler) is Hono's to answer, as it would be without the gate. */
async function serve(c: Context<Env>, next: Next, outcome: Serve): Promise<void> {
  const readUsage = (): unknown => c.get("lagoUsage");
  const outgoing = nodeOutgoing(c);
  if (outgoing !== null) billWhenSent(outgoing, outcome.billing, readUsage);
  await next();
  // An unfinalized context is answered 500 by Hono itself: nothing was served.
  if (!c.finalized) return;
  try {
    keepPrivate(c, outcome.headers);
  } catch {
    // A served response never goes out without `private`: fail closed instead.
    const fallback = unavailable();
    if (fallback.action === "respond") replace(c, responseOf(fallback));
    return;
  }
  if (outgoing === null) void bill(outcome.billing, () => c.res.status, readUsage);
}

/** `c.env.outgoing` when `@hono/node-server` serves the request (its `HttpBindings`). */
function nodeOutgoing(c: Context<Env>): NodeOutgoing | null {
  try {
    const env: unknown = c.env;
    if (typeof env !== "object" || env === null) return null;
    const outgoing: unknown = (env as { outgoing?: unknown }).outgoing;
    if (
      typeof outgoing === "object" &&
      outgoing !== null &&
      typeof (outgoing as NodeOutgoing).on === "function" &&
      typeof (outgoing as NodeOutgoing).headersSent === "boolean"
    ) {
      return outgoing as NodeOutgoing;
    }
  } catch {
    // A throwing `env` getter: bill without Node bindings.
  }
  return null;
}

/** On `finish`, or on `close` when the headers were sent before the client went away, with the
 * status that actually went out. */
function billWhenSent(outgoing: NodeOutgoing, billing: CallBilling, readUsage: () => unknown): void {
  const billNow = (): void => void bill(billing, () => outgoing.statusCode, readUsage);
  outgoing.on("finish", billNow);
  outgoing.on("close", () => {
    if (outgoing.headersSent) billNow();
  });
}

/** Adds the serve headers to `c.res` and merges `private` into its final `Cache-Control`
 * (`withServeHeaders`), replacing `c.res` when it had immutable headers and was rebuilt. Throws
 * when the response cannot be rebuilt (no HTTP status, as `Response.error()`). */
function keepPrivate(c: Context<Env>, headers: Record<string, string>): void {
  const res = c.res;
  const served = withServeHeaders(res, headers);
  if (served !== res) replace(c, served);
}
