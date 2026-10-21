/** Usage events: one `POST /events` per served call, valued from what the handler reported,
 * retried with the same bytes, bounded in concurrency and queue, and never able to break a
 * response. Error messages are constant: they never carry the reported value or a handler's
 * exception text. */
import { randomUUID } from "node:crypto";
import type { LagoX402ErrorWhere, NormalizedRoute } from "./config.js";
import { LagoApiError, LagoUnreachableError, LagoX402UsageError, sanitizedLagoCodes } from "./errors.js";
import type { CallBilling } from "./gate.js";
import type { LagoClient } from "./lago-client.js";

export type ReportFn = (err: Error, where: LagoX402ErrorWhere) => void;

export interface UsageEvent {
  transactionId: string;
  externalSubscriptionId: string;
  /** The billable metric code. */
  code: string;
  /** Integer seconds. */
  timestamp: number;
  /** Decimal string. */
  value: string;
  walletCode: string;
}

export interface EventSenderOptions {
  timeoutMs: number;
  maxAttempts?: number;
  backoffMs?: number;
  maxInFlight?: number;
  maxQueued?: number;
}

interface Pending {
  body: string;
  done: () => void;
}

function safeReport(report: ReportFn, err: Error, where: LagoX402ErrorWhere): void {
  try {
    report(err, where);
  } catch {
    // A failing onError must never reach the response path.
  }
}

function serialize(e: UsageEvent): string {
  return JSON.stringify({
    event: {
      transaction_id: e.transactionId,
      external_subscription_id: e.externalSubscriptionId,
      code: e.code,
      timestamp: e.timestamp,
      properties: { value: e.value, target_wallet_code: e.walletCode },
    },
  });
}

type Verdict = { kind: "delivered" } | { kind: "permanent" | "retry"; error: Error };

function classify(status: number, body: unknown): Verdict {
  if (status >= 200 && status < 300) return { kind: "delivered" };
  if (status === 422 && sanitizedLagoCodes(body).errorCodes.transaction_id?.includes("value_already_exist")) {
    return { kind: "delivered" };
  }
  const error = new LagoApiError("events", status, body);
  if (status >= 500 || status === 408 || status === 429) return { kind: "retry", error };
  return { kind: "permanent", error };
}

export class EventSender {
  readonly #client: LagoClient;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #maxInFlight: number;
  readonly #maxQueued: number;
  readonly #report: ReportFn;
  readonly #queue: Pending[] = [];
  readonly #active = new Set<Promise<void>>();
  #idleWaiters: (() => void)[] = [];

  constructor(client: LagoClient, o: EventSenderOptions, report: ReportFn) {
    this.#client = client;
    this.#timeoutMs = o.timeoutMs;
    this.#maxAttempts = o.maxAttempts ?? 4;
    this.#backoffMs = o.backoffMs ?? 500;
    this.#maxInFlight = o.maxInFlight ?? 16;
    this.#maxQueued = o.maxQueued ?? 1000;
    this.#report = report;
  }

  /** Never rejects; resolves once the event is delivered, dropped or given up. */
  send(e: UsageEvent): Promise<void> {
    return new Promise<void>((resolve) => {
      let body: string;
      try {
        body = serialize(e);
      } catch {
        resolve();
        return;
      }
      if (this.#active.size < this.#maxInFlight) {
        this.#start({ body, done: resolve });
      } else if (this.#queue.length < this.#maxQueued) {
        this.#queue.push({ body, done: resolve });
      } else {
        safeReport(this.#report, new LagoX402UsageError("queue_full"), "usage.send");
        resolve();
      }
    });
  }

  /** True when everything in flight and queued settled within `timeoutMs`. Its timer stays
   * ref'd (unlike the backoff timers), so awaiting `drain` in a shutdown handler keeps Node
   * alive until the queue is idle or the timeout fires. */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.#active.size === 0 && this.#queue.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#idleWaiters = this.#idleWaiters.filter((w) => w !== onIdle);
        resolve(false);
      }, timeoutMs);
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.#idleWaiters.push(onIdle);
    });
  }

  #start(p: Pending): void {
    const run = this.#deliver(p.body).then(() => {
      this.#active.delete(run);
      p.done();
      const next = this.#queue.shift();
      if (next) this.#start(next);
      else if (this.#active.size === 0) {
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const w of waiters) w();
      }
    });
    this.#active.add(run);
  }

  async #deliver(body: string): Promise<void> {
    let last: Error = new LagoUnreachableError("events", "network");
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      if (attempt > 1) await this.#backoff(attempt - 1);
      try {
        // The client serializes with JSON.stringify; parsing our own string first keeps the
        // bytes identical on every attempt.
        const res = await this.#client.request(
          "events",
          "POST",
          "/events",
          JSON.parse(body),
          this.#timeoutMs,
        );
        const verdict = classify(res.status, res.body);
        if (verdict.kind === "delivered") return;
        last = verdict.error;
        if (verdict.kind === "permanent") break;
      } catch (err) {
        last = err instanceof Error ? err : new LagoUnreachableError("events", "network");
      }
    }
    safeReport(this.#report, last, "usage.send");
  }

  #backoff(retryNumber: number): Promise<void> {
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    const ms = this.#backoffMs * 2 ** (retryNumber - 1) * jitter;
    return new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    });
  }
}

function usageError(reason: LagoX402UsageError["reason"]): LagoX402UsageError {
  return new LagoX402UsageError(reason);
}

/** Fixes `transaction_id` and `timestamp` now (serve time), so every retry carries both. */
export function createCallBilling(
  route: NormalizedRoute,
  externalSubscriptionId: string,
  sender: EventSender,
  report: ReportFn,
): CallBilling {
  const transactionId = randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  let first: Promise<void> | undefined;

  const run = async (status: number, readUsage: () => unknown): Promise<void> => {
    if (status >= 400) return;
    let reported: unknown;
    try {
      reported = readUsage();
    } catch {
      safeReport(report, usageError("threw"), "usage.extract");
      return;
    }
    if (reported === undefined) {
      safeReport(report, usageError("missing"), "usage.extract");
      return;
    }
    if (typeof reported !== "number" || !Number.isFinite(reported) || reported < 0) {
      safeReport(report, usageError("invalid"), "usage.extract");
      return;
    }
    await sender.send({
      transactionId,
      externalSubscriptionId,
      code: route.billableMetric,
      timestamp,
      value: String(reported === 0 ? 0 : reported),
      walletCode: route.walletCode,
    });
  };

  return {
    finish(status, readUsage) {
      first ??= run(status, readUsage).catch(() => undefined);
      return first;
    },
  };
}
