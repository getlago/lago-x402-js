/** A real `node:http` server on 127.0.0.1 standing in for Lago. It records every request
 * exactly as received (raw body text included) and answers from per-route handlers. */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { billableMetric, gateCheckChallenge, notFound, settlement } from "./fixtures.js";

export type FakeRoute = "gate_checks" | "credit_purchases" | "events" | "billable_metrics";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  json: unknown;
}

export interface FakeAnswer {
  status: number;
  body?: unknown;
  delayMs?: number;
  destroySocket?: boolean;
}

export type FakeHandler = (req: RecordedRequest) => FakeAnswer | Promise<FakeAnswer>;

export interface FakeLago {
  /** Ends in `/api/v1`. */
  apiUrl: string;
  requests: RecordedRequest[];
  on(route: FakeRoute, handler: FakeHandler): void;
  close(): Promise<void>;
}

const PREFIX = "/api/v1";

function routeOf(path: string): FakeRoute | null {
  const pathname = path.split("?")[0];
  if (pathname === `${PREFIX}/x402/gate_checks`) return "gate_checks";
  if (pathname === `${PREFIX}/x402/credit_purchases`) return "credit_purchases";
  if (pathname === `${PREFIX}/events`) return "events";
  if (pathname.startsWith(`${PREFIX}/billable_metrics/`)) return "billable_metrics";
  return null;
}

const defaults: Record<FakeRoute, FakeHandler> = {
  gate_checks: () => ({ status: 200, body: gateCheckChallenge() }),
  credit_purchases: () => ({ status: 200, body: settlement() }),
  events: () => ({ status: 200, body: {} }),
  billable_metrics: () => ({ status: 200, body: billableMetric() }),
};

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function startFakeLago(): Promise<FakeLago> {
  const requests: RecordedRequest[] = [];
  const handlers = new Map<FakeRoute, FakeHandler>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        const recorded: RecordedRequest = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          rawBody,
          json: parseJson(rawBody),
        };
        requests.push(recorded);
        const route = routeOf(recorded.path);
        const answer: FakeAnswer = route
          ? await (handlers.get(route) ?? defaults[route])(recorded)
          : { status: 404, body: notFound("route") };
        if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
        if (answer.destroySocket) {
          req.socket.destroy();
          return;
        }
        const payload = answer.body === undefined ? "" : JSON.stringify(answer.body);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(payload);
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    apiUrl: `http://127.0.0.1:${port}${PREFIX}`,
    requests,
    on: (route, handler) => void handlers.set(route, handler),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
