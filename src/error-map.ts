/** Pure decision table: turns Lago's refusals of E7 (gate check) and E8 (credit purchase)
 * into what the middleware answers the agent. Handles HTTP answers only; a thrown
 * `LagoUnreachableError` is the gate's business. Codes come from `sanitizedLagoCodes`, so
 * nothing free-text reaches a decision. A 402 may only follow a refusal Lago issued before
 * money moved, hence the conservative rule on multi-field 422s below. */

import { LagoApiError, sanitizedLagoCodes, type LagoEndpoint } from "./errors.js";

export type Decision =
  | { kind: "challenge"; error?: string }
  | {
      kind: "refuse";
      status: 401 | 403 | 409 | 503;
      error: string;
      reason?: string;
      retryAfterSeconds?: number;
      report?: Error;
    }
  | { kind: "retry"; why: "grant" | "lost" };

export interface LagoAnswer {
  status: number;
  body: unknown;
}

/** `Retry-After` when Lago gives no usable `reconcile_after`, and for a lost E8 answer. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 3600;

export function retryAfterFrom(reconcileAfter: string | null, now: number): number {
  if (reconcileAfter === null) return DEFAULT_RETRY_AFTER_SECONDS;
  const at = Date.parse(reconcileAfter);
  const seconds = Math.ceil((at - now) / 1000);
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(MIN_RETRY_AFTER_SECONDS, seconds));
}

// Codes below are verified against lago-api, branch feat/x402/gate-check-sign-in.

/** `base` codes meaning "the buyer is unknown and the connection does not auto-create".
 * Emitted by app/services/x402/gate_checks/check_service.rb (E7) and
 * app/services/x402/credit_purchases/validate_service.rb (E8). */
const BUYER_NOT_RECOGNIZED = "buyer_not_recognized";

/** `base` codes meaning "a purchase is already in flight or recorded: ask the agent to come back".
 * `credit_purchase_pending`: gate_checks/check_service.rb (E7); E8 race on the unique index
 * `..._pending_credit_purchase_payer` in settlements/settle_service.rb (RACE_CODES).
 * `payment_already_recorded` (digest index) and `invoice_payment_pending` (invoice index):
 * settlements/settle_service.rb RACE_CODES, surfaced by credit_purchases/purchase_service.rb. */
const E7_PENDING_BASE_CODES: readonly string[] = ["credit_purchase_pending"];
const E8_PENDING_BASE_CODES: readonly string[] = [
  "credit_purchase_pending",
  "payment_already_recorded",
  "invoice_payment_pending",
];

/** E8 `base: credit_grant_failed`: credit_purchases/grant_service.rb, refused by
 * credit_purchases/purchase_service.rb#refuse_grant (money already moved: never a 402). */
const CREDIT_GRANT_FAILED = "credit_grant_failed";

/** E8 `payment: recorded_as_invoice_payment`: credit_purchases/purchase_service.rb#refuse_invoice_payment. */
const RECORDED_AS_INVOICE_PAYMENT = "recorded_as_invoice_payment";

/** E8 `payment_requirements: amount_above_maximum`: credit_purchases/validate_service.rb. */
const AMOUNT_ABOVE_MAXIMUM = "amount_above_maximum";

const SIWX_FIELD = "siwx"; // gate_checks/check_service.rb, sign_in_with_x/verify_service.rb
const PAYMENT_FIELDS: readonly string[] = ["payment", "payment_requirements"]; // settlements/verify_service.rb

interface Codes {
  /** True only for a 422 carrying Lago's `validation_errors` envelope. */
  validation: boolean;
  errorCodes: Record<string, string[]>;
}

function codesOf(answer: LagoAnswer): Codes {
  const { code, errorCodes } = sanitizedLagoCodes(answer.body);
  return { validation: answer.status === 422 && code === "validation_errors", errorCodes };
}

/** The RAW `error_details` entries. The sanitizer silently drops unreadable fields, so shape
 * decisions ("purely payment", "only base") are made here, on what Lago actually sent; the
 * sanitized codes only supply strings. An unreadable shape must fail closed. */
function rawDetails(body: unknown): [string, unknown][] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const details = (body as Record<string, unknown>).error_details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return [];
  return Object.entries(details);
}

function rawFieldsAre(body: unknown, allowed: readonly string[]): boolean {
  const entries = rawDetails(body);
  return (
    entries.length > 0 && entries.every(([k, v]) => allowed.includes(k) && Array.isArray(v) && v.length > 0)
  );
}

function onlyField(body: unknown, errorCodes: Record<string, string[]>, field: string): string[] | null {
  return rawFieldsAre(body, [field]) ? (errorCodes[field] ?? null) : null;
}

function unavailable(endpoint: LagoEndpoint, answer: LagoAnswer): Decision {
  return {
    kind: "refuse",
    status: 503,
    error: "unavailable",
    report: new LagoApiError(endpoint, answer.status, answer.body),
  };
}

function pending(report?: Error): Decision {
  return {
    kind: "refuse",
    status: 503,
    error: "payment_pending",
    retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
    ...(report ? { report } : {}),
  };
}

const buyerNotRecognized: Decision = { kind: "refuse", status: 403, error: "buyer_not_recognized" };

/** Maps any non-200 E7 answer. Everything not listed fails closed as 503 `unavailable`. */
export function mapGateCheckRefusal(answer: LagoAnswer): Decision {
  const { validation, errorCodes } = codesOf(answer);
  if (validation) {
    const siwx = errorCodes[SIWX_FIELD];
    if (siwx?.[0] !== undefined) {
      return { kind: "refuse", status: 401, error: "sign_in_rejected", reason: siwx[0] };
    }
    const base = onlyField(answer.body, errorCodes, "base")?.[0];
    if (base === BUYER_NOT_RECOGNIZED) return buyerNotRecognized;
    if (base !== undefined && E7_PENDING_BASE_CODES.includes(base)) return pending();
  }
  return unavailable("gate_checks", answer);
}

/** Maps any non-200 E8 answer. `attempt` is 1 for the first call, 2 for the single retry, which
 * never challenges: it only follows an answer after which money may have moved. */
export function mapCreditPurchaseRefusal(answer: LagoAnswer, attempt: 1 | 2): Decision {
  const report = (): Error => new LagoApiError("credit_purchases", answer.status, answer.body);

  // Any 5xx may hide a settled payment (ruling R11): retry once, then ask the agent to wait.
  if (answer.status >= 500) {
    return attempt === 1 ? { kind: "retry", why: "lost" } : pending(report());
  }

  const { validation, errorCodes } = codesOf(answer);
  if (!validation) return unavailable("credit_purchases", answer);

  if (rawFieldsAre(answer.body, PAYMENT_FIELDS)) {
    if (errorCodes.payment?.includes(RECORDED_AS_INVOICE_PAYMENT)) {
      return { kind: "refuse", status: 409, error: "payment_already_used", report: report() };
    }
    if (errorCodes.payment_requirements?.includes(AMOUNT_ABOVE_MAXIMUM)) {
      return unavailable("credit_purchases", answer);
    }
    // Attempt 2 only follows credit_grant_failed (money moved), a lost answer or a 5xx (money may
    // have moved): the first attempt may have spent the authorization the retry presents again,
    // so a payment refusal now is never a 402 (ruling R16).
    if (attempt === 2) return pending(report());
    // payment first, then payment_requirements: the first sanitized code on either.
    const first = errorCodes.payment?.[0] ?? errorCodes.payment_requirements?.[0];
    return first === undefined ? { kind: "challenge" } : { kind: "challenge", error: first };
  }

  const base = onlyField(answer.body, errorCodes, "base")?.[0];
  if (base === BUYER_NOT_RECOGNIZED) return buyerNotRecognized;
  if (base !== undefined && E8_PENDING_BASE_CODES.includes(base)) return pending();
  if (base === CREDIT_GRANT_FAILED) {
    return attempt === 1 ? { kind: "retry", why: "grant" } : pending(report());
  }
  return unavailable("credit_purchases", answer);
}
