/** What every framework adapter shares, so the attach-time route check, the promise form,
 * fail-closed decisions, billing that never breaks a response, and the `private` merge cannot
 * drift between them. Internal: neither the package entry point nor any subpath exports it. */
import { withPrivateCacheControl } from "@x402/core/http";
import { ROUTE_NAME } from "./config.js";
import { LagoX402ConfigError } from "./errors.js";
import { unavailable, type CallBilling, type GateOutcome, type GateRequest } from "./gate.js";
import { handleRequest, hasRoute, type LagoX402 } from "./x402.js";

/** What an adapter is attached with: an instance, or the promise `createLagoX402` returns. */
export type X402Source = LagoX402 | PromiseLike<LagoX402>;
export type Respond = Extract<GateOutcome, { action: "respond" }>;
export type Serve = Extract<GateOutcome, { action: "serve" }>;

/** Statuses whose response has no body; a rebuilt one keeps it that way. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function isPromiseLike(value: unknown): value is PromiseLike<LagoX402> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Given an instance, an unknown route name throws `LagoX402ConfigError` now, so a typo fails at
 * startup rather than on every request; given a promise, each request checks it instead (there
 * is no instance to check against yet). `attacher` names the adapter's function in the
 * message for a name that could never be a route (it fails the config's pattern, so it stays
 * out of the message). */
export function checkRoute(x402: X402Source, route: string, attacher: string): void {
  if (!isPromiseLike(x402) && !hasRoute(x402, route)) {
    throw typeof route === "string" && ROUTE_NAME.test(route)
      ? new LagoX402ConfigError(route, "not configured")
      : new LagoX402ConfigError(null, `${attacher} was given a route name that is not configured`);
  }
}

/** The instance, or `null` when the promise rejected. */
async function instanceOf(x402: X402Source): Promise<LagoX402 | null> {
  if (!isPromiseLike(x402)) return x402;
  try {
    return await x402;
  } catch {
    return null;
  }
}

/** The gate's outcome for one request; `request` is translated only once an instance is in
 * hand. Never rejects: anything unexpected is 503 `unavailable`, and so is a rejected promise,
 * with no report (there is no instance to report through; `createLagoX402` reported a boot
 * refusal itself, and the app's own await of it surfaces the error). */
export async function decide(
  x402: X402Source,
  route: string,
  request: () => GateRequest,
): Promise<GateOutcome> {
  try {
    const instance = await instanceOf(x402);
    if (instance === null) return unavailable();
    return await handleRequest(instance, route, request());
  } catch {
    return unavailable();
  }
}

/** Bills one served call with the status that went out. Never throws or rejects, so a caller
 * that does not await it cannot break a response; `finish` is idempotent, so a second call is
 * harmless. */
export function bill(billing: CallBilling, status: () => number, readUsage: () => unknown): Promise<void> {
  try {
    return billing.finish(status(), readUsage).catch(() => undefined);
  } catch {
    // Metering never breaks a response.
    return Promise.resolve();
  }
}

/** `private` merged into a `Cache-Control` value however a framework holds it, never
 * overwriting the handler's directives: a shared cache must never replay a gated response, and
 * the handler's own caching rules still hold. */
export function privateCacheControl(current: string | number | readonly string[] | null | undefined): string {
  const value =
    current === undefined || current === null
      ? null
      : Array.isArray(current)
        ? current.join(", ")
        : String(current);
  return withPrivateCacheControl(value);
}

/** The gate's answer as a fetch `Response`. */
export function responseOf(outcome: Respond): Response {
  return new Response(outcome.body, { status: outcome.status, headers: outcome.headers });
}

/** `response` with the serve headers added and `private` merged into its final `Cache-Control`.
 * A response with immutable headers (`fetch()`) is rebuilt first, keeping a 204/205/304 without
 * a body; the result is `response` itself whenever it could be changed in place. Throws when it
 * cannot be rebuilt (no HTTP status, as `Response.error()`). */
export function withServeHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    applyServeHeaders(response.headers, headers);
    return response;
  } catch {
    // `Response` would turn a status outside 200–599 into an error, or (`@hono/node-server`'s
    // lightweight one) into a 200.
    if (!(response.status >= 200 && response.status <= 599)) {
      throw new Error("lago-x402: response has no HTTP status");
    }
    const rebuilt = new Response(NULL_BODY_STATUSES.has(response.status) ? null : response.body, response);
    applyServeHeaders(rebuilt.headers, headers);
    return rebuilt;
  }
}

/** Throws (before changing anything) when `target` is immutable. */
function applyServeHeaders(target: Headers, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    // The serve outcome's own `Cache-Control` is the merge's result when the handler set none.
    if (name.toLowerCase() !== "cache-control") target.set(name, value);
  }
  target.set("Cache-Control", privateCacheControl(target.get("Cache-Control")));
}
