import { describe, expect, it } from "vitest";
import {
  mapCreditPurchaseRefusal,
  mapGateCheckRefusal,
  retryAfterFrom,
  DEFAULT_RETRY_AFTER_SECONDS,
  type Decision,
} from "../../src/error-map.js";
import { LagoApiError } from "../../src/errors.js";
import { forbidden, notFound, thirdPartyError, unauthorized, validationErrors } from "../support/fixtures.js";

type Answer = { status: number; body: unknown };
const v = (details: Record<string, string[]>): Answer => ({ status: 422, body: validationErrors(details) });
const badRequest: Answer = { status: 400, body: { status: 400, error: "BadRequest: nope" } };

interface Row {
  name: string;
  answer: Answer;
  expected: Record<string, unknown>;
  report?: boolean;
}

const unavailable = { kind: "refuse", status: 503, error: "unavailable" };
const pending = { kind: "refuse", status: 503, error: "payment_pending", retryAfterSeconds: 30 };

describe("mapGateCheckRefusal (E7)", () => {
  const rows: Row[] = [
    {
      name: "siwx error",
      answer: v({ siwx: ["signature_invalid"] }),
      expected: { kind: "refuse", status: 401, error: "sign_in_rejected", reason: "signature_invalid" },
    },
    {
      name: "siwx nonce_already_used",
      answer: v({ siwx: ["nonce_already_used", "x"] }),
      expected: { kind: "refuse", status: 401, error: "sign_in_rejected", reason: "nonce_already_used" },
    },
    {
      name: "buyer_not_recognized",
      answer: v({ base: ["buyer_not_recognized"] }),
      expected: { kind: "refuse", status: 403, error: "buyer_not_recognized" },
    },
    { name: "credit_purchase_pending", answer: v({ base: ["credit_purchase_pending"] }), expected: pending },
    {
      name: "amount_above_maximum",
      answer: v({ amount_cents: ["amount_above_maximum"] }),
      expected: unavailable,
      report: true,
    },
    ...[
      "plan_currency_not_supported",
      "plan_not_usage_only",
      "charge_not_targeted",
      "charge_not_invoiceable",
      "allowed_origins_not_configured",
      "wallet_not_x402_enabled",
      "customer_not_refreshable",
      "subscription_not_active",
      "agent_address_family_unsupported",
    ].map((code): Row => ({
      name: `config ${code}`,
      answer: v({ base: [code] }),
      expected: unavailable,
      report: true,
    })),
    {
      name: "input 422",
      answer: v({ connection_code: ["value_is_mandatory"] }),
      expected: unavailable,
      report: true,
    },
    {
      name: "connection_not_found",
      answer: { status: 404, body: notFound("connection") },
      expected: unavailable,
      report: true,
    },
    {
      name: "plan_not_found",
      answer: { status: 404, body: notFound("plan") },
      expected: unavailable,
      report: true,
    },
    {
      name: "third_party_error",
      answer: { status: 422, body: thirdPartyError() },
      expected: unavailable,
      report: true,
    },
    { name: "400", answer: badRequest, expected: unavailable, report: true },
    { name: "401", answer: { status: 401, body: unauthorized() }, expected: unavailable, report: true },
    {
      name: "403 write",
      answer: { status: 403, body: forbidden("write_action_not_allowed_for_x402") },
      expected: unavailable,
      report: true,
    },
    {
      name: "403 feature",
      answer: { status: 403, body: forbidden("feature_unavailable") },
      expected: unavailable,
      report: true,
    },
    { name: "500", answer: { status: 500, body: "<html>" }, expected: unavailable, report: true },
    { name: "unknown 422 code", answer: v({ base: ["something_new"] }), expected: unavailable, report: true },
    {
      name: "payment field never challenges on E7",
      answer: v({ payment: ["invalid_exact_evm_signature"] }),
      expected: unavailable,
      report: true,
    },
  ];

  it.each(rows)("$name", ({ answer, expected, report }) => {
    const d = mapGateCheckRefusal(answer);
    expect(d).toMatchObject(expected);
    if (d.kind !== "refuse") throw new Error("expected refuse");
    if (report) {
      expect(d.report).toBeInstanceOf(LagoApiError);
      expect((d.report as LagoApiError).endpoint).toBe("gate_checks");
      expect((d.report as LagoApiError).status).toBe(answer.status);
    } else {
      expect(d.report).toBeUndefined();
    }
  });

  it("a 503 pending carries no extra fields", () => {
    expect(mapGateCheckRefusal(v({ base: ["credit_purchase_pending"] }))).toEqual({
      kind: "refuse",
      status: 503,
      error: "payment_pending",
      retryAfterSeconds: 30,
    });
  });
});

describe("mapCreditPurchaseRefusal (E8)", () => {
  const rows: Row[] = [
    {
      name: "recorded_as_invoice_payment",
      answer: v({ payment: ["recorded_as_invoice_payment"] }),
      expected: { kind: "refuse", status: 409, error: "payment_already_used" },
      report: true,
    },
    {
      name: "payment_requirements amount_above_maximum",
      answer: v({ payment_requirements: ["amount_above_maximum"] }),
      expected: unavailable,
      report: true,
    },
    {
      name: "buyer_not_recognized",
      answer: v({ base: ["buyer_not_recognized"] }),
      expected: { kind: "refuse", status: 403, error: "buyer_not_recognized" },
    },
    { name: "credit_purchase_pending", answer: v({ base: ["credit_purchase_pending"] }), expected: pending },
    {
      name: "payment_already_recorded",
      answer: v({ base: ["payment_already_recorded"] }),
      expected: pending,
    },
    { name: "invoice_payment_pending", answer: v({ base: ["invoice_payment_pending"] }), expected: pending },
    ...[
      "buyer_external_id_taken",
      "wallet_not_x402_enabled",
      "subscription_not_active",
      "subscription_external_id_taken",
      "wallet_limit_reached",
    ].map((code): Row => ({
      name: `config ${code}`,
      answer: v({ base: [code] }),
      expected: unavailable,
      report: true,
    })),
    {
      name: "wallet field",
      answer: v({ wallet: ["currency_not_supported"] }),
      expected: unavailable,
      report: true,
    },
    {
      name: "plan_code field",
      answer: v({ plan_code: ["value_is_mandatory"] }),
      expected: unavailable,
      report: true,
    },
    {
      name: "wallet_code field",
      answer: v({ wallet_code: ["value_is_mandatory"] }),
      expected: unavailable,
      report: true,
    },
    {
      name: "connection_not_found",
      answer: { status: 404, body: notFound("connection") },
      expected: unavailable,
      report: true,
    },
    {
      name: "third_party_error",
      answer: { status: 422, body: thirdPartyError() },
      expected: unavailable,
      report: true,
    },
    { name: "400", answer: badRequest, expected: unavailable, report: true },
    { name: "401", answer: { status: 401, body: unauthorized() }, expected: unavailable, report: true },
    {
      name: "403",
      answer: { status: 403, body: forbidden("feature_unavailable") },
      expected: unavailable,
      report: true,
    },
    { name: "429", answer: { status: 429, body: {} }, expected: unavailable, report: true },
    {
      name: "unknown base code",
      answer: v({ base: ["something_new"] }),
      expected: unavailable,
      report: true,
    },
  ];

  it.each(rows)("$name", ({ answer, expected, report }) => {
    for (const attempt of [1, 2] as const) {
      const d = mapCreditPurchaseRefusal(answer, attempt);
      expect(d).toMatchObject(expected);
      if (d.kind !== "refuse") throw new Error("expected refuse");
      if (report) {
        expect(d.report).toBeInstanceOf(LagoApiError);
        expect((d.report as LagoApiError).endpoint).toBe("credit_purchases");
      } else {
        expect(d.report).toBeUndefined();
      }
    }
  });

  it.each([
    "unsupported_scheme",
    "unsupported_network",
    "unsupported_asset",
    "invalid_amount",
    "invalid_authorization",
    "invalid_exact_evm_signature",
    "invalid_asset",
  ])("payment/payment_requirements code %s is a fresh 402 carrying it", (code) => {
    expect(mapCreditPurchaseRefusal(v({ payment: [code] }), 1)).toEqual({ kind: "challenge", error: code });
    expect(mapCreditPurchaseRefusal(v({ payment_requirements: [code] }), 2)).toEqual({
      kind: "challenge",
      error: code,
    });
  });

  it("unknown codes on payment/payment_requirements are a fresh 402 but unknown base codes are 503", () => {
    expect(mapCreditPurchaseRefusal(v({ payment: ["brand_new_reason"] }), 1)).toEqual({
      kind: "challenge",
      error: "brand_new_reason",
    });
    expect(mapCreditPurchaseRefusal(v({ base: ["brand_new_reason"] }), 1)).toMatchObject(unavailable);
  });

  it("a payment error whose codes are all unsafe or absent is unavailable, never a challenge", () => {
    expect(mapCreditPurchaseRefusal(v({ payment: ["has space"] }), 1)).toMatchObject(unavailable);
    expect(mapCreditPurchaseRefusal({ status: 422, body: validationErrors({}) }, 1)).toMatchObject(
      unavailable,
    );
  });

  it("credit_grant_failed is retry on attempt 1 and 503 on attempt 2, never challenge", () => {
    const a = v({ base: ["credit_grant_failed"] });
    expect(mapCreditPurchaseRefusal(a, 1)).toEqual({ kind: "retry", why: "grant" });
    const d = mapCreditPurchaseRefusal(a, 2);
    expect(d).toMatchObject(pending);
    expect(d.kind === "refuse" && d.report).toBeInstanceOf(LagoApiError);
  });

  it.each([500, 502, 503, 504, 599])(
    "%i is a lost answer: retry once, then 503 payment_pending",
    (status) => {
      const a = { status, body: "<html>bad gateway</html>" };
      expect(mapCreditPurchaseRefusal(a, 1)).toEqual({ kind: "retry", why: "lost" });
      const d = mapCreditPurchaseRefusal(a, 2);
      expect(d).toMatchObject(pending);
      expect(d.kind === "refuse" && (d.report as LagoApiError).status).toBe(status);
    },
  );

  it("a 422 naming several fields never becomes a challenge unless purely payment/payment_requirements", () => {
    const others: Record<string, string[]>[] = [
      { base: ["buyer_not_recognized"] },
      { wallet: ["x"] },
      { base: ["credit_grant_failed"] },
      { plan_code: ["x"] },
    ];
    for (const other of others) {
      const d = mapCreditPurchaseRefusal(v({ payment: ["invalid_exact_evm_signature"], ...other }), 1);
      expect(d.kind).toBe("refuse");
      expect(d).toMatchObject(unavailable);
    }
    expect(mapCreditPurchaseRefusal(v({ payment: ["a"], payment_requirements: ["b"] }), 1)).toEqual({
      kind: "challenge",
      error: "a",
    });
    // payment wins over payment_requirements whatever the key order.
    expect(mapCreditPurchaseRefusal(v({ payment_requirements: ["b"], payment: ["a"] }), 1)).toEqual({
      kind: "challenge",
      error: "a",
    });
  });

  it("amount_above_maximum and recorded_as_invoice_payment win inside a payment-only 422", () => {
    expect(
      mapCreditPurchaseRefusal(v({ payment: ["x"], payment_requirements: ["amount_above_maximum"] }), 1),
    ).toMatchObject(unavailable);
    expect(
      mapCreditPurchaseRefusal(
        v({ payment: ["recorded_as_invoice_payment"], payment_requirements: ["y"] }),
        1,
      ),
    ).toMatchObject({ status: 409 });
  });

  it("an E8 answer that is not a validation envelope never challenges", () => {
    expect(
      mapCreditPurchaseRefusal({ status: 422, body: { error_details: { payment: ["x"] } } }, 1),
    ).toMatchObject(unavailable);
    expect(mapCreditPurchaseRefusal({ status: 422, body: null }, 1)).toMatchObject(unavailable);
  });
});

describe("retryAfterFrom", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("is 30 by name", () => expect(DEFAULT_RETRY_AFTER_SECONDS).toBe(30));
  it.each([
    ["2026-01-01T00:01:30Z", 90],
    ["2026-01-01T00:00:00.100Z", 1],
    ["2025-12-31T00:00:00Z", 1],
    ["2026-01-01T00:00:00Z", 1],
    ["2026-01-01T00:00:30.001Z", 31],
    ["2026-01-02T00:00:00Z", 3600],
    ["2026-01-01T01:00:00Z", 3600],
    ["garbage", 30],
    ["", 30],
    [null, 30],
  ])("%s -> %s", (input, out) => {
    expect(retryAfterFrom(input, now)).toBe(out);
  });
  it("is 30 for a non-finite now", () => expect(retryAfterFrom("2026-01-01T00:01:30Z", NaN)).toBe(30));
});
