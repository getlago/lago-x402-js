import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { safeBase64Encode } from "@x402/core/utils";
import {
  SIGN_IN_WITH_X,
  buildSIWxSchema,
  createSIWxClientExtension,
  decodeBase58,
} from "@x402/extensions/sign-in-with-x";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import nacl from "tweetnacl";
import { verifyMessage, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LagoApiError } from "../../src/errors.js";
import {
  DEFAULT_SIGN_IN_STATEMENT,
  SIGN_IN_WITH_X as WIRE_SIGN_IN_WITH_X,
  decodePaymentHeader,
  decodeSignInHeader,
  newNonce,
  parseGateCheck,
  parseSettlement,
  paymentRequiredHeader,
  paymentResponseHeader,
  renderAccepts,
  renderSignIn,
  resourceUrl,
  type LagoRequirement,
} from "../../src/wire.js";
import { evmAgent, solanaPayment, solanaSigner } from "../support/agent.js";
import {
  BASE_SEPOLIA,
  FAKE_PAY_TO,
  SOLANA_DEVNET,
  evmRequirement,
  gateCheckChallenge,
  gateCheckPass,
  settlement,
  solanaRequirement,
} from "../support/fixtures.js";
import { lagoSiwxMessage } from "../support/lago-siwx-message.js";

const ORIGIN = new URL("https://api.merchant.example");

/** `X402::SignInWithX::VerifyService::TIMESTAMP_FORMAT` (`\A`/`\z` → `^`/`$`, no `m` flag). */
const LAGO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** `VerifyService::NONCE_FORMAT`. */
const LAGO_NONCE = /^[A-Za-z0-9]{8,64}$/;
/** `VerifyService` REQUIRED_FIELDS + OPTIONAL_FIELDS without `signature`: what `valid_strings?`
 * sums against MAX_FIELDS_SIZE (2,048 bytes), together with `resources`. */
const LAGO_TEXT_FIELDS = [
  "domain",
  "address",
  "uri",
  "version",
  "chainId",
  "type",
  "nonce",
  "issuedAt",
  "statement",
  "expirationTime",
  "notBefore",
  "requestId",
  "signatureScheme",
];

afterEach(() => {
  vi.restoreAllMocks();
});

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

/** A header lookup as the stock client performs it on a response (case-insensitive). */
function headersOf(name: string, value: string): (name: string) => string | null {
  const headers = new Headers({ [name]: value });
  return (n) => headers.get(n);
}

/** An E7 challenge body (`gate_check_serializer.rb`) carrying these requirement entries. */
function challengeBody(entries: object[]) {
  return { gate_check: { ...gateCheckChallenge().gate_check, requirements: entries } };
}

/** Lago requirement entries as `parseGateCheck` hands them to the renderer. */
function requirementsOf(...entries: object[]): LagoRequirement[] {
  const gate = parseGateCheck(challengeBody(entries));
  if (gate.kind !== "challenge") throw new Error("expected a challenge");
  return gate.requirements;
}

/** What the gate composes for one 402: E7 challenge → accepts + sign-in → header. */
function challenge(o: { origin?: URL; target?: string; statement?: string; requirements?: object[] } = {}) {
  const origin = o.origin ?? ORIGIN;
  const url = resourceUrl(origin, o.target ?? "/v1/generate");
  const gate = parseGateCheck(challengeBody(o.requirements ?? [evmRequirement(), solanaRequirement()]));
  if (gate.kind !== "challenge") throw new Error("expected a challenge");
  const accepts = renderAccepts(gate.requirements);
  const signIn = renderSignIn({
    origin,
    resourceUrl: url,
    statement: o.statement ?? DEFAULT_SIGN_IN_STATEMENT,
    signInChains: gate.signInChains,
  });
  const header = paymentRequiredHeader({
    resource: { url },
    accepts,
    extensions: { [SIGN_IN_WITH_X]: signIn },
  });
  return { url, accepts, signIn, header };
}

/** Runs the stock client's 402 hooks on our challenge, exactly as `wrapFetchWithPayment`
 * does before retrying with `SIGN-IN-WITH-X`, and decodes the proof as the gate will. */
async function signInProof(
  http: x402HTTPClient,
  header: string,
  url: string,
): Promise<Record<string, unknown>> {
  const paymentRequired = http.getPaymentRequiredResponse(headersOf("PAYMENT-REQUIRED", header));
  const headers = await http.handlePaymentRequired(paymentRequired, url);
  // The hook names it `sign-in-with-x`; header names are case-insensitive on the wire.
  const proof = new Headers(headers ?? {}).get("SIGN-IN-WITH-X");
  if (proof === null) throw new Error("the agent did not sign in");
  const decoded = decodeSignInHeader(proof);
  if (decoded === null) throw new Error("undecodable proof");
  return decoded;
}

function solanaSignInClient() {
  const signer = solanaSigner();
  const client = new x402Client().registerExtension(createSIWxClientExtension({ signers: [signer] }));
  return { signer, http: new x402HTTPClient(client) };
}

describe("parseGateCheck", () => {
  it("parses a pass and a challenge", () => {
    const pass = gateCheckPass();
    expect(parseGateCheck(pass)).toEqual({
      kind: "pass",
      externalSubscriptionId: pass.gate_check.external_subscription_id,
    });

    const body = gateCheckChallenge({ requirements: [evmRequirement(), solanaRequirement()] });
    expect(parseGateCheck(body)).toEqual({
      kind: "challenge",
      requirements: body.gate_check.requirements,
      signInChains: [BASE_SEPOLIA, SOLANA_DEVNET],
    });
  });

  const challengeWith = (entry: Record<string, unknown>) =>
    challengeBody([{ ...evmRequirement(), ...entry }]);
  const { sign_in_chains: _omitted, ...withoutSignIn } = gateCheckChallenge().gate_check;

  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "gate_check"],
    ["an empty object", {}],
    ["a null gate_check", { gate_check: null }],
    ["an array gate_check", { gate_check: [] }],
    ["a pass without external_subscription_id", gateCheckPass({ external_subscription_id: null })],
    ["a pass with an empty external_subscription_id", gateCheckPass({ external_subscription_id: "" })],
    ["no requirements key", { gate_check: { external_subscription_id: "x402_sub_1" } }],
    ["empty requirements", gateCheckChallenge({ requirements: [] })],
    ["a non-array requirements", { gate_check: { ...gateCheckChallenge().gate_check, requirements: {} } }],
    ["a challenge without sign_in_chains (a Lago without sign-in-with-x)", { gate_check: withoutSignIn }],
    ["a challenge with null sign_in_chains", gateCheckChallenge({ sign_in_chains: null })],
    [
      "a non-string sign-in chain",
      { gate_check: { ...gateCheckChallenge().gate_check, sign_in_chains: [1] } },
    ],
    ["a null entry", { gate_check: { ...gateCheckChallenge().gate_check, requirements: [null] } }],
    ["a missing scheme", challengeWith({ scheme: undefined })],
    ["a numeric network", challengeWith({ network: 84532 })],
    ["a missing asset", challengeWith({ asset: undefined })],
    ["an empty asset_address", challengeWith({ asset_address: "" })],
    ["a missing pay_to", challengeWith({ pay_to: undefined })],
    ["a numeric amount_atomic", challengeWith({ amount_atomic: 5000000 })],
    ["a decimal amount_atomic", challengeWith({ amount_atomic: "5.0" })],
    ["a negative amount_atomic", challengeWith({ amount_atomic: "-1" })],
    ["an empty amount_atomic", challengeWith({ amount_atomic: "" })],
    ["a zero max_timeout_seconds", challengeWith({ max_timeout_seconds: 0 })],
    ["a fractional max_timeout_seconds", challengeWith({ max_timeout_seconds: 1.5 })],
    ["a string max_timeout_seconds", challengeWith({ max_timeout_seconds: "60" })],
    ["a null extra", challengeWith({ extra: null })],
    ["an array extra", challengeWith({ extra: [] })],
  ])("refuses %s as unexpected_answer", (_name, body) => {
    const err = thrown(() => parseGateCheck(body));
    expect(err).toBeInstanceOf(LagoApiError);
    expect(err).toMatchObject({ endpoint: "gate_checks", status: 200, code: "unexpected_answer" });
    expect((err as Error).message).toBe("Lago gate_checks answered 200 (unexpected_answer)");
  });
});

describe("parseSettlement", () => {
  it("parses settled and pending settlements", () => {
    const settled = settlement().x402_settlement;
    expect(parseSettlement({ x402_settlement: settled })).toEqual({
      status: "settled",
      replayed: false,
      network: settled.network,
      transactionHash: settled.transaction_hash,
      payerAddress: settled.payer_address,
      externalSubscriptionId: settled.external_subscription_id,
      reconcileAfter: null,
    });

    const pending = settlement({
      status: "pending",
      replayed: true,
      external_subscription_id: null,
    }).x402_settlement;
    expect(parseSettlement({ x402_settlement: pending })).toEqual({
      status: "pending",
      replayed: true,
      network: pending.network,
      transactionHash: null,
      payerAddress: pending.payer_address,
      externalSubscriptionId: null,
      reconcileAfter: pending.reconcile_after,
    });
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an empty object", {}],
    ["a null x402_settlement", { x402_settlement: null }],
    ["an unknown status", settlement({ status: "failed" as never })],
    ["a string replayed", settlement({ replayed: "false" as never })],
    ["a missing network", settlement({ network: undefined })],
    ["a numeric payer_address", settlement({ payer_address: 1 as never })],
    ["a settled answer without transaction_hash", settlement({ transaction_hash: null })],
    ["a settled answer without external_subscription_id", settlement({ external_subscription_id: null })],
    ["a numeric reconcile_after", settlement({ status: "pending", reconcile_after: 90 as never })],
  ])("refuses %s as unexpected_answer", (_name, body) => {
    const err = thrown(() => parseSettlement(body));
    expect(err).toBeInstanceOf(LagoApiError);
    expect(err).toMatchObject({ endpoint: "credit_purchases", status: 200, code: "unexpected_answer" });
    expect((err as Error).message).toBe("Lago credit_purchases answered 200 (unexpected_answer)");
  });
});

describe("rendering", () => {
  it("renders each Lago entry into the v2 wire shape and copies extra unchanged", () => {
    const evmExtra = { name: "USDC", version: "2", nested: { list: [1, { deep: true }] } };
    const evm = { ...evmRequirement(), extra: evmExtra };
    const sol = solanaRequirement();
    const reqs = requirementsOf(evm, sol);

    const accepts = renderAccepts(reqs);

    expect(accepts).toStrictEqual([
      {
        scheme: "exact",
        network: BASE_SEPOLIA,
        amount: "5000000",
        asset: evm.asset_address,
        payTo: FAKE_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2", nested: { list: [1, { deep: true }] } },
      },
      {
        scheme: "exact",
        network: SOLANA_DEVNET,
        amount: "5000000",
        asset: sol.asset_address,
        payTo: sol.pay_to,
        maxTimeoutSeconds: 60,
        extra: { feePayer: sol.extra!.feePayer },
      },
    ]);
    for (const entry of accepts) {
      expect(Object.keys(entry)).toEqual([
        "scheme",
        "network",
        "amount",
        "asset",
        "payTo",
        "maxTimeoutSeconds",
        "extra",
      ]);
      expect(entry.asset).not.toBe("usdc");
    }
    // A deep copy: the 402 can never alias (or later mutate) Lago's answer.
    expect(accepts[0].extra).not.toBe(reqs[0].extra);
    expect(accepts[0].extra.nested).not.toBe(evmExtra.nested);
    expect(evmExtra).toEqual({ name: "USDC", version: "2", nested: { list: [1, { deep: true }] } });
  });

  it("declares exactly the official sign-in-with-x schema", () => {
    const { info, ...rest } = renderSignIn({
      origin: ORIGIN,
      resourceUrl: resourceUrl(ORIGIN, "/v1/generate"),
      statement: DEFAULT_SIGN_IN_STATEMENT,
      signInChains: [BASE_SEPOLIA],
    });
    expect(Object.keys(rest)).toEqual(["supportedChains", "schema"]);
    expect(rest.schema).toStrictEqual(buildSIWxSchema());
    expect(WIRE_SIGN_IN_WITH_X).toBe(SIGN_IN_WITH_X);
    expect(info.version).toBe("1");
  });

  it("omits resources and never sends an empty statement", async () => {
    const url = resourceUrl(ORIGIN, "/v1/generate");
    const configured = renderSignIn({
      origin: ORIGIN,
      resourceUrl: url,
      statement: "Pay per call with prepaid credits.",
      signInChains: [BASE_SEPOLIA],
    });
    expect(Object.keys(configured.info)).toEqual([
      "domain",
      "uri",
      "statement",
      "version",
      "nonce",
      "issuedAt",
    ]);
    expect(configured.info).toMatchObject({
      domain: "api.merchant.example",
      uri: url,
      statement: "Pay per call with prepaid credits.",
      version: "1",
    });

    const empty = renderSignIn({
      origin: ORIGIN,
      resourceUrl: url,
      statement: "",
      signInChains: [BASE_SEPOLIA],
    });
    expect(DEFAULT_SIGN_IN_STATEMENT).toBe("Sign in to use your prepaid credits.");
    expect(empty.info.statement).toBe(DEFAULT_SIGN_IN_STATEMENT);

    // What the official client signs and sends back carries neither key either.
    const { header } = challenge();
    const proof = await signInProof(evmAgent().http, header, url);
    expect(proof).not.toHaveProperty("resources");
    expect(proof).not.toHaveProperty("expirationTime");
    expect(proof.statement).toBe(DEFAULT_SIGN_IN_STATEMENT);
  });

  it("maps sign_in_chains to eip191 / ed25519 and skips unknown namespaces", () => {
    const mainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const { supportedChains } = renderSignIn({
      origin: ORIGIN,
      resourceUrl: resourceUrl(ORIGIN, "/v1/generate"),
      statement: DEFAULT_SIGN_IN_STATEMENT,
      signInChains: [
        "eip155:8453",
        mainnet,
        "bip122:000000000019d6689c085ae165831e93",
        "cosmos:cosmoshub-4",
        "eip155",
        BASE_SEPOLIA,
        SOLANA_DEVNET,
      ],
    });
    expect(supportedChains).toStrictEqual([
      { chainId: "eip155:8453", type: "eip191" },
      { chainId: mainnet, type: "ed25519" },
      { chainId: BASE_SEPOLIA, type: "eip191" },
      { chainId: SOLANA_DEVNET, type: "ed25519" },
    ]);
  });

  it("nonce is 32 lowercase hex and unique over 10,000 calls", () => {
    const nonces = Array.from({ length: 10_000 }, () => newNonce());
    expect(new Set(nonces).size).toBe(10_000);
    expect(nonces.every((n) => /^[0-9a-f]{32}$/.test(n) && LAGO_NONCE.test(n))).toBe(true);

    const render = () =>
      renderSignIn({
        origin: ORIGIN,
        resourceUrl: resourceUrl(ORIGIN, "/v1/generate"),
        statement: DEFAULT_SIGN_IN_STATEMENT,
        signInChains: [BASE_SEPOLIA],
      }).info.nonce;
    const first = render();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(render()).not.toBe(first);
  });

  it("issuedAt matches Lago's TIMESTAMP_FORMAT", () => {
    const before = Date.now();
    const { info } = renderSignIn({
      origin: ORIGIN,
      resourceUrl: resourceUrl(ORIGIN, "/v1/generate"),
      statement: DEFAULT_SIGN_IN_STATEMENT,
      signInChains: [BASE_SEPOLIA],
    });
    const after = Date.now();

    const match = LAGO_TIMESTAMP.exec(info.issuedAt);
    expect(match).not.toBeNull();
    const at = Date.parse(info.issuedAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    // `VerifyService#parse_time` also requires the captured fields to survive `Time.iso8601`.
    const t = new Date(at);
    expect(match!.slice(1, 7).map(Number)).toEqual([
      t.getUTCFullYear(),
      t.getUTCMonth() + 1,
      t.getUTCDate(),
      t.getUTCHours(),
      t.getUTCMinutes(),
      t.getUTCSeconds(),
    ]);
  });

  it("resourceUrl ignores absolute-form and //host targets", () => {
    const origin = new URL("https://api.merchant.example:8443");
    const cases: [string, string][] = [
      ["/v1/generate?x=1#frag", "https://api.merchant.example:8443/v1/generate"],
      ["https://attacker.example/v1/generate", "https://api.merchant.example:8443/v1/generate"],
      ["http://attacker.example:80/v1/generate?x=1", "https://api.merchant.example:8443/v1/generate"],
      ["//attacker.example/v1/generate", "https://api.merchant.example:8443/v1/generate"],
      ["\\\\attacker.example\\v1\\generate", "https://api.merchant.example:8443/v1/generate"],
      ["https://attacker.example", "https://api.merchant.example:8443/"],
      ["http://[", "https://api.merchant.example:8443/"],
      // Non-special schemes parse to an opaque path with no leading "/": appended as is, it
      // would extend the origin's authority (userinfo, a longer host, a suffix).
      ["foo:@attacker.example/p", "https://api.merchant.example:8443/"],
      ["x:.attacker.example", "https://api.merchant.example:8443/"],
      ["mailto:x", "https://api.merchant.example:8443/"],
      ["javascript:alert(1)", "https://api.merchant.example:8443/"],
      ["data:,x", "https://api.merchant.example:8443/"],
      ["foo://bar", "https://api.merchant.example:8443/"],
    ];
    for (const [target, expected] of cases) {
      const url = resourceUrl(origin, target);
      expect(url).toBe(expected);
      expect(new URL(url).host).toBe(origin.host);
    }
    const local = new URL("http://localhost:3000");
    expect(resourceUrl(local, "/a b")).toBe("http://localhost:3000/a%20b");
    expect(resourceUrl(local, "foo:@attacker.example/p")).toBe("http://localhost:3000/");
  });
});

describe("headers", () => {
  it("round-trips what @x402/core's client encodes", async () => {
    const { url, accepts, signIn, header } = challenge();
    const agent = evmAgent({ maxAmountPerPayment: "$10" });

    // PAYMENT-REQUIRED: the stock client decodes exactly what we rendered.
    const paymentRequired = agent.http.getPaymentRequiredResponse(headersOf("PAYMENT-REQUIRED", header));
    expect(paymentRequired).toStrictEqual({
      x402Version: 2,
      resource: { url },
      accepts,
      extensions: { [SIGN_IN_WITH_X]: signIn },
    });

    const described = decodePaymentRequiredHeader(
      paymentRequiredHeader({
        resource: { url, description: "Generate", mimeType: undefined, tags: ["ai"] },
        accepts,
        extensions: {},
        error: "invalid_exact_evm_payload_signature",
      }),
    );
    expect(Object.keys(described)).toEqual(["x402Version", "error", "resource", "accepts", "extensions"]);
    expect(described.error).toBe("invalid_exact_evm_payload_signature");
    expect(described.resource).toStrictEqual({ url, description: "Generate", tags: ["ai"] });

    // PAYMENT-SIGNATURE signed by the stock EVM client decodes to the payload it encoded.
    const payment = await agent.client.createPaymentPayload(paymentRequired);
    expect(payment.accepted).toStrictEqual(accepts[0]);
    const signature = agent.http.encodePaymentSignatureHeader(payment)["PAYMENT-SIGNATURE"];
    expect(decodePaymentHeader(signature)).toStrictEqual(JSON.parse(JSON.stringify(payment)));

    // Solana, hand-built (agent.ts).
    const solana = solanaPayment(accepts[1], paymentRequired.extensions);
    expect(decodePaymentHeader(encodePaymentSignatureHeader(solana))).toStrictEqual(solana);

    // SIGN-IN-WITH-X: the object exactly as sent, key order and unknown keys kept.
    const proofJson = '{"zeta":"z","address":"a","nested":{"b":1,"a":[2]},"__proto__":{"polluted":1}}';
    const proof = decodeSignInHeader(safeBase64Encode(proofJson));
    expect(JSON.stringify(proof)).toBe(proofJson);
    expect(Object.getPrototypeOf(proof)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // PAYMENT-RESPONSE: what the stock client reads after a settled purchase.
    const settled = parseSettlement(settlement());
    const settle = agent.http.getPaymentSettleResponse(
      headersOf("PAYMENT-RESPONSE", paymentResponseHeader(settled)),
    );
    expect(settle).toStrictEqual({
      success: true,
      transaction: settled.transactionHash,
      network: settled.network,
      payer: settled.payerAddress,
    });
    expect(() => paymentResponseHeader(parseSettlement(settlement({ status: "pending" })))).toThrow();
  });

  it("pins the stock client's $1 default spend cap (top-ups above it need the agent's consent)", async () => {
    const agent = evmAgent();
    const read = (header: string) =>
      agent.http.getPaymentRequiredResponse(headersOf("PAYMENT-REQUIRED", header));

    const fiveDollars = challenge({ requirements: [evmRequirement({ amountCents: 500 })] });
    await expect(agent.client.createPaymentPayload(read(fiveDollars.header))).rejects.toThrow(
      /maxAmountPerPayment/,
    );
    const oneDollar = challenge({ requirements: [evmRequirement({ amountCents: 100 })] });
    await expect(agent.client.createPaymentPayload(read(oneDollar.header))).resolves.toMatchObject({
      x402Version: 2,
      accepted: oneDollar.accepts[0],
    });
  });

  it("returns null and never echoes input for malformed headers", () => {
    const signatureBytes = "cd".repeat(65);
    const leaky = `{"x402Version":2,"payload":{"signature":${signatureBytes}}}`;
    // V8 quotes this input in its SyntaxError: why no decode error may ever escape.
    expect(() => JSON.parse(leaky)).toThrow(signatureBytes.slice(0, 10));

    const accepted = renderAccepts(requirementsOf(evmRequirement()))[0];
    const notJsonObject = ["", "!!!", b64("{bad"), b64("[]"), b64('"x"'), b64("null"), b64(leaky)];
    const notV2Payment = [
      b64(JSON.stringify({ x402Version: 1, accepted, payload: {} })),
      b64(JSON.stringify({ x402Version: "2", accepted, payload: {} })),
      b64(JSON.stringify({ x402Version: 2, payload: {} })),
      b64(JSON.stringify({ x402Version: 2, accepted: [], payload: {} })),
      b64(JSON.stringify({ x402Version: 2, accepted, payload: null })),
      b64(JSON.stringify({ x402Version: 2, accepted })),
    ];
    const consoleCalls = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    for (const value of [...notJsonObject, ...notV2Payment]) {
      expect(decodePaymentHeader(value)).toBeNull();
    }
    for (const value of notJsonObject) {
      expect(decodeSignInHeader(value)).toBeNull();
    }
    expect(consoleCalls.flatMap((spy) => spy.mock.calls)).toEqual([]);
  });
});

describe("cross-implementation: official client ↔ Lago's rebuilt message", () => {
  it("the official EVM client signs our challenge and Lago's rebuilt message recovers its address", async () => {
    // A non-default port too: `domain` must be `origin.host`, as the client checks.
    for (const origin of [ORIGIN, new URL("http://localhost:3000")]) {
      const agent = evmAgent();
      const { url, signIn, header } = challenge({ origin });
      const proof = await signInProof(agent.http, header, url);
      expect(proof).toMatchObject({
        domain: origin.host,
        address: agent.account.address,
        statement: DEFAULT_SIGN_IN_STATEMENT,
        uri: url,
        version: "1",
        chainId: BASE_SEPOLIA,
        type: "eip191",
        nonce: signIn.info.nonce,
        issuedAt: signIn.info.issuedAt,
      });

      const signature = proof.signature as Hex;
      const message = lagoSiwxMessage(proof, { emptyStatementLine: true });
      expect(await verifyMessage({ address: agent.account.address, message, signature })).toBe(true);
      // The check is real: change one field and the address no longer recovers.
      const tampered = lagoSiwxMessage({ ...proof, nonce: newNonce() }, { emptyStatementLine: true });
      expect(await verifyMessage({ address: agent.account.address, message: tampered, signature })).toBe(
        false,
      );
    }
  });

  it("the official Solana sign-in signs our challenge and Lago's rebuilt message verifies with ed25519", async () => {
    const { signer, http } = solanaSignInClient();
    const { url, signIn, header } = challenge();
    const proof = await signInProof(http, header, url);
    expect(proof).toMatchObject({
      domain: ORIGIN.host,
      address: signer.publicKey,
      statement: DEFAULT_SIGN_IN_STATEMENT,
      uri: url,
      version: "1",
      chainId: SOLANA_DEVNET,
      type: "ed25519",
      nonce: signIn.info.nonce,
      issuedAt: signIn.info.issuedAt,
    });

    const signature = decodeBase58(proof.signature as string);
    const publicKey = decodeBase58(proof.address as string);
    expect(publicKey).toEqual(signer.publicKeyBytes);
    const bytes = (text: string) => new TextEncoder().encode(text);
    const message = lagoSiwxMessage(proof, { emptyStatementLine: true });
    expect(nacl.sign.detached.verify(bytes(message), signature, publicKey)).toBe(true);
    const tampered = lagoSiwxMessage(
      { ...proof, uri: ORIGIN.origin + "/other" },
      { emptyStatementLine: true },
    );
    expect(nacl.sign.detached.verify(bytes(tampered), signature, publicKey)).toBe(false);
  });

  it("the challenge's text fields stay under 2,048 bytes", async () => {
    // At the limits the middleware allows: a 512-character statement (config caps it), and a
    // 512-character uri (Lago's per-field cap) on a long host.
    const origin = new URL(`https://${"h".repeat(63)}.merchant.example`);
    const target = "/" + "p".repeat(512 - origin.origin.length - 1);
    const statement = "S".repeat(512);

    for (const http of [evmAgent().http, solanaSignInClient().http]) {
      const { url, header } = challenge({ origin, target, statement });
      expect(url).toHaveLength(512);
      const proof = await signInProof(http, header, url);
      const texts = [
        ...LAGO_TEXT_FIELDS.filter((field) => field in proof).map((field) => proof[field] as string),
        ...((proof.resources as string[] | undefined) ?? []),
      ];
      expect(texts.every((text) => text.length <= 512 && !/[\r\n]/.test(text))).toBe(true);
      const size = texts.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
      expect(size).toBeLessThan(2048);
    }
  });
});
