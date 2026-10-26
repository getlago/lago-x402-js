/** `createLagoX402`: validates the config, checks every route against Lago, and wires the gate,
 * usage events and background boot retries behind one `LagoX402`. The public object only has
 * `close()`; framework adapters reach the rest through `handleRequest` and `hasRoute`, which
 * the package entry point does not export. */
import { Boot, type Refusal } from "./boot.js";
import {
  ROUTE_NAME,
  validateConfig,
  type LagoX402Config,
  type LagoX402ErrorWhere,
  type NormalizedConfig,
} from "./config.js";
import { LagoX402ConfigError } from "./errors.js";
import { Gate, unavailable, type GateOutcome, type GateRequest } from "./gate.js";
import { LagoClient } from "./lago-client.js";
import { EventSender, createCallBilling, type ReportFn } from "./usage.js";

export interface LagoX402 {
  /** Stops background boot retries, then waits (at most `timeoutMs`, default 10 s) for usage
   * events still being delivered. Call it on shutdown. */
  close(options?: { timeoutMs?: number }): Promise<void>;
}

/** Test seams; not reachable through the package entry point. */
export interface InternalOptions {
  bootRetryBaseMs?: number;
  bootRetryMaxMs?: number;
  /** The clock usage events are stamped with. */
  now?: () => number;
}

interface Internals {
  config: NormalizedConfig;
  gate: Gate;
  boot: Boot;
  report: ReportFn;
}

const BOOT_RETRY_BASE_MS = 1000;
const BOOT_RETRY_MAX_MS = 60_000;
const CLOSE_TIMEOUT_MS = 10_000;
// Node's setTimeout treats anything above 2^31-1 ms as 1 ms.
const MAX_TIMEOUT_MS = 2147483647;

const instances = new WeakMap<LagoX402, Internals>();

/** The one error channel: `onError` when set (a throw from it is swallowed), and always a
 * `console.warn` line, the log floor. Messages are sanitized where errors are built. */
function reporter(onError?: (err: unknown, where: LagoX402ErrorWhere) => void): ReportFn {
  return (err, where) => {
    if (onError) {
      try {
        onError(err, where);
      } catch {
        // A merchant's callback must never break a response or a boot.
      }
    }
    try {
      console.warn(`[lago-x402] ${where} failed: ${err.message}`);
    } catch {
      // Same for a patched console.
    }
  };
}

/** Without an instance there is no `onError` to call: the log floor still applies. */
const logOnly = reporter();

function refusalError(refused: Refusal[]): LagoX402ConfigError {
  if (refused.length === 1) return new LagoX402ConfigError(refused[0].route, refused[0].reason);
  const listed = refused.map(({ route, reason }) => `"${route}": ${reason}`).join("; ");
  return new LagoX402ConfigError(null, `${refused.length} routes refused: ${listed}`);
}

function closeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return CLOSE_TIMEOUT_MS;
  return Math.min(value, MAX_TIMEOUT_MS);
}

export async function createLagoX402(
  config: LagoX402Config,
  options: InternalOptions = {},
): Promise<LagoX402> {
  const normalized = validateConfig(config);
  const report = reporter(normalized.onError);
  const client = new LagoClient(normalized.apiUrl, normalized.apiKey);
  const sender = new EventSender(client, { timeoutMs: normalized.timeouts.eventMs }, report);
  const gate = new Gate({
    client,
    config: normalized,
    report,
    billing: (route, externalSubscriptionId, notBeforeMs) =>
      createCallBilling(route, externalSubscriptionId, sender, report, notBeforeMs, options.now),
  });
  const boot = new Boot(client, normalized, report, {
    retryBaseMs: options.bootRetryBaseMs ?? BOOT_RETRY_BASE_MS,
    retryMaxMs: options.bootRetryMaxMs ?? BOOT_RETRY_MAX_MS,
  });

  const refused = await boot.start();
  if (refused.length > 0) {
    boot.stop(); // A rejected boot leaves no retry timer behind.
    const err = refusalError(refused);
    // Reported before rejecting. An adapter given this promise awaits it per request, so a
    // request in flight handles the rejection and Node raises no unhandled rejection: without
    // this report the refusal would leave no trace. An invalid config (validateConfig above)
    // rejects at once, before any handler can be attached, so it is left to Node.
    report(err, "boot");
    throw err;
  }

  const x402: LagoX402 = Object.freeze({
    async close(o?: { timeoutMs?: number }): Promise<void> {
      boot.stop();
      await sender.drain(closeTimeout(o?.timeoutMs));
    },
  });
  instances.set(x402, { config: normalized, gate, boot, report });
  return x402;
}

/** True when `route` names a configured route of an instance `createLagoX402` made. */
export function hasRoute(x402: LagoX402, route: string): boolean {
  return instances.get(x402)?.config.routes.has(route) ?? false;
}

/** The per-request entry point for adapters. Never rejects. An unknown route name answers 503
 * and is reported (`gate.check`); a route that is not `active` answers 503 without a report
 * (its boot state is reported by the boot checks). */
export async function handleRequest(x402: LagoX402, route: string, req: GateRequest): Promise<GateOutcome> {
  const internals = instances.get(x402);
  if (internals === undefined) {
    logOnly(new LagoX402ConfigError(null, "the LagoX402 was not made by createLagoX402"), "gate.check");
    return unavailable();
  }
  const configured = internals.config.routes.get(route);
  if (configured === undefined) {
    internals.report(
      typeof route === "string" && ROUTE_NAME.test(route)
        ? new LagoX402ConfigError(route, "not configured")
        : new LagoX402ConfigError(null, "a request named a route that is not configured"),
      "gate.check",
    );
    return unavailable();
  }
  if (internals.boot.state(route) !== "active") return unavailable();
  try {
    return await internals.gate.handle(configured, req);
  } catch {
    // The gate never rejects; this only keeps the promise that handleRequest never does.
    return unavailable();
  }
}
