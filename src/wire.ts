/** x402 v2 wire format. Turns Lago's gate-check (E7) and credit-purchase (E8) answers into
 * what agents see, and agents' headers into what Lago receives. Pure functions on top of
 * `@x402/core`'s codecs: nothing here reads a request, keeps state or logs. */
import { randomBytes } from "node:crypto";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { Network, PaymentPayload, PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { Base64EncodedRegex, safeBase64Decode } from "@x402/core/utils";
import { LagoApiError, type LagoEndpoint } from "./errors.js";

/** The sign-in statement when the config sets none. The config refuses an empty one: Lago refuses
 * `statement: ""`, and the official EVM and Solana formatters disagree on how to sign one. */
export const DEFAULT_SIGN_IN_STATEMENT = "Sign in to use your prepaid credits.";

/** The `extensions` key of the sign-in challenge (`@x402/extensions` `SIGN_IN_WITH_X`). */
export const SIGN_IN_WITH_X = "sign-in-with-x";

/** One entry of E7's `requirements` (`app/services/x402/payment_requirements_service.rb`). */
export interface LagoRequirement {
  scheme: string;
  network: string;
  asset: string;
  asset_address: string;
  extra: Record<string, unknown>;
  pay_to: string;
  amount_atomic: string;
  max_timeout_seconds: number;
}

/** E7's answer (`app/serializers/v1/x402/gate_check_serializer.rb`), discriminated on
 * `requirements`. */
export type GateCheck =
  | {
      kind: "pass";
      externalSubscriptionId: string;
      /** When Lago started that subscription, in epoch milliseconds. */
      subscriptionStartedAt: number | null;
    }
  | { kind: "challenge"; requirements: LagoRequirement[]; signInChains: string[] };

/** E8's answer (`app/serializers/v1/x402/settlement_serializer.rb`), the fields the gate uses. */
export interface Settlement {
  status: "settled" | "pending";
  replayed: boolean;
  network: string;
  transactionHash: string | null;
  payerAddress: string;
  externalSubscriptionId: string | null;
  /** When Lago started that subscription, in epoch milliseconds. */
  subscriptionStartedAt: number | null;
  reconcileAfter: string | null;
}

export interface SignInChain {
  chainId: string;
  type: "eip191" | "ed25519";
}

/** `PaymentRequired.extensions["sign-in-with-x"]`. No `resources` (Lago rebuilds a
 * `Resources:` block only when non-empty, and the proof stays small) and no `expirationTime`. */
export interface SignInExtension {
  info: { domain: string; uri: string; statement: string; version: "1"; nonce: string; issuedAt: string };
  supportedChains: SignInChain[];
  schema: SignInSchema;
}

export type SignInSchema = ReturnType<typeof signInSchema>;

/** `buildSIWxSchema()` of `@x402/extensions` (a dev dependency only), kept identical by a test.
 * A fresh object per call, so no 402 shares mutable state with another. */
function signInSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object" as const,
    properties: {
      domain: { type: "string" },
      address: { type: "string" },
      statement: { type: "string" },
      uri: { type: "string", format: "uri" },
      version: { type: "string" },
      chainId: { type: "string" },
      type: { type: "string" },
      nonce: { type: "string" },
      issuedAt: { type: "string", format: "date-time" },
      expirationTime: { type: "string", format: "date-time" },
      notBefore: { type: "string", format: "date-time" },
      requestId: { type: "string" },
      resources: { type: "array", items: { type: "string", format: "uri" } },
      signature: { type: "string" },
    },
    required: ["domain", "address", "uri", "version", "chainId", "type", "nonce", "issuedAt", "signature"],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function epochMsOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const DIGITS = /^[0-9]+$/;

/** A 200 whose body is not the documented shape. Carries no part of the body. */
function unexpectedAnswer(endpoint: LagoEndpoint): LagoApiError {
  return new LagoApiError(endpoint, 200, { code: "unexpected_answer" });
}

function parseRequirement(entry: unknown): LagoRequirement | null {
  if (!isPlainObject(entry)) return null;
  const { scheme, network, asset, asset_address, extra, pay_to, amount_atomic, max_timeout_seconds } = entry;
  if (
    !isNonEmptyString(scheme) ||
    !isNonEmptyString(network) ||
    !isNonEmptyString(asset) ||
    !isNonEmptyString(asset_address) ||
    !isNonEmptyString(pay_to) ||
    typeof amount_atomic !== "string" ||
    !DIGITS.test(amount_atomic) ||
    typeof max_timeout_seconds !== "number" ||
    !Number.isSafeInteger(max_timeout_seconds) ||
    max_timeout_seconds <= 0 ||
    !isPlainObject(extra)
  ) {
    return null;
  }
  return { scheme, network, asset, asset_address, extra, pay_to, amount_atomic, max_timeout_seconds };
}

/** Pass = `requirements: null` with a subscription; challenge = a non-empty, well-formed
 * `requirements` array plus `sign_in_chains` (absent on a Lago without sign-in-with-x on gate
 * checks). Anything else throws `LagoApiError` `unexpected_answer`. A pass's
 * `subscription_started_at` is lenient: absent or unreadable gives null, and the call is stamped
 * at serve time. */
export function parseGateCheck(body: unknown): GateCheck {
  const answer = isPlainObject(body) ? body.gate_check : undefined;
  if (!isPlainObject(answer)) throw unexpectedAnswer("gate_checks");

  if (answer.requirements === null) {
    if (isNonEmptyString(answer.external_subscription_id)) {
      return {
        kind: "pass",
        externalSubscriptionId: answer.external_subscription_id,
        subscriptionStartedAt: epochMsOrNull(answer.subscription_started_at),
      };
    }
    throw unexpectedAnswer("gate_checks");
  }

  const { requirements: entries, sign_in_chains: chains } = answer;
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    !Array.isArray(chains) ||
    !chains.every((chain) => typeof chain === "string")
  ) {
    throw unexpectedAnswer("gate_checks");
  }
  const requirements: LagoRequirement[] = [];
  for (const entry of entries) {
    const requirement = parseRequirement(entry);
    if (requirement === null) throw unexpectedAnswer("gate_checks");
    requirements.push(requirement);
  }
  return { kind: "challenge", requirements, signInChains: [...(chains as string[])] };
}

/** A `settled` answer must name its transaction and subscription; `pending` may not. Anything
 * else throws `LagoApiError` `unexpected_answer`, except `subscription_started_at`: absent (an
 * older Lago) or unreadable, it is null and the paid call is stamped at serve time, rather than
 * refused after its payment moved. */
export function parseSettlement(body: unknown): Settlement {
  const answer = isPlainObject(body) ? body.x402_settlement : undefined;
  if (isPlainObject(answer)) {
    const {
      status,
      replayed,
      network,
      transaction_hash: transactionHash,
      payer_address: payerAddress,
      external_subscription_id: externalSubscriptionId,
      subscription_started_at: subscriptionStartedAt,
      reconcile_after: reconcileAfter,
    } = answer;
    const wellFormed =
      (status === "settled" || status === "pending") &&
      typeof replayed === "boolean" &&
      isNonEmptyString(network) &&
      isNonEmptyString(payerAddress) &&
      isStringOrNull(transactionHash) &&
      isStringOrNull(externalSubscriptionId) &&
      isStringOrNull(reconcileAfter);
    if (
      wellFormed &&
      (status === "pending" ||
        (isNonEmptyString(transactionHash) && isNonEmptyString(externalSubscriptionId)))
    ) {
      return {
        status,
        replayed,
        network,
        transactionHash,
        payerAddress,
        externalSubscriptionId,
        subscriptionStartedAt: epochMsOrNull(subscriptionStartedAt),
        reconcileAfter,
      };
    }
  }
  throw unexpectedAnswer("credit_purchases");
}

/** Lago entries → `accepts[]`. `asset` is the token address (`asset_address`), never Lago's
 * asset code; `extra` is a deep copy, otherwise unchanged. */
export function renderAccepts(reqs: LagoRequirement[]): PaymentRequirements[] {
  return reqs.map((req) => ({
    scheme: req.scheme,
    // CAIP-2 as Lago sends it (`app/services/x402/network.rb`); the type is a template literal.
    network: req.network as Network,
    amount: req.amount_atomic,
    asset: req.asset_address,
    payTo: req.pay_to,
    maxTimeoutSeconds: req.max_timeout_seconds,
    extra: structuredClone(req.extra),
  }));
}

function signInChain(chainId: string): SignInChain[] {
  if (chainId.startsWith("eip155:")) return [{ chainId, type: "eip191" }];
  if (chainId.startsWith("solana:")) return [{ chainId, type: "ed25519" }];
  return [];
}

/** The sign-in challenge for one 402. `domain`/`uri` come only from the configured origin and
 * `resourceUrl` (never from request headers); fresh nonce and `issuedAt` every time. */
export function renderSignIn(o: {
  origin: URL;
  resourceUrl: string;
  statement: string;
  signInChains: string[];
}): SignInExtension {
  return {
    info: {
      domain: o.origin.host,
      uri: o.resourceUrl,
      statement: o.statement,
      version: "1",
      nonce: newNonce(),
      issuedAt: new Date().toISOString(),
    },
    supportedChains: o.signInChains.flatMap(signInChain),
    schema: signInSchema(),
  };
}

/** The one builder of a 402's `resource` object, also used for the `resource` the gate resets
 * in the payment it forwards to E8, so both are the same bytes. Only `ResourceInfo`'s keys, in
 * this order, undefined ones omitted, `tags` copied. Idempotent. */
export function renderResource(r: Omit<ResourceInfo, "tags"> & { tags?: readonly string[] }): ResourceInfo {
  const { url, description, mimeType, serviceName, tags, iconUrl } = r;
  return withoutUndefined({
    url,
    description,
    mimeType,
    serviceName,
    tags: tags === undefined ? undefined : [...tags],
    iconUrl,
  });
}

/** The `PAYMENT-REQUIRED` header value. `resource` goes through `renderResource`; an undefined
 * `error` is omitted. */
export function paymentRequiredHeader(o: {
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions: Record<string, unknown>;
  error?: string;
}): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    ...(o.error === undefined ? {} : { error: o.error }),
    resource: renderResource(o.resource),
    accepts: o.accepts,
    extensions: o.extensions,
  });
}

/** The `PAYMENT-RESPONSE` header value for a settled purchase. */
export function paymentResponseHeader(s: Settlement): string {
  if (s.status !== "settled" || s.transactionHash === null) {
    throw new TypeError("lago-x402: PAYMENT-RESPONSE needs a settled purchase");
  }
  return encodePaymentResponseHeader({
    success: true,
    transaction: s.transactionHash,
    network: s.network as Network,
    payer: s.payerAddress,
  });
}

/** `PAYMENT-SIGNATURE` → a v2 payment with object `accepted` and `payload`, else `null`.
 * Every error is swallowed and never surfaced: V8's `JSON.parse` SyntaxError quotes its
 * input, which may hold a signature. */
export function decodePaymentHeader(v: string): PaymentPayload | null {
  try {
    const payment: unknown = decodePaymentSignatureHeader(v);
    if (
      isPlainObject(payment) &&
      payment.x402Version === 2 &&
      isPlainObject(payment.accepted) &&
      isPlainObject(payment.payload)
    ) {
      return payment as PaymentPayload;
    }
  } catch {
    // Deliberately empty: see above.
  }
  return null;
}

/** `SIGN-IN-WITH-X` → the JSON object exactly as sent (no schema parsing, no key stripping or
 * reordering: Lago reads `siwx` from the raw body), else `null`. Errors swallowed as above. */
export function decodeSignInHeader(v: string): Record<string, unknown> | null {
  try {
    if (!Base64EncodedRegex.test(v)) return null;
    const proof: unknown = JSON.parse(safeBase64Decode(v));
    return isPlainObject(proof) ? proof : null;
  } catch {
    return null;
  }
}

/** 128 random bits as 32 lowercase hex characters (Lago: `/\A[A-Za-z0-9]{8,64}\z/`). */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The configured origin plus the request target's pathname. The target is parsed against a
 * dummy base, so an absolute-form or `//host` target can never contribute a host. Only a
 * rooted pathname is appended: a non-special scheme (`foo:@host/p`, `mailto:x`) parses to an
 * opaque path with no leading "/", which would extend the origin's authority. Anything else
 * (or an unparseable target) gives the origin's root. */
export function resourceUrl(origin: URL, target: string): string {
  let pathname = "/";
  try {
    pathname = new URL(target, "http://placeholder.invalid").pathname;
  } catch {
    // Unparseable target: the origin's root.
  }
  return origin.origin + (pathname.startsWith("/") ? pathname : "/");
}
