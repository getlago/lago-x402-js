import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LagoX402ErrorWhere, NormalizedRoute } from "../../src/config.js";
import { LagoApiError, LagoUnreachableError, LagoX402UsageError } from "../../src/errors.js";
import { LagoClient } from "../../src/lago-client.js";
import { createCallBilling, EventSender, type UsageEvent } from "../../src/usage.js";
import { startFakeLago, type FakeAnswer, type FakeLago } from "../support/fake-lago.js";
import { validationErrors } from "../support/fixtures.js";

let lago: FakeLago;
let reports: { err: Error; where: LagoX402ErrorWhere }[];
const report = (err: Error, where: LagoX402ErrorWhere): void => void reports.push({ err, where });
const route = { billableMetric: "tokens", walletCode: "agents_wallet" } as NormalizedRoute;

beforeEach(async () => {
  lago = await startFakeLago();
  reports = [];
});
afterEach(async () => {
  await lago.close();
});

function sender(o: { timeoutMs?: number; maxAttempts?: number } = {}): EventSender {
  const client = new LagoClient(lago.apiUrl, "test-key-" + randomUUID());
  return new EventSender(client, { timeoutMs: 2000, backoffMs: 5, ...o }, report);
}

function answers(...seq: FakeAnswer[]): void {
  let i = 0;
  lago.on("events", () => seq[Math.min(i++, seq.length - 1)]);
}

function event(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    transactionId: randomUUID(),
    externalSubscriptionId: "sub_1",
    code: "tokens",
    timestamp: 1_700_000_000,
    value: "12",
    walletCode: "agents_wallet",
    ...over,
  };
}

async function bill(status: number, usage: () => unknown, s = sender()) {
  const billing = createCallBilling(route, "sub_1", s, report);
  await billing.finish(status, usage);
  return billing;
}

describe("createCallBilling", () => {
  it("sends one event after the response with the exact wire shape", async () => {
    const before = Math.floor(Date.now() / 1000);
    await bill(200, () => 42);
    expect(lago.requests).toHaveLength(1);
    const req = lago.requests[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v1/events");
    const parsed = req.json as { event: Record<string, unknown> };
    expect(Object.keys(parsed)).toEqual(["event"]);
    expect(Object.keys(parsed.event)).toEqual([
      "transaction_id",
      "external_subscription_id",
      "code",
      "timestamp",
      "properties",
    ]);
    expect(parsed.event).toMatchObject({
      external_subscription_id: "sub_1",
      code: "tokens",
      properties: { value: "42", target_wallet_code: "agents_wallet" },
    });
    expect(parsed.event.transaction_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isInteger(parsed.event.timestamp)).toBe(true);
    expect(parsed.event.timestamp as number).toBeGreaterThanOrEqual(before);
    expect(Object.keys((parsed.event as { properties: object }).properties)).toEqual([
      "value",
      "target_wallet_code",
    ]);
    expect(reports).toEqual([]);
  });

  it.each([0, -0])('sends %s as "0"', async (n) => {
    await bill(200, () => n);
    expect(
      (lago.requests[0].json as { event: { properties: { value: string } } }).event.properties.value,
    ).toBe("0");
  });

  it.each([NaN, -1, Infinity, -Infinity, "12", null, 10n, {}])("rejects %s as invalid", async (v) => {
    await bill(200, () => v);
    expect(lago.requests).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(reports[0].where).toBe("usage.extract");
    expect(reports[0].err).toBeInstanceOf(LagoX402UsageError);
    expect((reports[0].err as LagoX402UsageError).reason).toBe("invalid");
    expect(reports[0].err.message).not.toContain(String(v));
  });

  it("reports undefined as missing", async () => {
    await bill(200, () => undefined);
    expect(lago.requests).toHaveLength(0);
    expect((reports[0].err as LagoX402UsageError).reason).toBe("missing");
    expect(reports[0].where).toBe("usage.extract");
  });

  it("reports a throwing reader as threw, without its message or a cause", async () => {
    await bill(200, () => {
      throw new Error("customer secret 4111111111111111");
    });
    expect(lago.requests).toHaveLength(0);
    const err = reports[0].err as LagoX402UsageError;
    expect(err.reason).toBe("threw");
    expect(reports[0].where).toBe("usage.extract");
    expect(err.message).not.toContain("4111");
    expect(err.cause).toBeUndefined();
  });

  it.each([400, 404, 500])("sends nothing and reads nothing for status %i", async (status) => {
    let read = false;
    await bill(status, () => {
      read = true;
      return 5;
    });
    expect(read).toBe(false);
    expect(lago.requests).toHaveLength(0);
    expect(reports).toEqual([]);
  });

  it("finish twice sends once and returns the same promise", async () => {
    const billing = createCallBilling(route, "sub_1", sender(), report);
    const a = billing.finish(200, () => 1);
    const b = billing.finish(200, () => 2);
    expect(b).toBe(a);
    await a;
    expect(lago.requests).toHaveLength(1);
  });

  it("never throws into the caller when onError throws", async () => {
    const throwing = (): void => {
      throw new Error("boom");
    };
    const billing = createCallBilling(route, "sub_1", sender(), throwing);
    await expect(billing.finish(200, () => undefined)).resolves.toBeUndefined();
  });
});

describe("EventSender", () => {
  it("retries keep the bytes identical (500, 500, 200)", async () => {
    answers({ status: 500 }, { status: 500 }, { status: 200, body: {} });
    await bill(200, () => 7);
    expect(lago.requests).toHaveLength(3);
    const raw = lago.requests.map((r) => r.rawBody);
    expect(raw[1]).toBe(raw[0]);
    expect(raw[2]).toBe(raw[0]);
    expect(reports).toEqual([]);
  });

  it("counts 422 value_already_exist as delivered", async () => {
    answers({ status: 422, body: validationErrors({ transaction_id: ["value_already_exist"] }) });
    await sender().send(event());
    expect(lago.requests).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it("gives up after 4 attempts and reports usage.send with the last error", async () => {
    answers({ status: 503 });
    await sender().send(event());
    expect(lago.requests).toHaveLength(4);
    expect(reports).toHaveLength(1);
    expect(reports[0].where).toBe("usage.send");
    expect(reports[0].err).toBeInstanceOf(LagoApiError);
    expect((reports[0].err as LagoApiError).status).toBe(503);
  });

  it.each([
    [400, undefined],
    [401, undefined],
    [403, undefined],
    [404, undefined],
    [422, validationErrors({ value: ["value_is_invalid"] })],
  ])("reports %i at once without retrying", async (status, body) => {
    answers({ status, body });
    await sender().send(event());
    expect(lago.requests).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(reports[0].where).toBe("usage.send");
    expect((reports[0].err as LagoApiError).status).toBe(status);
  });

  it.each([408, 429])("retries %i", async (status) => {
    answers({ status }, { status: 200, body: {} });
    await sender().send(event());
    expect(lago.requests).toHaveLength(2);
    expect(reports).toEqual([]);
  });

  it("retries a dropped socket", async () => {
    answers({ status: 200, destroySocket: true }, { status: 200, body: {} });
    await sender().send(event());
    expect(lago.requests).toHaveLength(2);
    expect(reports).toEqual([]);
  });

  it("aborts each attempt after the event timeout", async () => {
    answers({ status: 200, delayMs: 400 });
    await sender({ timeoutMs: 50, maxAttempts: 2 }).send(event());
    expect(lago.requests).toHaveLength(2);
    expect(reports).toHaveLength(1);
    expect(reports[0].err).toBeInstanceOf(LagoUnreachableError);
    expect((reports[0].err as LagoUnreachableError).reason).toBe("timeout");
  });

  describe("bounds", () => {
    function stub() {
      let current = 0;
      let peak = 0;
      const release: (() => void)[] = [];
      const client = {
        request: () => {
          current++;
          peak = Math.max(peak, current);
          return new Promise<{ status: number; body: unknown }>((resolve) => {
            release.push(() => {
              current--;
              resolve({ status: 200, body: {} });
            });
          });
        },
      } as unknown as LagoClient;
      return { client, peak: () => peak, release };
    }

    it("never has more than 16 in flight; the 1,001st waiting is reported queue_full", async () => {
      const s = stub();
      const snd = new EventSender(s.client, { timeoutMs: 1000, backoffMs: 1 }, report);
      const sends = Array.from({ length: 16 + 1000 + 1 }, () => snd.send(event()));
      await sends[sends.length - 1];
      expect(reports).toHaveLength(1);
      expect((reports[0].err as LagoX402UsageError).reason).toBe("queue_full");
      expect(reports[0].where).toBe("usage.send");
      expect(s.release).toHaveLength(16);
      while (s.release.length > 0) {
        s.release.shift()!();
        await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
      await Promise.all(sends);
      expect(s.peak()).toBe(16);
      expect(reports).toHaveLength(1);
    });

    it("drain resolves true when idle and false at its timeout, then true once done", async () => {
      const s = stub();
      const snd = new EventSender(s.client, { timeoutMs: 1000, backoffMs: 1 }, report);
      expect(await snd.drain(50)).toBe(true);
      const p = snd.send(event());
      expect(await snd.drain(30)).toBe(false);
      const drained = snd.drain(2000);
      s.release.shift()!();
      await p;
      expect(await drained).toBe(true);
    });
  });
});
