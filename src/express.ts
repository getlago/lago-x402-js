/** `lago-x402/express`: the gate as Express middleware (Express 4 and 5), attached per route
 * through Express's own router, so the gate never decides on a path of its own:
 *
 *   app.post("/v1/generate", lagoX402(x402, "generate"), handler);
 *
 * The handler reports usage with `res.locals.lagoUsage = n`; it is read once the response has
 * finished. Served responses get `private` merged into whatever `Cache-Control` the handler
 * sends. Nothing here ever throws into Express or rejects (Express 4 does not catch a rejected
 * middleware): an unexpected failure answers 503 `unavailable` and never serves.
 *
 * Only Express's types are imported; the package never loads `express` at runtime. */
import type { OutgoingHttpHeader, ServerResponse } from "node:http";
import { withPrivateCacheControl } from "@x402/core/http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ROUTE_NAME } from "./config.js";
import { LagoX402ConfigError } from "./errors.js";
import { unavailable, type GateOutcome, type GateRequest } from "./gate.js";
import { handleRequest, hasRoute, type LagoX402 } from "./x402.js";

type Serve = Extract<GateOutcome, { action: "serve" }>;

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
export function lagoX402(x402: LagoX402 | PromiseLike<LagoX402>, route: string): RequestHandler {
  if (!isPromiseLike(x402) && !hasRoute(x402, route)) {
    // A name that can never be a route (it fails the config's pattern) stays out of the message.
    throw typeof route === "string" && ROUTE_NAME.test(route)
      ? new LagoX402ConfigError(route, "not configured")
      : new LagoX402ConfigError(null, "lagoX402 was given a route name that is not configured");
  }
  return (req, res, next) => {
    void gate(x402, route, req, res, next);
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

/** Never rejects. `next()` is called only for a serve outcome, and nothing is written after it. */
async function gate(
  x402: LagoX402 | PromiseLike<LagoX402>,
  route: string,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let handedOver = false;
  try {
    const instance = await instanceOf(x402);
    // No instance to report through: the app's own await of createLagoX402 surfaces the error.
    if (instance === null) return respond(res, unavailable());
    const outcome = await handleRequest(instance, route, gateRequest(req));
    if (outcome.action === "respond") return respond(res, outcome);
    serve(res, outcome);
    handedOver = true;
    next();
  } catch {
    if (handedOver || res.headersSent) return;
    try {
      respond(res, unavailable());
    } catch {
      // Nothing left to answer with.
    }
  }
}

/** The request as received: the target exactly as Express keeps it (`originalUrl` survives
 * mounting), headers through `req.get`, strings only. */
function gateRequest(req: Request): GateRequest {
  const target = req.originalUrl ?? req.url;
  return {
    method: req.method,
    target,
    header(name) {
      const value = req.get(name);
      return typeof value === "string" ? value : undefined;
    },
  };
}

/** Answers for the gate. Only `respond` outcomes reach it (`unavailable()` is one). */
function respond(res: Response, outcome: GateOutcome): void {
  if (outcome.action !== "respond") throw new Error("lago-x402: not a response");
  res.status(outcome.status);
  for (const [name, value] of Object.entries(outcome.headers)) res.setHeader(name, value);
  res.end(outcome.body);
}

/** Applies the serve headers, keeps the response private, and bills once it has gone out:
 * on `finish`, or on `close` when the headers were sent before the client went away. Billing
 * is never awaited here and never throws or rejects into the response. */
function serve(res: Response, outcome: Serve): void {
  for (const [name, value] of Object.entries(outcome.headers)) res.setHeader(name, value);
  keepPrivate(res);
  const bill = (): void => {
    try {
      outcome.billing.finish(res.statusCode, () => res.locals?.lagoUsage).catch(() => undefined);
    } catch {
      // Metering never breaks a response.
    }
  };
  res.on("finish", bill);
  res.on("close", () => {
    if (res.headersSent) bill();
  });
}

/** Wraps `res.writeHead`, which Node also calls for an implicit header write (`res.write`,
 * `res.end`, `res.send`, `flushHeaders`), so `private` is merged into the `Cache-Control` that
 * actually goes out, never overwriting the handler's directives (R4, R26). Headers passed to
 * `writeHead` itself are applied first, exactly as Node applies them once any header was set. */
function keepPrivate(res: ServerResponse): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: ServerResponse, ...args: unknown[]) {
    if (!this.headersSent) {
      try {
        args = withPrivateHeaders(this, args);
      } catch {
        // Bad header arguments: Node's own writeHead refuses the original call.
      }
    }
    return Reflect.apply(writeHead, this, args) as ServerResponse;
  } as ServerResponse["writeHead"];
}

/** `writeHead(status[, reason][, headers])` with its headers applied through the progressive
 * API (Node's own "slow case"); returns the arguments left for the original call. */
function withPrivateHeaders(res: ServerResponse, args: unknown[]): unknown[] {
  const hasReason = typeof args[1] === "string";
  const headers = hasReason ? args[2] : (args[2] ?? args[1]);
  let rest = args;
  if (Array.isArray(headers)) {
    if (headers.length % 2 !== 0) return args; // Node throws on it.
    for (let i = 0; i < headers.length; i += 2) res.removeHeader(headers[i] as string);
    for (let i = 0; i < headers.length; i += 2) {
      if (headers[i]) res.appendHeader(headers[i] as string, headers[i + 1] as string | string[]);
    }
    rest = args.slice(0, hasReason ? 2 : 1);
  } else if (typeof headers === "object" && headers !== null) {
    const record = headers as Record<string, OutgoingHttpHeader>;
    for (const name of Object.keys(record)) if (name) res.setHeader(name, record[name]);
    rest = args.slice(0, hasReason ? 2 : 1);
  }
  const current = res.getHeader("Cache-Control");
  const value = current === undefined ? null : Array.isArray(current) ? current.join(", ") : String(current);
  res.setHeader("Cache-Control", withPrivateCacheControl(value));
  return rest;
}
