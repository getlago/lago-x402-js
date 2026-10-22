/** `lago-x402/next` in a real Next.js 16 app: the fixture in next-app/ is built with `next build`
 * and served with `next start` on 127.0.0.1, against the fake Lago. The fixture imports the built
 * package, so `npm run build` comes first (`npm run build && npm run test:next`).
 *
 * Proves the adapter loads inside a real Next build and bills through Next's own `after()`: the
 * usage event goes out only once the response has gone out (a response held mid-body sends
 * nothing), and its delivery, which the fake Lago delays by 2 s, outlives the request. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment } from "@x402/fetch";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evmAgent } from "../support/agent.js";
import { startFakeLago, type FakeLago, type RecordedRequest } from "../support/fake-lago.js";
import { gateCheckChallenge, gateCheckPass, settlement } from "../support/fixtures.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const APP = fileURLToPath(new URL("./next-app", import.meta.url));
const NEXT_BIN = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));
const PATH = "/api/paid";
const EVENT_DELAY_MS = 2000;
/** Far more than loopback socket buffers hold: the response cannot finish while it is unread. */
const HELD_BYTES = 32 * 1024 * 1024;

const apiKey = "test-key-" + randomUUID();
const PAYER = "0x00000000000000000000000000000000000b0b01";
/** A decodable SIGN-IN-WITH-X header: the gate forwards it, the fake Lago passes it. */
const SIGN_IN = Buffer.from(JSON.stringify({ address: PAYER })).toString("base64");
const SUBSCRIPTION = "sub_" + randomUUID();

interface Delivery {
  receivedAt: number;
  answeredAt?: number;
  event: { external_subscription_id: string; code: string; properties: { value: string } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Runs `next <args>` to completion; rejects with its output when it fails. */
function next(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [NEXT_BIN, ...args], { cwd: ROOT, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`next ${args[0]} exited with ${code}:\n${output}`)),
    );
  });
}

/** A POST whose response is paused as soon as its head arrives: its body stays unread. */
function heldPost(url: string, headers: Record<string, string>): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers }, (res) => {
      res.pause();
      resolve(res);
    });
    req.on("error", reject);
    req.end();
  });
}

function readAll(res: IncomingMessage): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    res.on("data", (chunk: Buffer) => (bytes += chunk.length));
    res.on("end", () => resolve(bytes));
    res.on("error", reject);
    res.resume();
  });
}

describe("next build && next start", () => {
  let lago: FakeLago;
  let server: ChildProcess | undefined;
  let output = "";
  let origin: string;
  let deliveries: Delivery[];

  beforeAll(async () => {
    if (!existsSync(new URL("../../dist/next.js", import.meta.url))) {
      throw new Error("the fixture imports the built package: run `npm run build` first");
    }
    lago = await startFakeLago();
    lago.on("gate_checks", (r: RecordedRequest) =>
      (r.json as { gate_check: { siwx?: unknown } }).gate_check.siwx === undefined
        ? { status: 200, body: gateCheckChallenge() }
        : { status: 200, body: gateCheckPass({ external_subscription_id: SUBSCRIPTION }) },
    );
    lago.on("credit_purchases", () => ({
      status: 200,
      body: settlement({ external_subscription_id: SUBSCRIPTION }),
    }));
    lago.on("events", async (r) => {
      const delivery: Delivery = {
        receivedAt: performance.now(),
        event: (r.json as { event: Delivery["event"] }).event,
      };
      deliveries.push(delivery);
      await sleep(EVENT_DELAY_MS);
      delivery.answeredAt = performance.now();
      return { status: 200, body: {} };
    });

    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      LAGO_API_URL: lago.apiUrl,
      LAGO_API_KEY: apiKey,
      LAGO_X402_ORIGIN: origin,
    };
    await next(["build", APP], env);

    const started = spawn(process.execPath, [NEXT_BIN, "start", APP, "-H", "127.0.0.1", "-p", String(port)], {
      cwd: ROOT,
      env,
    });
    server = started;
    started.stdout.on("data", (chunk: Buffer) => (output += chunk));
    started.stderr.on("data", (chunk: Buffer) => (output += chunk));
    await vi.waitFor(
      () => {
        if (started.exitCode !== null) throw new Error(`next start exited:\n${output}`);
        expect(output).toContain("Ready");
      },
      { timeout: 60_000, interval: 100 },
    );
  }, 300_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server!.once("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    }
    await lago?.close();
  });

  beforeEach(() => {
    lago.requests.length = 0;
    deliveries = [];
  });

  it("a stranger gets a 402 on the configured origin, Cache-Control no-store", async () => {
    const res = await fetch(origin + PATH, { method: "POST" });

    expect(res.status).toBe(402);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("{}");
    const pr = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(pr.resource.url).toBe(origin + PATH);
    await sleep(200);
    expect(deliveries).toHaveLength(0);
  });

  it("a paid call is answered with PAYMENT-RESPONSE and private before Lago answers its event, which is still delivered afterwards", async () => {
    const pay = wrapFetchWithPayment(fetch, evmAgent({ signIn: false, maxAmountPerPayment: "$10" }).http);

    const res = await pay(origin + PATH, { method: "POST" });
    const body = (await res.json()) as { served: boolean };
    const respondedAt = performance.now();

    expect(res.status).toBe(200);
    expect(body.served).toBe(true);
    expect(res.headers.get("cache-control")).toBe("private");
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
    expect(lago.requests.filter((r) => r.route === "credit_purchases")).toHaveLength(1);
    // Lago has not answered the event yet: the response never waited for it.
    expect(deliveries.every((d) => d.answeredAt === undefined)).toBe(true);

    await vi.waitFor(() => expect(deliveries[0]?.answeredAt).toBeDefined(), { timeout: 15_000 });
    expect(deliveries[0].answeredAt!).toBeGreaterThan(respondedAt);
    expect(deliveries[0].event).toMatchObject({
      external_subscription_id: SUBSCRIPTION,
      code: "tokens",
      properties: { value: "3" },
    });
    await sleep(500);
    expect(deliveries).toHaveLength(1);
    expect(output).not.toContain("[lago-x402]");
  });

  it("the event goes out through after(): nothing while the response is held mid-body, then once it has gone out", async () => {
    const res = await heldPost(`${origin}${PATH}?bytes=${HELD_BYTES}`, { "SIGN-IN-WITH-X": SIGN_IN });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private");
    // The handler has answered and the head is out, but the body is not: no event yet.
    await sleep(1000);
    expect(deliveries).toHaveLength(0);

    const resumedAt = performance.now();
    expect(await readAll(res)).toBeGreaterThan(HELD_BYTES);

    await vi.waitFor(() => expect(deliveries[0]?.answeredAt).toBeDefined(), { timeout: 15_000 });
    expect(deliveries[0].receivedAt).toBeGreaterThan(resumedAt);
    expect(deliveries[0].answeredAt! - deliveries[0].receivedAt).toBeGreaterThanOrEqual(EVENT_DELAY_MS - 50);
    expect(deliveries[0].event).toMatchObject({
      external_subscription_id: SUBSCRIPTION,
      properties: { value: "3" },
    });
    await sleep(500);
    expect(deliveries).toHaveLength(1);
    expect(output).not.toContain("[lago-x402]");
  });
});
