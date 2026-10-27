/** Answer bodies shaped exactly like lago-api's serializers and error renderers
 * (branch `feat/x402/gate-check-sign-in`). Each fixture cites the file it mirrors.
 * 32-byte hex values are built at runtime, never written as literals. */
import { randomUUID } from "node:crypto";

export const BASE_SEPOLIA = "eip155:84532";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/** Obviously fake payout address (EVM, 40 hex). */
export const FAKE_PAY_TO = "0x00000000000000000000000000000000000a11ce";

/** A 32-byte hex value (tx hash, nonce) built at runtime. */
export function hex32(byte = "ab"): string {
  return "0x" + byte.repeat(32);
}

export interface Requirement {
  scheme: "exact";
  network: string;
  asset: string;
  asset_address: string;
  extra: Record<string, string> | null;
  pay_to: string;
  amount_atomic: string;
  max_timeout_seconds: number;
}

/** Mirrors `app/services/x402/payment_requirements_service.rb#requirement` (EVM branch;
 * `extra` = `Asset#eip712_domain` from `app/services/x402/asset.rb`, Base Sepolia row).
 * `amount_atomic` = cents * 10^4 (USDC has 6 decimals), as a string. */
export function evmRequirement(o: { amountCents?: number; payTo?: string } = {}): Requirement {
  const cents = o.amountCents ?? 500;
  return {
    scheme: "exact",
    network: BASE_SEPOLIA,
    asset: "usdc",
    asset_address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    extra: { name: "USDC", version: "2" },
    pay_to: o.payTo ?? FAKE_PAY_TO,
    amount_atomic: String(cents * 10 ** 4),
    max_timeout_seconds: 60,
  };
}

/** Mirrors the SVM branch of the same method: `extra = {"feePayer" => ...}`. */
export function solanaRequirement(
  o: { amountCents?: number; feePayer?: string; payTo?: string } = {},
): Requirement {
  const cents = o.amountCents ?? 500;
  return {
    scheme: "exact",
    network: SOLANA_DEVNET,
    asset: "usdc",
    asset_address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    extra: { feePayer: o.feePayer ?? "FeePayerFakeFakeFakeFakeFakeFakeFakeFakeFake1" },
    pay_to: o.payTo ?? "PayToFakeFakeFakeFakeFakeFakeFakeFakeFakeFak2",
    amount_atomic: String(cents * 10 ** 4),
    max_timeout_seconds: 60,
  };
}

export interface GateCheck {
  balance_credits: string;
  requirements: Requirement[] | null;
  external_subscription_id: string | null;
  subscription_started_at: string | null;
  sign_in_chains: string[] | null;
}

/** Mirrors `app/serializers/v1/x402/gate_check_serializer.rb`: a challenge carries
 * `requirements` and `sign_in_chains`; `subscription_started_at` (iso8601, milliseconds) goes
 * with `external_subscription_id`. */
export function gateCheckChallenge(o: Partial<GateCheck> = {}): { gate_check: GateCheck } {
  return {
    gate_check: {
      balance_credits: "0.0",
      requirements: [evmRequirement()],
      external_subscription_id: null,
      subscription_started_at: null,
      sign_in_chains: [BASE_SEPOLIA, SOLANA_DEVNET],
      ...o,
    },
  };
}

/** Same serializer, pass branch: `requirements` and `sign_in_chains` are null. */
export function gateCheckPass(o: Partial<GateCheck> = {}): { gate_check: GateCheck } {
  return {
    gate_check: {
      balance_credits: "10.0",
      requirements: null,
      external_subscription_id: "x402_sub_" + randomUUID(),
      subscription_started_at: new Date().toISOString(),
      sign_in_chains: null,
      ...o,
    },
  };
}

export interface Settlement {
  lago_id: string;
  status: "settled" | "pending";
  replayed: boolean;
  network: string;
  transaction_hash: string | null;
  payer_address: string;
  lago_customer_id: string;
  lago_wallet_transaction_id: string | null;
  external_subscription_id: string | null;
  subscription_started_at: string | null;
  credits_granted: string | null;
  settled_amount_cents: number;
  reconcile_after: string | null;
}

/** Mirrors `app/serializers/v1/x402/settlement_serializer.rb`: `transaction_hash` only when
 * settled, `reconcile_after` (iso8601) only when pending, and `external_subscription_id`
 * (`subscription&.external_id`) and `subscription_started_at` (iso8601, milliseconds) null while
 * pending: no subscription exists before the grant. */
export function settlement(o: Partial<Settlement> = {}): { x402_settlement: Settlement } {
  const status = o.status ?? "settled";
  const settled = status === "settled";
  return {
    x402_settlement: {
      lago_id: randomUUID(),
      status,
      replayed: false,
      network: BASE_SEPOLIA,
      transaction_hash: settled ? hex32() : null,
      payer_address: "0x00000000000000000000000000000000000b0b01",
      lago_customer_id: randomUUID(),
      lago_wallet_transaction_id: settled ? randomUUID() : null,
      external_subscription_id: settled ? "x402_sub_" + randomUUID() : null,
      subscription_started_at: settled ? new Date().toISOString() : null,
      credits_granted: settled ? "5.0" : null,
      settled_amount_cents: 500,
      reconcile_after: settled ? null : new Date(Date.now() + 90_000).toISOString().replace(/\.\d+Z$/, "Z"),
      ...o,
    },
  };
}

/** Mirrors `app/serializers/v1/billable_metric_serializer.rb` (no counters, empty filters). */
export function billableMetric(o: Record<string, unknown> = {}): {
  billable_metric: Record<string, unknown>;
} {
  return {
    billable_metric: {
      lago_id: randomUUID(),
      name: "Tokens",
      code: "tokens",
      description: null,
      aggregation_type: "sum_agg",
      weighted_interval: null,
      recurring: false,
      rounding_function: null,
      rounding_precision: null,
      created_at: "2026-10-01T00:00:00Z",
      field_name: "value",
      expression: null,
      filters: [],
      ...o,
    },
  };
}

/** Mirrors `ApiErrors#validation_errors` (`app/controllers/concerns/api_errors.rb`). */
export function validationErrors(details: Record<string, string[]>) {
  return { status: 422, error: "Unprocessable Entity", code: "validation_errors", error_details: details };
}

/** Mirrors `ApiResponses#not_found_error` (`app/controllers/concerns/api_responses.rb`). */
export function notFound(resource: string) {
  return { status: 404, error: "Not Found", code: `${resource}_not_found` };
}

/** Mirrors `ApiErrors#thirdpary_error`; `thirdparty_error` is free text (never surfaced). */
export function thirdPartyError() {
  return {
    status: 422,
    error: "Unprocessable Entity",
    code: "third_party_error",
    error_details: {
      third_party: "coinbase",
      thirdparty_error: "unavailable: free text from the facilitator",
    },
  };
}

/** Mirrors `ApiErrors#forbidden_error`. */
export function forbidden(code: string) {
  return { status: 403, error: "Forbidden", code };
}

/** Mirrors `ApiErrors#unauthorized_error` (default message). */
export function unauthorized() {
  return { status: 401, error: "Unauthorized" };
}
