/** `lago-x402/next`: the gate as a wrapper around a Next.js App Router route handler (Next 16, Node
 * runtime), so the gate never decides on a path of its own:
 *
 *   const x402 = createLagoX402({ ... }); // module scope: each request awaits it
 *   export const POST = withLagoX402(x402, "generate", async (req) => {
 *     const result = await generate(await req.json());
 *     return { response: Response.json(result), usage: result.tokens };
 *   });
 *
 * The handler reports usage by returning `{ response, usage }`; a bare `Response` reports none, so
 * a served status below 400 is billed the route's `fallbackUsage` and reports `usage.extract`. The
 * call is billed through Next's `after()`: the task runs once the response has gone out, and Next
 * keeps the delivery alive past the request's end (to completion on `next start`; within the
 * function's `maxDuration` on serverless). It cannot see a client going away.
 *
 * Served responses get `PAYMENT-RESPONSE` after a payment and `private` merged into whatever
 * `Cache-Control` the handler sends (a response with immutable headers, as `fetch()` returns, is
 * rebuilt; one that cannot be, as `Response.error()`, is replaced by 503 `unavailable`, or
 * `payment_pending` after a payment). The gate's own answers are `Response`s and never reach the
 * handler. A handler that throws, or returns no response, throws to Next, which answers 500;
 * nothing is billed. Only `after` is imported from `next` (`next/server.js`: `next` has no
 * `exports` map, so plain Node ESM cannot resolve `next/server`). */
import { after } from "next/server.js";
import { bill, checkRoute, decide, responseOf, withServeHeaders, type X402Source } from "./adapter.js";
import type { CallBilling, GateRequest } from "./gate.js";
import type { LagoX402 } from "./x402.js";

/** What a handler returns to report the call's usage. */
export interface LagoX402Result {
  response: Response;
  usage: number;
}

/** `handler` behind the gate for the configured route `route`. Given an instance, an unknown route
 * name throws `LagoX402ConfigError` now; given a promise (the expected use: `createLagoX402` at
 * module scope), each request awaits it, and a rejected promise answers 503 `unavailable` (the
 * app's own `await createLagoX402` surfaces the error). */
export function withLagoX402<Ctx>(
  x402: LagoX402 | PromiseLike<LagoX402>,
  route: string,
  handler: (req: Request, ctx: Ctx) => Promise<Response | LagoX402Result>,
): (req: Request, ctx: Ctx) => Promise<Response> {
  checkRoute(x402, route, "withLagoX402");
  if (typeof handler !== "function") throw new TypeError("withLagoX402: handler must be a function");
  return (req, ctx) => gate(x402, route, handler, req, ctx);
}

async function gate<Ctx>(
  x402: X402Source,
  route: string,
  handler: (req: Request, ctx: Ctx) => Promise<Response | LagoX402Result>,
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  const outcome = await decide(x402, route, () => gateRequest(req));
  if (outcome.action === "respond") return responseOf(outcome);
  // Not caught: a handler that throws is answered 500 by Next, and nothing is billed.
  const { response, readUsage } = handlerAnswer(await handler(req, ctx));
  let served: Response;
  try {
    served = withServeHeaders(response, outcome.headers);
  } catch {
    // A served response never goes out without `private`: the gate's answer instead, billed
    // nothing (`payment_pending` after a payment, since the money has moved).
    return responseOf(outcome.unserved());
  }
  billAfter(outcome.billing, served.status, readUsage);
  return served;
}

/** The request as Next hands it over: `req.url` (the gate keeps only its pathname, never its
 * host), headers through `req.headers`. */
function gateRequest(req: Request): GateRequest {
  return {
    method: req.method,
    target: req.url,
    header: (name) => req.headers.get(name) ?? undefined,
  };
}

/** The handler's response, and how to read the usage it reported (once, when billing). Anything
 * else throws a `TypeError`, as Next does for a route handler that returns no `Response`. */
function handlerAnswer(answer: unknown): { response: Response; readUsage: () => unknown } {
  if (answer instanceof Response) return { response: answer, readUsage: () => undefined };
  if (typeof answer === "object" && answer !== null) {
    const result = answer as Partial<Record<keyof LagoX402Result, unknown>>;
    const response = result.response;
    if (response instanceof Response) return { response, readUsage: () => result.usage };
  }
  throw new TypeError("withLagoX402: the handler returned neither a Response nor { response, usage }");
}

/** Bills through Next's `after()`, which runs the task once the response has gone out and keeps
 * the delivery alive past the request, so the response never waits for the event and the event
 * is not dropped when the request ends. Should `after()` throw (called outside a request scope),
 * the call is billed at once, never awaited: nothing may throw once the handler has run, since
 * on a paid call the money has already moved. */
function billAfter(billing: CallBilling, status: number, readUsage: () => unknown): void {
  const task = (): Promise<void> => bill(billing, () => status, readUsage);
  try {
    after(task);
  } catch {
    void task();
  }
}
