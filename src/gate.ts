/** The gate: for one protected request, asks Lago whether to challenge (402), refuse
 * (401/403/409/503) or serve, and on a paid request forwards the agent's payment to Lago.
 * Framework adapters only turn requests into `GateRequest` and apply `GateOutcome`.
 *
 * Legs: no header → E7 → 402. `SIGN-IN-WITH-X` → E7 with `siwx` → serve or 402.
 * `PAYMENT-SIGNATURE` (wins over a sign-in) → E7 for a fresh menu → match `accepted` → E8.
 * Fails closed: anything unreadable or unexpected is a 503, and nothing that may follow a
 * settled payment is ever a 402. Nothing here logs; `report` carries only sanitized errors. */
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { LagoX402ErrorWhere, NormalizedConfig, NormalizedRoute } from "./config.js";
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  mapCreditPurchaseRefusal,
  mapGateCheckRefusal,
  retryAfterFrom,
  type Decision,
  type LagoAnswer,
} from "./error-map.js";
import { LagoApiError, LagoUnreachableError } from "./errors.js";
import type { LagoClient } from "./lago-client.js";
import {
  SIGN_IN_WITH_X,
  decodePaymentHeader,
  decodeSignInHeader,
  parseGateCheck,
  parseSettlement,
  paymentRequiredHeader,
  paymentResponseHeader,
  renderAccepts,
  renderResource,
  renderSignIn,
  resourceUrl,
} from "./wire.js";

export interface GateRequest {
  method: string;
  /** The request target as received (origin-form, or absolute-form behind some proxies). */
  target: string;
  /** Case-insensitive; `undefined` when absent. */
  header(name: string): string | undefined;
}

/** Bills one served call once the handler has answered (concrete in `usage.ts`). */
export interface CallBilling {
  finish(status: number, readUsage: () => unknown): Promise<void>;
}

/** The gate's own answer, a challenge or a refusal, sent instead of the handler's. */
export interface GateAnswer {
  action: "respond";
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type GateOutcome =
  | GateAnswer
  | {
      action: "serve";
      headers: Record<string, string>;
      billing: CallBilling;
      /** What to answer instead when the handler's response cannot go out as served (it cannot be
       * made private). Nothing is billed: 503 `unavailable`, or after a payment, since the money
       * has moved, 503 `payment_pending` reported as `gate.purchase`. */
      unserved: () => GateAnswer;
    };

export interface GateDeps {
  client: LagoClient;
  config: NormalizedConfig;
  report: (err: Error, where: LagoX402ErrorWhere) => void;
  billing: (
    route: NormalizedRoute,
    externalSubscriptionId: string,
    notBeforeMs: number | null,
  ) => CallBilling;
}

export const GATE_CHECKS_PATH = "/x402/gate_checks";
const CREDIT_PURCHASES_PATH = "/x402/credit_purchases";
/** The E8 retry (lost answer or failed grant) runs only with at least this much budget left. */
const MIN_RETRY_BUDGET_MS = 1000;
const SAFE_NAME = /^[A-Za-z0-9_.]{1,64}$/;

/** A fresh E7 menu: what a 402 offers and what a payment must match. */
interface Menu {
  accepts: PaymentRequirements[];
  signInChains: string[];
}

type GateCheckResult =
  | { kind: "pass"; externalSubscriptionId: string; subscriptionStartedAt: number | null }
  | { kind: "challenge"; menu: Menu }
  | { kind: "done"; outcome: GateOutcome };

/** One E8 attempt either finishes the request or asks for the single retry. */
type PurchaseStep = { kind: "retry"; cause: Error } | { kind: "done"; outcome: GateOutcome };

interface Purchase {
  route: NormalizedRoute;
  req: GateRequest;
  menu: Menu;
  /** Built once: both attempts send the identical bytes. */
  body: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key));
}

/** Structural equality of JSON values (object key order ignored). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a)) {
    return isPlainObject(b) && sameKeys(a, b) && Object.keys(a).every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

const MATCHED_FIELDS = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds"] as const;

/** E8 never checks the amount against the route, so a payment is forwarded only when the entry
 * it paid matches a fresh one: the same key set, equal terms and deep-equal `extra`. On
 * `solana:*` only `extra.feePayer` may differ (CDP rotates it per `/supported` call), and must
 * then be a non-empty string. Nothing is normalised. */
function matches(entry: PaymentRequirements, accepted: Record<string, unknown>): boolean {
  const fresh = entry as unknown as Record<string, unknown>;
  if (!sameKeys(fresh, accepted) || !MATCHED_FIELDS.every((key) => fresh[key] === accepted[key])) {
    return false;
  }
  const paid = accepted.extra;
  if (!entry.network.startsWith("solana:")) return deepEqual(entry.extra, paid);
  return (
    isPlainObject(entry.extra) &&
    isPlainObject(paid) &&
    sameKeys(entry.extra, paid) &&
    typeof paid.feePayer === "string" &&
    paid.feePayer.length > 0 &&
    Object.keys(paid).every((key) => key === "feePayer" || deepEqual(entry.extra?.[key], paid[key]))
  );
}

/** A JSON refusal (`{"error"}`, plus `"reason"` on a 401), never cached. */
function refusal(
  status: number,
  body: { error: string; reason?: string },
  retryAfterSeconds?: number,
): GateAnswer {
  return {
    action: "respond",
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(retryAfterSeconds === undefined ? {} : { "Retry-After": String(retryAfterSeconds) }),
    },
    body: JSON.stringify(body),
  };
}

/** 503 `unavailable`: the gate's fail-closed answer, also given for a route that is not active. */
export const unavailable = (): GateAnswer => refusal(503, { error: "unavailable" });

/** E7's body: the one builder for the gate's three legs and the boot check, so boot probes Lago
 * with exactly the bytes leg 1 sends. `siwx` only on leg 2, exactly as decoded. */
export function gateCheckBody(
  config: NormalizedConfig,
  route: NormalizedRoute,
  siwx?: Record<string, unknown>,
): { gate_check: Record<string, unknown> } {
  return {
    gate_check: {
      connection_code: config.connectionCode,
      plan_code: route.planCode,
      billable_metric_code: route.billableMetric,
      wallet_code: route.walletCode,
      amount_cents: route.topUpAmountCents,
      estimated_call_cost_cents: route.estimatedCallCostCents,
      ...(siwx === undefined ? {} : { siwx }),
    },
  };
}

/** What a thrown value may say in a report: our own errors carry only sanitized codes; anything
 * else is replaced, since its message may quote a header or a body. */
function reportable(err: unknown): Error {
  if (err instanceof LagoApiError || err instanceof LagoUnreachableError) return err;
  const name = err instanceof Error && SAFE_NAME.test(err.name) ? err.name : "unknown";
  return new Error(`lago-x402 gate failed unexpectedly (${name})`);
}

export class Gate {
  readonly #client: LagoClient;
  readonly #config: NormalizedConfig;
  readonly #report: GateDeps["report"];
  readonly #billing: GateDeps["billing"];

  constructor(deps: GateDeps) {
    this.#client = deps.client;
    this.#config = deps.config;
    this.#report = deps.report;
    this.#billing = deps.billing;
  }

  /** Never rejects: an unexpected throw becomes 503 `unavailable` + `gate.check`. */
  async handle(route: NormalizedRoute, req: GateRequest): Promise<GateOutcome> {
    try {
      const payment = req.header("PAYMENT-SIGNATURE");
      if (payment !== undefined) return await this.#paid(route, req, payment);
      const signIn = req.header("SIGN-IN-WITH-X");
      if (signIn !== undefined) return await this.#signedIn(route, req, signIn);
      return await this.#stranger(route, req);
    } catch (err) {
      this.#notify(reportable(err), "gate.check");
      return unavailable();
    }
  }

  /** Leg 1: no proof of anything, so only a challenge is a valid answer. */
  async #stranger(route: NormalizedRoute, req: GateRequest): Promise<GateOutcome> {
    const check = await this.#gateCheck(route);
    if (check.kind === "done") return check.outcome;
    if (check.kind === "pass") return this.#unexpectedPass();
    return this.#paymentRequired(route, req, check.menu);
  }

  /** Leg 2: Lago verifies the proof (and burns its nonce) on a pass. */
  async #signedIn(route: NormalizedRoute, req: GateRequest, header: string): Promise<GateOutcome> {
    const siwx = decodeSignInHeader(header);
    if (siwx === null) return refusal(401, { error: "sign_in_rejected", reason: "invalid_header" });
    const check = await this.#gateCheck(route, siwx);
    if (check.kind === "done") return check.outcome;
    if (check.kind === "challenge") return this.#paymentRequired(route, req, check.menu);
    return {
      action: "serve",
      headers: { "Cache-Control": "private" },
      billing: this.#billing(route, check.externalSubscriptionId, check.subscriptionStartedAt),
      unserved: unavailable,
    };
  }

  /** Leg 3: the paid entry must match Lago's fresh menu (E8 never checks the amount against
   * the route), then the payment goes to E8 as sent, apart from `resource` and Bazaar. */
  async #paid(route: NormalizedRoute, req: GateRequest, header: string): Promise<GateOutcome> {
    const payment = decodePaymentHeader(header);
    const check = await this.#gateCheck(route);
    if (check.kind === "done") return check.outcome;
    if (check.kind === "pass") return this.#unexpectedPass();
    const { menu } = check;
    if (payment === null) return this.#paymentRequired(route, req, menu, "invalid_payment");
    const accepted = payment.accepted as unknown as Record<string, unknown>;
    if (!menu.accepts.some((entry) => matches(entry, accepted))) {
      return this.#paymentRequired(route, req, menu, "stale_challenge");
    }
    return this.#purchase({ route, req, menu, body: this.#purchaseBody(route, req, payment) });
  }

  /** E7. `siwx` only on leg 2, exactly as decoded. */
  async #gateCheck(route: NormalizedRoute, siwx?: Record<string, unknown>): Promise<GateCheckResult> {
    let answer: LagoAnswer;
    try {
      answer = await this.#client.request(
        "gate_checks",
        "POST",
        GATE_CHECKS_PATH,
        gateCheckBody(this.#config, route, siwx),
        this.#config.timeouts.gateCheckMs,
      );
    } catch (err) {
      if (!(err instanceof LagoUnreachableError)) throw err;
      this.#notify(err, "gate.check");
      return { kind: "done", outcome: unavailable() };
    }
    if (answer.status !== 200) {
      const decision = mapGateCheckRefusal(answer);
      const outcome =
        decision.kind === "refuse"
          ? this.#refuse(decision, "gate.check")
          : this.#fail(new LagoApiError("gate_checks", answer.status, answer.body), "gate.check");
      return { kind: "done", outcome };
    }
    let gate: ReturnType<typeof parseGateCheck>;
    try {
      gate = parseGateCheck(answer.body);
    } catch (err) {
      return { kind: "done", outcome: this.#fail(reportable(err), "gate.check") };
    }
    if (gate.kind === "pass") return gate;
    return {
      kind: "challenge",
      menu: { accepts: renderAccepts(gate.requirements), signInChains: gate.signInChains },
    };
  }

  /** E8's body. `payment` is a deep copy with `resource` reset to this route's 402 resource and
   * `extensions.bazaar` set to the route's rendered extension (deleted when the route is not
   * discoverable, whatever the agent sent); every other key keeps its position and value.
   * `payment_requirements` is `accepted` exactly as the agent sent it. */
  #purchaseBody(route: NormalizedRoute, req: GateRequest, payment: PaymentPayload): unknown {
    const forwarded = JSON.parse(JSON.stringify(payment)) as Record<string, unknown>;
    forwarded.resource = this.#resource(route, req);
    if (route.bazaar !== undefined) {
      const extensions = isPlainObject(forwarded.extensions) ? forwarded.extensions : {};
      extensions.bazaar = structuredClone(route.bazaar);
      forwarded.extensions = extensions;
    } else if (isPlainObject(forwarded.extensions)) {
      delete forwarded.extensions.bazaar;
    }
    return {
      credit_purchase: {
        connection_code: this.#config.connectionCode,
        plan_code: route.planCode,
        wallet_code: route.walletCode,
        wallet: route.wallet,
        payment: forwarded,
        payment_requirements: payment.accepted,
      },
    };
  }

  /** E8 with at most one retry of the identical body, both inside `creditPurchaseMs`. */
  async #purchase(purchase: Purchase): Promise<GateOutcome> {
    const budget = this.#config.timeouts.creditPurchaseMs;
    const started = Date.now();
    try {
      const first = await this.#attempt(purchase, 1, budget);
      if (first.kind === "done") return first.outcome;
      const remaining = budget - (Date.now() - started);
      if (remaining < MIN_RETRY_BUDGET_MS) return this.#paymentPending(first.cause);
      const second = await this.#attempt(purchase, 2, remaining);
      // The map never asks for a third attempt; fail as pending if it ever does.
      return second.kind === "done" ? second.outcome : this.#paymentPending(second.cause);
    } catch (err) {
      // E8 was called, so money may have moved: any throw from here on (a failing billing
      // factory after `settled`, say) asks the agent to come back, never `unavailable`, which
      // would read as "nothing happened" to an agent whose payment may have settled.
      return this.#paymentPending(reportable(err));
    }
  }

  async #attempt(purchase: Purchase, attempt: 1 | 2, timeoutMs: number): Promise<PurchaseStep> {
    let answer: LagoAnswer;
    try {
      answer = await this.#client.request(
        "credit_purchases",
        "POST",
        CREDIT_PURCHASES_PATH,
        purchase.body,
        timeoutMs,
      );
    } catch (err) {
      if (!(err instanceof LagoUnreachableError)) throw err;
      // A lost answer may hide a settlement: resending is safe (Lago answers a replay from its
      // row, and the retry serves it). A timeout is not retried: Lago may still be settling, so
      // the agent is asked to come back, and then signs in to use the credits it bought.
      if (err.reason === "network" && attempt === 1) return { kind: "retry", cause: err };
      return { kind: "done", outcome: this.#paymentPending(err) };
    }
    if (answer.status === 200) {
      return { kind: "done", outcome: this.#settled(purchase, answer.body, attempt) };
    }
    const decision = mapCreditPurchaseRefusal(answer, attempt);
    if (decision.kind === "retry") {
      return { kind: "retry", cause: new LagoApiError("credit_purchases", answer.status, answer.body) };
    }
    const outcome =
      decision.kind === "challenge"
        ? this.#paymentRequired(purchase.route, purchase.req, purchase.menu, decision.error)
        : this.#refuse(decision, "gate.purchase");
    return { kind: "done", outcome };
  }

  /** An E8 200. Money may have moved, so an unreadable answer is "pending", never a 402.
   *
   * A settled replay is served on the retry only. Lago answers a payment it already settled
   * from its row before checking anything else, for as long as it keeps the row, and finds that
   * row by a digest that leaves the signature out: anyone who reads a settled authorization from
   * the chain can present it again, under any signature, against a fresh 402, and would be
   * served on the payer's subscription. On a request's first attempt a settled replay is
   * therefore someone presenting a payment again (409 `payment_already_settled`, nothing billed
   * or reported); on the retry it is this request's own payment, answered again after a lost
   * answer, a 5xx or `credit_grant_failed`. A pending replay asks the agent to come back, like
   * any pending purchase. */
  #settled(purchase: Purchase, body: unknown, attempt: 1 | 2): GateOutcome {
    let settlement: ReturnType<typeof parseSettlement>;
    try {
      settlement = parseSettlement(body);
    } catch (err) {
      return this.#paymentPending(reportable(err));
    }
    // A settled answer always names its subscription (`parseSettlement`); the null check narrows.
    if (settlement.status === "pending" || settlement.externalSubscriptionId === null) {
      return refusal(
        503,
        { error: "payment_pending" },
        retryAfterFrom(settlement.reconcileAfter, Date.now()),
      );
    }
    if (settlement.replayed && attempt === 1) return refusal(409, { error: "payment_already_settled" });
    const { name } = purchase.route;
    return {
      action: "serve",
      headers: { "PAYMENT-RESPONSE": paymentResponseHeader(settlement), "Cache-Control": "private" },
      billing: this.#billing(
        purchase.route,
        settlement.externalSubscriptionId,
        settlement.subscriptionStartedAt,
      ),
      unserved: () =>
        this.#paymentPending(
          new Error(`lago-x402 route "${name}": a paid call's response could not be served`),
        ),
    };
  }

  /** A 402 on Lago's fresh menu, with a fresh sign-in nonce every time. `domain`, `uri` and
   * `resource.url` come from the configured origin, never from request headers. */
  #paymentRequired(route: NormalizedRoute, req: GateRequest, menu: Menu, error?: string): GateOutcome {
    const resource = this.#resource(route, req);
    const signIn = renderSignIn({
      origin: this.#config.origin,
      resourceUrl: resource.url,
      statement: this.#config.signInStatement,
      signInChains: menu.signInChains,
    });
    const header = paymentRequiredHeader({
      resource,
      accepts: menu.accepts,
      extensions: {
        [SIGN_IN_WITH_X]: signIn,
        ...(route.bazaar === undefined ? {} : { bazaar: structuredClone(route.bazaar) }),
      },
      ...(error === undefined ? {} : { error }),
    });
    return {
      action: "respond",
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": header,
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
      body: "{}",
    };
  }

  /** The 402's `resource`, also reset into the forwarded payment: one builder, one shape. */
  #resource(route: NormalizedRoute, req: GateRequest) {
    return renderResource({ url: resourceUrl(this.#config.origin, req.target), ...route.resource });
  }

  #refuse(decision: Extract<Decision, { kind: "refuse" }>, where: LagoX402ErrorWhere): GateOutcome {
    if (decision.report) this.#notify(decision.report, where);
    const { error, reason } = decision;
    return refusal(
      decision.status,
      reason === undefined ? { error } : { error, reason },
      decision.retryAfterSeconds,
    );
  }

  #unexpectedPass(): GateOutcome {
    return this.#fail(new LagoApiError("gate_checks", 200, { code: "unexpected_pass" }), "gate.check");
  }

  #fail(err: Error, where: LagoX402ErrorWhere): GateOutcome {
    this.#notify(err, where);
    return unavailable();
  }

  #paymentPending(err: Error): GateAnswer {
    this.#notify(err, "gate.purchase");
    return refusal(503, { error: "payment_pending" }, DEFAULT_RETRY_AFTER_SECONDS);
  }

  /** A throwing reporter must never turn an answer into a rejection. */
  #notify(err: Error, where: LagoX402ErrorWhere): void {
    try {
      this.#report(err, where);
    } catch {
      // Deliberately ignored.
    }
  }
}
