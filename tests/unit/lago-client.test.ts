import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LagoApiError, LagoUnreachableError, sanitizedLagoCodes } from "../../src/errors.js";
import { LagoClient } from "../../src/lago-client.js";
import { startFakeLago, type FakeLago } from "../support/fake-lago.js";
import {
  forbidden,
  gateCheckChallenge,
  hex32,
  thirdPartyError,
  validationErrors,
} from "../support/fixtures.js";

let lago: FakeLago;
const apiKey = "test-key-" + randomUUID();

beforeEach(async () => {
  lago = await startFakeLago();
});
afterEach(async () => {
  await lago.close();
});

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected rejection");
}

describe("LagoClient", () => {
  it("sends the key only as a Bearer header to apiUrl", async () => {
    const client = new LagoClient(lago.apiUrl + "/", apiKey);
    const res = await client.request("gate_checks", "POST", "/x402/gate_checks", { amount_cents: 500 }, 5000);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(gateCheckChallenge());
    expect(lago.requests).toHaveLength(1);
    const req = lago.requests[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v1/x402/gate_checks");
    expect(req.headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(req.headers.accept).toBe("application/json");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.rawBody).toBe('{"amount_cents":500}');
    expect(req.rawBody).not.toContain(apiKey);
  });

  it("encodes the metric code in the path and sends no body on GET", async () => {
    const client = new LagoClient(lago.apiUrl, apiKey);
    await client.request(
      "billable_metrics",
      "GET",
      `/billable_metrics/${encodeURIComponent("a/b c")}`,
      undefined,
      5000,
    );
    expect(lago.requests[0].path).toBe("/api/v1/billable_metrics/a%2Fb%20c");
    expect(lago.requests[0].rawBody).toBe("");
  });

  it("returns HTTP errors as statuses with parsed bodies, never throwing", async () => {
    lago.on("gate_checks", () => ({
      status: 422,
      body: validationErrors({ amount_cents: ["value_is_invalid"] }),
    }));
    const client = new LagoClient(lago.apiUrl, apiKey);
    const res = await client.request("gate_checks", "POST", "/x402/gate_checks", {}, 5000);
    expect(res.status).toBe(422);
    expect(res.body).toEqual(validationErrors({ amount_cents: ["value_is_invalid"] }));
  });

  it("returns a null body when the answer is not JSON", async () => {
    lago.on("events", () => ({ status: 502 }));
    const client = new LagoClient(lago.apiUrl, apiKey);
    expect(await client.request("events", "POST", "/events", {}, 5000)).toEqual({ status: 502, body: null });
  });

  it("refuses redirects, so a 307 to another loopback server never reaches it", async () => {
    const target = await startFakeLago();
    const redirector: Server = createServer((req, res) => {
      res.writeHead(307, { location: `${target.apiUrl}/events` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const port = (redirector.address() as AddressInfo).port;
    try {
      const client = new LagoClient(`http://127.0.0.1:${port}/api/v1`, apiKey);
      const err = await failure(client.request("events", "POST", "/events", {}, 5000));
      expect(err).toBeInstanceOf(LagoUnreachableError);
      expect((err as LagoUnreachableError).reason).toBe("network");
      expect(target.requests).toHaveLength(0);
    } finally {
      redirector.closeAllConnections();
      await new Promise<void>((r) => redirector.close(() => r()));
      await target.close();
    }
  });

  it("aborts after timeoutMs", async () => {
    lago.on("events", () => ({ status: 200, delayMs: 300 }));
    const client = new LagoClient(lago.apiUrl, apiKey);
    const err = await failure(client.request("events", "POST", "/events", {}, 50));
    expect(err).toBeInstanceOf(LagoUnreachableError);
    expect((err as LagoUnreachableError).reason).toBe("timeout");
    expect((err as LagoUnreachableError).endpoint).toBe("events");
  });

  it("reports a destroyed socket and a closed port as network failures", async () => {
    lago.on("events", () => ({ status: 200, destroySocket: true }));
    const client = new LagoClient(lago.apiUrl, apiKey);
    const err = await failure(client.request("events", "POST", "/events", {}, 5000));
    expect((err as LagoUnreachableError).reason).toBe("network");

    const dead = await startFakeLago();
    const deadUrl = dead.apiUrl;
    await dead.close();
    const err2 = await failure(
      new LagoClient(deadUrl, apiKey).request("events", "POST", "/events", {}, 5000),
    );
    expect((err2 as LagoUnreachableError).reason).toBe("network");
  });

  it("error messages, stacks and util.inspect carry no key and no body marker", async () => {
    const marker = "BODY-MARKER-" + randomUUID();
    const sig = hex32("cd");
    lago.on("credit_purchases", () => ({
      status: 422,
      body: {
        ...thirdPartyError(),
        error: marker,
        extra: sig,
        error_details: { payment: ["invalid_signature"], note: [marker] },
      },
    }));
    const client = new LagoClient(lago.apiUrl, apiKey);
    const res = await client.request(
      "credit_purchases",
      "POST",
      "/x402/credit_purchases",
      { payment: marker },
      5000,
    );
    const apiErr = new LagoApiError("credit_purchases", res.status, res.body);
    lago.on("events", () => ({ status: 200, delayMs: 300 }));
    const timeoutErr = await failure(client.request("events", "POST", "/events", { payment: marker }, 20));
    for (const err of [apiErr, timeoutErr as Error]) {
      const dump = [
        err.message,
        err.stack ?? "",
        inspect(err, { depth: 10 }),
        JSON.stringify(err),
        String(err),
      ].join("\n");
      expect(dump).not.toContain(apiKey);
      expect(dump).not.toContain(marker);
      expect(dump).not.toContain(sig);
      expect((err as { cause?: unknown }).cause).toBeUndefined();
    }
    expect(apiErr.message).toContain("credit_purchases");
    expect(apiErr.message).toContain("422");
    expect(apiErr.message).toContain("third_party_error");
    expect(apiErr.code).toBe("third_party_error");
    expect(apiErr.errorCodes).toEqual({ payment: ["invalid_signature"] });
    expect(inspect(client)).not.toContain(apiKey);
    expect(JSON.stringify(client)).not.toContain(apiKey);
  });
});

describe("sanitizedLagoCodes", () => {
  it("keeps identifier-shaped codes and drops everything else", () => {
    const long = "a".repeat(65);
    const out = sanitizedLagoCodes({
      code: "validation_errors",
      error_details: {
        plan_code: ["value_is_invalid", "plan not found", long, 7, null],
        [long]: ["value_is_invalid"],
        "bad key": ["value_is_invalid"],
        third_party: "coinbase",
        only_bad: ["plan not found"],
      },
    });
    expect(out).toEqual({ code: "validation_errors", errorCodes: { plan_code: ["value_is_invalid"] } });
  });

  it("drops a code that is not identifier-shaped, and tolerates junk", () => {
    expect(sanitizedLagoCodes({ code: "plan not found" })).toEqual({ code: null, errorCodes: {} });
    expect(sanitizedLagoCodes({ code: "a".repeat(65) }).code).toBeNull();
    expect(sanitizedLagoCodes({ code: "a".repeat(64) }).code).toBe("a".repeat(64));
    for (const junk of [null, undefined, "x", 3, [], { error_details: [] }, { error_details: "x" }]) {
      expect(sanitizedLagoCodes(junk)).toEqual({ code: null, errorCodes: {} });
    }
  });

  it("does not let a __proto__ key pollute", () => {
    const body = JSON.parse('{"error_details":{"__proto__":["value_is_invalid"]}}');
    const out = sanitizedLagoCodes(body);
    expect(Object.keys(out.errorCodes)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("maps a 403 envelope", () => {
    expect(sanitizedLagoCodes(forbidden("write_action_not_allowed_for_x402")).code).toBe(
      "write_action_not_allowed_for_x402",
    );
  });
});
