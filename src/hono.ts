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
import { withPrivateCacheControl } from "@x402/core/http";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ROUTE_NAME } from "./config.js";
import { LagoX402ConfigError } from "./errors.js";
import { unavailable, type CallBilling, type GateOutcome, type GateRequest } from "./gate.js";
import { handleRequest, hasRoute, type LagoX402 } from "./x402.js";

/** The variable the handler reports usage through: `c.set("lagoUsage", n)`. */
export type LagoX402Variables = { lagoUsage: number };

type Env = { Variables: LagoX402Variables };
type Respond = Extract<GateOutcome, { action: "respond" }>;
type Serve = Extract<GateOutcome, { action: "serve" }>;

/** The part of a Node `ServerResponse` (or `Http2ServerResponse`) billing needs. */
interface NodeOutgoing {
  readonly headersSent: boolean;
  readonly statusCode: number;
  on(event: "finish" | "close", listener: () => void): unknown;
}

/** Statuses whose response has no body; a rebuilt one keeps it that way. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function isPromiseLike(value: unknown): value is PromiseLike<LagoX402> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** The gate for the configured route `route`. Given an instance, an unknown route name throws
 * `LagoX402ConfigError` now; given a promise, each request awaits it, and a rejected promise
 * answers 503 `unavailable` (the app's own `await createLagoX402` surfaces the error). */
export function lagoX402(
  x402: LagoX402 | PromiseLike<LagoX402>,
  route: string,
): MiddlewareHandler<{ Variables: LagoX402Variables }> {
  if (!isPromiseLike(x402) && !hasRoute(x402, route)) {
    // A name that can never be a route (it fails the config's pattern) stays out of the message.
    throw typeof route === "string" && ROUTE_NAME.test(route)
      ? new LagoX402ConfigError(route, "not configured")
      : new LagoX402ConfigError(null, "lagoX402 was given a route name that is not configured");
  }
  return async (c, next) => {
    const outcome = await decide(x402, route, c);
    if (outcome.action === "respond") return respond(c, outcome);
    await serve(c, next, outcome);
  };
}

async function instanceOf(x402: LagoX402 | PromiseLike<LagoX402>): Promise<LagoX402 | null> {
  if (!isPromiseLike(x402)) return x402;
  try {
    return await x402;
  } catch {
    return null;
  }
}

/** Never rejects: anything unexpected is 503 `unavailable`. */
async function decide(
  x402: LagoX402 | PromiseLike<LagoX402>,
  route: string,
  c: Context<Env>,
): Promise<GateOutcome> {
  try {
    const instance = await instanceOf(x402);
    // No instance to report through: the app's own await of createLagoX402 surfaces the error.
    if (instance === null) return unavailable();
    return await handleRequest(instance, route, gateRequest(c));
  } catch {
    return unavailable();
  }
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
    replace(c, plain(outcome));
  }
  return c.res;
}

function plain(outcome: Respond): Response {
  return new Response(outcome.body, { status: outcome.status, headers: outcome.headers });
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
    if (fallback.action === "respond") replace(c, plain(fallback));
    return;
  }
  if (outgoing === null) bill(outcome.billing, c.res.status, readUsage);
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

/** Never awaited, never throws or rejects into the response. `finish` is idempotent. */
function bill(billing: CallBilling, status: number, readUsage: () => unknown): void {
  try {
    billing.finish(status, readUsage).catch(() => undefined);
  } catch {
    // Metering never breaks a response.
  }
}

/** On `finish`, or on `close` when the headers were sent before the client went away, with the
 * status that actually went out. */
function billWhenSent(outgoing: NodeOutgoing, billing: CallBilling, readUsage: () => unknown): void {
  outgoing.on("finish", () => bill(billing, outgoing.statusCode, readUsage));
  outgoing.on("close", () => {
    if (outgoing.headersSent) bill(billing, outgoing.statusCode, readUsage);
  });
}

/** Adds the serve headers to `c.res` and merges `private` into its final `Cache-Control`, never
 * overwriting the handler's directives (R4, R26). A response with immutable headers (`fetch()`)
 * is rebuilt first. Throws when the response cannot be rebuilt (no HTTP status, as
 * `Response.error()`). */
function keepPrivate(c: Context<Env>, headers: Record<string, string>): void {
  try {
    applyServeHeaders(c.res.headers, headers);
  } catch {
    const res = c.res;
    // `Response` would turn a status outside 200–599 into an error, or (`@hono/node-server`'s
    // lightweight one) into a 200.
    if (!(res.status >= 200 && res.status <= 599)) throw new Error("lago-x402: response has no HTTP status");
    replace(c, new Response(NULL_BODY_STATUSES.has(res.status) ? null : res.body, res));
    applyServeHeaders(c.res.headers, headers);
  }
}

/** Throws (before changing anything) when `target` is immutable. */
function applyServeHeaders(target: Headers, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    // The serve outcome's own `Cache-Control` is the merge's result when the handler set none.
    if (name.toLowerCase() !== "cache-control") target.set(name, value);
  }
  target.set("Cache-Control", withPrivateCacheControl(target.get("Cache-Control")));
}
