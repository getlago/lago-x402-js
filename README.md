# lago-x402

Charge AI agents per call for your API, with [x402](https://www.x402.org) payments and [Lago](https://www.getlago.com) prepaid credits. Middleware for Express, Hono and Next.js.

An agent without credits gets an HTTP 402 offering a top-up in USDC. It pays, Lago turns the payment into credits in a wallet of its own, and from then on the agent signs in and is served from those credits. After each served call, the middleware sends Lago one usage event with what the call consumed, and Lago draws it from the agent's credits at your plan's price.

```text
                                       ┌─────────────┐  gate check,         ┌──────┐
  agent ── request ──────────────────► │  lago-x402  │  credit purchase ──► │ Lago │ ──► facilitator ──► chain
       ◄─ 402 / 401 / 503, or served ─ │ middleware  │                      └──────┘
                                       └──────┬──────┘                          ▲
                                              │ served                          │ one usage event,
                                              ▼                                 │ after the response
                                        your handler ─── usage ─────────────────┘
```

Authored in TypeScript, ships compiled JavaScript with `.d.ts` types.

> **Requires a lago-api with sign-in-with-x on gate checks.** See [Before you start](#before-you-start-set-up-lago).

## What it does

- Gates each route you attach it to: every request is checked with Lago before your handler runs.
- Speaks x402 v2 to agents: a `PAYMENT-REQUIRED` challenge with your top-up offer and a sign-in-with-x challenge. A paid request goes to Lago, which verifies and settles it through the facilitator of your x402 connection, then grants the credits.
- Serves signed-in agents from their credits while those cover the route's estimated call cost.
- Sends one usage event per served call, after the response, with the usage your handler reports. Retries are idempotent.
- Checks every route against Lago at boot, and refuses to start on a configuration Lago cannot bill.
- Fails closed: when Lago gives no clear answer, the request is not served.

## What it does not do

- **Match paths.** You attach the middleware to each paid route through your framework's own router. It never reads a path to decide anything.
- **Hold keys or move money.** Lago verifies and settles every payment through the facilitator configured in your x402 connection.
- **Set prices.** The price of a unit lives in your Lago plan; the middleware sends units.
- **Meter streams.** One usage value per call, read once the response has gone out.
- **Run on edge runtimes.** Node only: Express, Hono on `@hono/node-server`, and the Next.js Node runtime.
- **Speak x402 v1.**
- **Cache.** Every request asks Lago; there is no cached offer and no nonce store.
- **Read environment variables.** Everything comes from the config you pass.

## Install

```bash
npm install lago-x402
```

Requires Node `^20.19` or `>=22.12`, plus one of `express` (4.21+ or 5), `hono` (4.6+) with `@hono/node-server`, or `next` (16). The package is ESM; a CommonJS app can `require()` it on those Node versions. Its one runtime dependency is `@x402/core`.

With TypeScript and Express, also install `@types/express`: the types of `lago-x402/express` import Express's own.

## Before you start: set up Lago

1. **A lago-api with sign-in-with-x on gate checks.** At the time of writing (October 2026) it lives on lago-api's `feat/x402/gate-check-sign-in` branch; `main` still takes an unproven `agent_address` and ignores the sign-in. `createLagoX402` refuses at boot a Lago whose challenge has no `sign_in_chains`, with the reason _"this Lago does not support sign-in-with-x on gate checks"_.
2. **A premium license**, with the organization's `x402_payments` feature flag and the `events_targeting_wallets` premium integration. Without wallet targeting, gate checks answer `charge_not_targeted`.
3. **An x402 connection.** Its `code` is your `connectionCode`. It needs:
   - a CDP (Coinbase Developer Platform) API key;
   - networks from one environment: Base Sepolia and/or Solana devnet for testing, or Base and/or Solana mainnet;
   - payout addresses that are CDP accounts of that key's project (Lago verifies them when you save);
   - `allowed_origins` containing your public origin, the `origin` of your config, port included: `https://…`, or `http://localhost`, `http://127.0.0.1` or `http://[::1]` in development. Without it every sign-in is refused (`allowed_origins_not_configured`), and the middleware answers 503.
4. **A plan per route, usage-only and in USD**: no subscription fee, no fixed charges, no minimum commitment and no charge minimum. Its charge on the route's metric must accept target wallets (`accepts_target_wallet: true`). Charge in arrears: Lago refuses a pay-in-advance charge that is not invoiceable (`charge_not_invoiceable`).
5. **A billable metric per route**: `sum_agg` on `field_name: "value"`, with no expression, not recurring. Each call's usage event carries its usage in `properties.value`.
6. **An API key.** If your organization restricts keys with API permissions, it needs `x402` write, `event` write and `billable_metric` read.

Lago creates the rest itself on an agent's first top-up: a customer for the paying address, the route's wallet, and a subscription to the route's plan. That needs `auto_create_customers` on the connection; without it, an address Lago does not know gets 403 `buyer_not_recognized`.

Wallet balances move on Lago's clock: the gate sees the wallet's last refreshed ongoing usage plus the calls in flight. Lago refreshes it every `LAGO_WALLET_ONGOING_BALANCE_REFRESH_INTERVAL_SECONDS` (a lago-api setting, 5 minutes by default).

[`scripts/live-setup.mjs`](scripts/live-setup.mjs) creates a metric, a plan and a connection like these through Lago's API. Read it as a worked example.

## Quickstart

### 1. Configure your routes

One config for the whole app. Each route has a name, used to attach it below, and the Lago objects that bill it.

```ts
// lago.ts
import type { LagoX402Config } from "lago-x402";

export const config: LagoX402Config = {
  apiUrl: "https://api.getlago.com/api/v1", // or your self-hosted Lago's /api/v1
  apiKey: process.env.LAGO_API_KEY!,
  connectionCode: "agents", // your x402 connection in Lago
  origin: "https://api.example.com", // the public origin agents call, in the connection's allowed_origins
  routes: {
    generate: {
      billableMetric: "generated_tokens", // sum_agg on "value"
      planCode: "agents_usage", // usage-only, USD
      walletCode: "agent_credits",
      topUpAmountCents: 100, // an agent without credits pays $1.00 to top up
      estimatedCallCostCents: 2, // served from credits while they cover 2¢
      wallet: { name: "Agent credits", rateAmount: "0.01" }, // 1 credit = 1¢
    },
  },
};
```

### 2. Attach the gate to a route

#### Express

```ts
// server.ts
import express from "express";
import { createLagoX402 } from "lago-x402";
import { lagoX402 } from "lago-x402/express";
import { generate } from "./generate.js"; // your code
import { config } from "./lago.js";

const x402 = await createLagoX402(config); // checks every route against Lago before serving

const app = express();
app.use(express.json());

app.post("/v1/generate", lagoX402(x402, "generate"), async (req, res) => {
  const result = await generate(req.body);
  res.locals.lagoUsage = result.tokens; // the units this call consumed
  res.json(result);
});

const server = app.listen(3000);

process.once("SIGTERM", () => {
  // Stop taking requests, then deliver the usage events still in flight (up to 10 s).
  server.close(() => void x402.close());
});
```

Express 4.21+ and 5. Nothing is ever thrown into Express: an unexpected failure answers 503 and never serves.

#### Hono

```ts
// server.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createLagoX402 } from "lago-x402";
import { lagoX402, type LagoX402Variables } from "lago-x402/hono";
import { generate } from "./generate.js"; // your code
import { config } from "./lago.js";

const x402 = await createLagoX402(config);

const app = new Hono<{ Variables: LagoX402Variables }>();

app.post("/v1/generate", lagoX402(x402, "generate"), async (c) => {
  const result = await generate(await c.req.json());
  c.set("lagoUsage", result.tokens); // the units this call consumed
  return c.json(result);
});

const server = serve({ fetch: app.fetch, port: 3000 });

process.once("SIGTERM", () => {
  server.close(() => void x402.close());
});
```

Hono 4.6+ on Node, served by `@hono/node-server`: the call is billed once the Node response has gone out, with the status that went out.

#### Next.js

App Router route handlers on the Node runtime (the default), Next 16.

```ts
// x402.ts: one instance for the whole app
import { createLagoX402 } from "lago-x402";
import { config } from "./lago";

// Not awaited: each request awaits it, and answers 503 until the routes are checked.
export const x402 = createLagoX402(config);
```

```ts
// app/api/generate/route.ts
import { withLagoX402 } from "lago-x402/next";
import { generate } from "../../../generate"; // your code
import { x402 } from "../../../x402";

export const POST = withLagoX402(x402, "generate", async (req) => {
  const result = await generate(await req.json());
  return { response: Response.json(result), usage: result.tokens };
});
```

Create the instance once, in a module every route file imports, as above. Each `createLagoX402(...)` checks every configured route against Lago at boot and keeps its own queue of usage events: one per route file would boot the whole config once per file, and leave a queue per file for `close()` to drain.

The handler returns `{ response, usage }`. A bare `Response` reports no usage, so the call is served unbilled and `usage.extract` is reported. The event goes out through Next's `after()`, once the response has gone out.

**`next build` evaluates route modules.** With `createLagoX402` at module scope, as above, the build machine boots against Lago while Next collects page data: it needs the config and network access to Lago at build time. Without the config, Next prints the unhandled `LagoX402ConfigError` and the build still completes. To boot on the first request instead, hand `withLagoX402` a lazy promise-like:

```ts
// x402.ts: one lazy instance for the whole app; route files import it as above
import { createLagoX402, type LagoX402 } from "lago-x402";
import { config } from "./lago";

let instance: Promise<LagoX402> | undefined;
export const x402: PromiseLike<LagoX402> = {
  then(onfulfilled, onrejected) {
    instance ??= createLagoX402(config); // first request only; never at `next build`
    return instance.then(onfulfilled, onrejected);
  },
};
```

The first request then waits for the boot checks, and a route name that is not configured is found per request (503, reported as `gate.check`) rather than when the handler is wrapped.

## How a request is handled

1. **No credentials.** One gate check, then `402` with `PAYMENT-REQUIRED`, `Cache-Control: no-store` and body `{}`. The header offers the top-up (`topUpAmountCents` in USDC) on each network of your connection, and a sign-in-with-x challenge. Its `domain` and `uri` come from your configured `origin` and the request's path, never from the `Host` header, and every 402 carries a fresh nonce (16 random bytes).
2. **`SIGN-IN-WITH-X`.** One gate check carrying the sign-in proof, which Lago verifies and then uses up, whatever the answer: a proof works once. The call is served from the agent's credits when they cover `estimatedCallCostCents`; otherwise the agent gets a 402 to top up.
3. **`PAYMENT-SIGNATURE`.** A fresh gate check, then the payment must match one of the fresh offers exactly: same scheme, network, asset, amount, pay-to, timeout and `extra` (only Solana's `extra.feePayer` may differ). A payment for a changed amount, pay-to or terms gets a fresh 402 (`stale_challenge`), and nothing is charged. A matching payment goes to Lago's credit purchase, which verifies and settles it, creates the agent's customer, wallet and subscription on its first purchase, and grants the credits. The call is served with `PAYMENT-RESPONSE`, once: the same payment presented again gets 409 `payment_already_settled`.

When a request carries both headers, the payment wins and the sign-in is ignored. Served responses get `private` merged into their `Cache-Control`, whatever your handler set. On Next.js and Hono, a response that cannot carry it (no HTTP status, as `Response.error()`) is replaced by 503 `unavailable`, or by 503 `payment_pending` after a payment.

**A payment serves one request.** Lago answers a payment it has already settled from its record, before checking anything else, and recognizes it by its authorization, not its signature: anyone who reads a settled authorization from the chain could present it again. So the middleware serves that answer only on its own retry of the credit purchase, after a lost answer, a 5xx or `credit_grant_failed`. A settled payment presented in a new request, by the agent or anyone else, gets 409 `payment_already_settled`: nothing is served or billed. An agent whose paid request got 503 `payment_pending` does not resend the payment: it waits `Retry-After`, then starts over, signs in, and is served from the credits the payment bought.

A request served from credits costs one gate check; a paid one, a gate check and a credit purchase (plus at most one retry of the purchase). Nothing is cached between requests.

**Put a rate limiter in front of the gate.** Every request to a gated route costs a gate check, even one without credentials or with a payment header that cannot be decoded: nothing is cached, by design. On a connection with Solana networks, each challenge also makes Lago read the facilitator's fee payer (CDP's `/supported`), so a flood of anonymous requests can exhaust CDP's rate limit; Lago then answers `third_party_error`, and paying agents get 503 `unavailable` until it recovers. Limit requests per client (IP address, API key) before they reach the middleware.

## Configuration

### `createLagoX402(config)`

| Field             | Required | Meaning                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiUrl`          | yes      | Your Lago API base, including `/api/v1`. An http(s) URL without credentials, query or fragment. The API key is sent only here, never across a redirect.                                                                                                                                                                                            |
| `apiKey`          | yes      | Your Lago API key.                                                                                                                                                                                                                                                                                                                                 |
| `connectionCode`  | yes      | The code of your x402 connection.                                                                                                                                                                                                                                                                                                                  |
| `origin`          | yes      | Your public origin, exactly as agents call it: `https://host[:port]` without a path (`http://` only for `localhost`, `127.0.0.1` and `[::1]`). It must be in the connection's `allowed_origins`. The sign-in challenge and the 402's `resource.url` are built from it; the official sign-in client refuses a challenge for a host it did not call. |
| `routes`          | yes      | `{ [name]: route }`, at least one. Names match `/^[A-Za-z0-9_.:-]{1,64}$/`.                                                                                                                                                                                                                                                                        |
| `signInStatement` | no       | The statement in the sign-in message. Default `"Sign in to use your prepaid credits."`; one line of at most 256 UTF-8 bytes.                                                                                                                                                                                                                       |
| `timeouts`        | no       | `{ gateCheckMs, creditPurchaseMs, eventMs }`. See [Timeouts](#timeouts).                                                                                                                                                                                                                                                                           |
| `onError`         | no       | `(err, where) => void`. See [Error policy](#error-policy).                                                                                                                                                                                                                                                                                         |

### Routes

| Field                                                       | Required | Meaning                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billableMetric`                                            | yes      | The code of the route's billable metric. Usage events carry it as their `code`.                                                                                                                                                                      |
| `planCode`                                                  | yes      | The usage-only USD plan an agent is subscribed to on its first top-up.                                                                                                                                                                               |
| `walletCode`                                                | yes      | The wallet Lago creates for each agent, which top-ups fill and usage events target.                                                                                                                                                                  |
| `topUpAmountCents`                                          | yes      | What an agent pays to top up, in US cents: the amount every 402 offers. A positive integer.                                                                                                                                                          |
| `estimatedCallCostCents`                                    | yes      | What one call is expected to cost, in US cents. Lago serves a signed-in agent from its credits while its wallet balance, less the usage Lago already counted and the calls in flight, covers it; otherwise the agent gets a 402. A positive integer. |
| `wallet.name`                                               | yes      | The name of the wallet Lago creates.                                                                                                                                                                                                                 |
| `wallet.rateAmount`                                         | yes      | The dollar value of one credit, as a decimal string with at most 5 decimals: `"1"` is one credit per dollar, `"0.01"` one per cent.                                                                                                                  |
| `wallet.paidTopUpMinAmountCents`, `paidTopUpMaxAmountCents` | no       | Limits on paid top-ups to that wallet. `topUpAmountCents` must not exceed the maximum.                                                                                                                                                               |
| `resource`                                                  | no       | `{ description, mimeType, serviceName, tags, iconUrl }`, describing the route in its 402 and in the Bazaar.                                                                                                                                          |
| `discoverable`, `discovery`                                 | no       | Bazaar listing. See [Bazaar discovery](#bazaar-discovery).                                                                                                                                                                                           |

### Boot checks

`createLagoX402` validates the config locally first: a bad value rejects with a `LagoX402ConfigError` before any network call, and no error message ever echoes a config value. Then it checks every route against Lago, concurrently:

1. the billable metric must be `sum_agg` on `value`, with no expression, not recurring;
2. a gate check without sign-in must answer a challenge with sign-in chains.

If Lago refuses any route, the promise rejects with one `LagoX402ConfigError` naming every refused route and why, after reporting it (`onError(err, "boot")` and the log line). An unreachable Lago is not a refusal. On a 5xx, 408, 429, network error, timeout or `third_party_error`, the promise resolves; that route answers 503 `unavailable` and its check is retried in the background, from 1 s doubling to 60 s, reporting `boot` for each failed attempt. The retry timers never keep the process alive; a check already in flight can, until it ends: at most twice `gateCheckMs` (the metric read, then the gate check).

The adapters take the instance or the promise. Given an instance, attaching a route name that is not configured throws `LagoX402ConfigError` at once. Given the promise, each request awaits it: 503 until it resolves, and 503 for good if it rejected (your own `await createLagoX402(...)` surfaces the error).

## Reporting usage

Your handler reports how many units of the route's metric the call consumed:

| Framework | How                                                                          |
| --------- | ---------------------------------------------------------------------------- |
| Express   | `res.locals.lagoUsage = n`, before the response ends                         |
| Hono      | `c.set("lagoUsage", n)`, on an app typed with `LagoX402Variables`            |
| Next.js   | return `{ response, usage: n }` (a `LagoX402Result`) instead of a `Response` |

- One `POST /events` per served call whose status is below 400, sent after the response has gone out, never batched. It carries the route's metric as `code`, the subscription Lago named for the agent as `external_subscription_id`, and `properties: { value: String(n), target_wallet_code: <walletCode> }`.
- `transaction_id` (a UUID) and `timestamp` (seconds with millisecond precision) are fixed when the call is served and resent unchanged on every retry, so Lago counts the event once.
- A status of 400 or more sends no event.
- `n` must be a finite number, 0 or more. When it is missing or invalid, or reading it throws, no event is sent and `usage.extract` is reported: that call was served unbilled.
- Express and Hono bill once the response has finished, or when the client goes away after the headers were sent. Next bills through `after()`, which runs even when the client went away first.

## Shutting down

`await x402.close({ timeoutMs })` stops the background boot retries, then waits for the usage events still being delivered, at most `timeoutMs` (10 s by default), keeping Node alive meanwhile. Call it once your server has stopped taking requests, as in the quickstarts.

On Next.js, `next start` holds the deliveries as `after()` work through SIGTERM. On serverless platforms, the function's `maxDuration` bounds them: allow handler time + ~45 s.

## Timeouts

| Option                      | Default | Bounds                                                   |
| --------------------------- | ------- | -------------------------------------------------------- |
| `timeouts.gateCheckMs`      | 5 s     | each gate check, and each request of the boot checks     |
| `timeouts.creditPurchaseMs` | 45 s    | the whole credit purchase, its one retry included        |
| `timeouts.eventMs`          | 10 s    | each attempt to deliver a usage event                    |
| `close({ timeoutMs })`      | 10 s    | how long `close()` waits for the usage events still owed |

Values are positive integers in milliseconds, up to 2,147,483,647.

A paid request runs a gate check and then the credit purchase. **Agents' HTTP clients, and every proxy, load balancer or platform limit in front of your app, must allow about 45 s on a paid request.**

## Answers and errors

### What the agent gets

Refusals are JSON, `{"error": "<code>"}` (plus `"reason"` on a 401), with `Cache-Control: no-store`. A 402's body is `{}`; its `PAYMENT-REQUIRED` header carries the offer, and an `error` when a payment was refused.

| Lago answers                                                                                                                                                                                                                                                                                                                                                                                                                                             | The agent gets                                                                                                                 | `onError` where                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Gate check passes a signed-in agent                                                                                                                                                                                                                                                                                                                                                                                                                      | served; the usage event goes to the subscription the gate check named                                                          | —                                          |
| Gate check passes a request without a sign-in, or without `external_subscription_id`                                                                                                                                                                                                                                                                                                                                                                     | 503 `unavailable`                                                                                                              | `gate.check`                               |
| Gate check challenges                                                                                                                                                                                                                                                                                                                                                                                                                                    | 402                                                                                                                            | —                                          |
| Credit purchase settles the payment, or, on the middleware's own retry after a lost answer, a 5xx or `credit_grant_failed`, answers it from its record of that payment                                                                                                                                                                                                                                                                                   | served with `PAYMENT-RESPONSE`; the usage event goes to the subscription the purchase named                                    | —                                          |
| Credit purchase answers a payment it had already settled (`replayed`) on the first attempt: the payment was presented again in a new request                                                                                                                                                                                                                                                                                                             | 409 `payment_already_settled`; not served, nothing billed                                                                      | —                                          |
| Gate check refuses the sign-in (any `siwx` code, `nonce_already_used` included), or `SIGN-IN-WITH-X` cannot be decoded                                                                                                                                                                                                                                                                                                                                   | 401 `sign_in_rejected`, with the `reason`                                                                                      | —                                          |
| `buyer_not_recognized` (gate check or credit purchase)                                                                                                                                                                                                                                                                                                                                                                                                   | 403 `buyer_not_recognized`                                                                                                     | —                                          |
| Gate check `credit_purchase_pending`; credit purchase `pending`, `credit_purchase_pending`, `payment_already_recorded` or `invoice_payment_pending`                                                                                                                                                                                                                                                                                                      | 503 `payment_pending` + `Retry-After` (Lago's `reconcile_after` for a pending settlement, clamped to 1–3600 s; otherwise 30 s) | —                                          |
| Credit purchase refuses the payment on its first attempt (`payment` or `payment_requirements` errors: facilitator rejection, stale terms, malformed payment); the payment matches no fresh offer (`stale_challenge`); `PAYMENT-SIGNATURE` cannot be decoded (`invalid_payment`)                                                                                                                                                                          | a fresh 402 with `error`; nothing charged                                                                                      | —                                          |
| The same refusal on the credit purchase's retry (after a lost answer, a 5xx or `credit_grant_failed`)                                                                                                                                                                                                                                                                                                                                                    | 503 `payment_pending` + `Retry-After: 30`, never a 402                                                                         | `gate.purchase`                            |
| Credit purchase `payment_requirements: amount_above_maximum`                                                                                                                                                                                                                                                                                                                                                                                             | 503 `unavailable`                                                                                                              | `gate.purchase`                            |
| Credit purchase `payment: recorded_as_invoice_payment`                                                                                                                                                                                                                                                                                                                                                                                                   | 409 `payment_already_used`; not retried                                                                                        | `gate.purchase`                            |
| Credit purchase `credit_grant_failed`                                                                                                                                                                                                                                                                                                                                                                                                                    | one retry with the identical request; then 503 `payment_pending` + `Retry-After: 30`                                           | `gate.purchase`, unless the retry recovers |
| Credit purchase answer lost (network error), or any 5xx                                                                                                                                                                                                                                                                                                                                                                                                  | one retry within the 45 s budget (when at least 1 s is left); then 503 `payment_pending` + `Retry-After: 30`                   | `gate.purchase`                            |
| Credit purchase times out (45 s)                                                                                                                                                                                                                                                                                                                                                                                                                         | 503 `payment_pending` + `Retry-After: 30`                                                                                      | `gate.purchase`                            |
| Credit purchase answers a 200 the middleware cannot read, anything fails after the credit purchase was called, or (Next.js, Hono) the handler's response to a paid call cannot be made private                                                                                                                                                                                                                                                           | 503 `payment_pending` + `Retry-After: 30` (money may have moved)                                                               | `gate.purchase`                            |
| Configuration refusals (`plan_*`, `charge_*`, `wallet_not_x402_enabled`, `subscription_not_active`, `subscription_external_id_taken`, `buyer_external_id_taken`, `wallet_limit_reached`, wallet-shape errors, `allowed_origins_not_configured`, gate check `amount_above_maximum`, `agent_address_family_unsupported`, `customer_not_refreshable`), `third_party_error`, `connection_not_found`, input 422s, 400, 401 or 403 from Lago, any other answer | 503 `unavailable`                                                                                                              | `gate.check` or `gate.purchase`            |
| Gate check unreachable, or times out (5 s)                                                                                                                                                                                                                                                                                                                                                                                                               | 503 `unavailable`                                                                                                              | `gate.check`                               |
| Route not active (boot checks still running or retrying, or refused), or not configured                                                                                                                                                                                                                                                                                                                                                                  | 503 `unavailable`                                                                                                              | `gate.check` when not configured           |

### Usage events

| What happens                                                                                | The middleware                                                    | `onError` where |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------- |
| Lago answers 2xx, or a duplicate (`422`, `transaction_id: value_already_exist`)             | counts the event delivered                                        | —               |
| A network error, a timeout, or Lago answers 5xx, 408 or 429                                 | retries (4 attempts, backoff 0.5, 1 and 2 s ± 20 %), then reports | `usage.send`    |
| Lago answers any other 4xx, or the queue is full (16 events in flight and 1,000 queued)     | drops the event                                                   | `usage.send`    |
| The handler reported no usage or an invalid one, or reading it threw, on a status below 400 | sends no event                                                    | `usage.extract` |

## Error policy

The gate fails closed and metering never breaks a response. When the middleware cannot get a clear answer from Lago, the request is not served: it answers 503: `unavailable`, or `payment_pending` once money may have moved. It never answers 402 after a payment may have settled. Once a call is served, nothing that happens afterwards can change its response.

Every failure is reported through `onError` and logged with `console.warn("[lago-x402] <where> failed: <message>")`, so it never passes in silence, even without an `onError`. A throwing `onError` is ignored. Wire your own observability there:

```ts
const x402 = await createLagoX402({
  ...config,
  onError: (err, where) => Sentry.captureException(err, { tags: { lago_x402: where } }),
});
```

`where` names the stage:

| `where`         | What happened                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot`          | A route's boot check failed: Lago refused it (`createLagoX402` rejects), or Lago was unreachable (the check is retried, and reported per failed attempt).                   |
| `gate.check`    | A gate check failed or Lago refused the route's configuration, or a request named a route that is not configured. The agent got 503 `unavailable`.                          |
| `gate.purchase` | A credit purchase failed, or its outcome is unknown, or a paid call's response could not be served. The agent got 503 or 409. Money may have moved: these are worth a look. |
| `usage.extract` | A served call reported no usage, or an invalid one. No event was sent: that call is unbilled.                                                                               |
| `usage.send`    | A usage event was not delivered: Lago refused it, every attempt failed, or the queue was full.                                                                              |

`usage.extract` is the one to alert on: a handler that forgets to report usage serves its calls for free, and nothing else looks wrong.

Messages carry only route names, Lago endpoint names, HTTP statuses and Lago error codes: never the API key, a payment or sign-in header, or a response body. The errors are exported for `instanceof` checks:

| Error                  | Fields                                                         | Raised for                                                                   |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `LagoX402ConfigError`  | `route` (or `null`), `reason`                                  | an invalid config, a route Lago refused, a route name that is not configured |
| `LagoApiError`         | `endpoint`, `status`, `code`, `errorCodes`                     | an answer from Lago that refused or could not be read                        |
| `LagoUnreachableError` | `endpoint`, `reason` (`"timeout"`, `"network"`)                | a request to Lago that got no answer                                         |
| `LagoX402UsageError`   | `reason` (`"missing"`, `"invalid"`, `"threw"`, `"queue_full"`) | a usage report that could not become an event                                |

`endpoint` is one of `gate_checks`, `credit_purchases`, `events` or `billable_metrics` (the `LagoEndpoint` type).

## Bazaar discovery

A route can be listed in the x402 Bazaar, the facilitator's catalogue of paid resources:

```ts
import type { LagoX402Route } from "lago-x402";

const search: LagoX402Route = {
  billableMetric: "searches",
  planCode: "agents_usage",
  walletCode: "agent_credits",
  topUpAmountCents: 100,
  estimatedCallCostCents: 1,
  wallet: { name: "Agent credits", rateAmount: "0.01" },
  resource: {
    description: "Web search for agents: 0.2¢ per query, prepaid in $1.00 top-ups.",
    mimeType: "application/json",
    serviceName: "Example Search",
    tags: ["search", "0.2c-per-query"],
    iconUrl: "https://api.example.com/icon.png",
  },
  discoverable: true,
  discovery: {
    method: "GET",
    queryParams: { q: "usage-based billing" },
    inputSchema: { properties: { q: { type: "string" } }, required: ["q"] },
    output: { example: { results: [{ title: "Example", url: "https://example.com" }] } },
  },
};
```

- `discoverable: true` requires `discovery`: the `method`, either `GET`, `HEAD` or `DELETE` with optional `queryParams`, or `POST`, `PUT` or `PATCH` with a `bodyType` (`json`, `form-data` or `text`) and an optional `body`; an optional `inputSchema`; and an optional `output` with an `example` object and its `schema`.
- The route's 402 carries the official `bazaar` extension, and the payment forwarded to Lago carries the same one, so the facilitator catalogues the resource when a payment settles. A route that is not discoverable strips any `bazaar` extension an agent adds.
- **The listed price is the top-up**, the 402's `accepts[].amount`, not what one call costs. Put the per-call rate in `resource.description` and `resource.tags`.
- Static routes only: the declaration has no path parameters (no `routeTemplate`), and `method` comes from config, never from the request.
- What the facilitator would silently drop is refused at boot instead: a `serviceName` that is not 1–32 printable ASCII characters; more than 5 `tags`, or a tag that is not 1–32 printable ASCII characters or repeats another (ignoring case); an `iconUrl` that is not an absolute http(s) URL of at most 2,048 characters, without credentials, on a host that is not an IP literal, a loopback name, all digits or a hex literal; a `description` over 500 characters.

## For agent builders

An API behind lago-x402 speaks standard x402 v2 with the sign-in-with-x extension. With the official TypeScript client:

```ts
// agent.ts
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createSIWxClientExtension } from "@x402/extensions/sign-in-with-x";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(account));
// Sign in, so calls are served from the credits a top-up bought instead of paying again.
client.registerExtension(createSIWxClientExtension({ signers: [account] }));
// The stock client refuses any payment above $1 unless you raise its cap.
client.setSpendControls({ maxAmountPerPayment: "$5" });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const res = await fetchWithPayment("https://api.example.com/v1/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Hello" }),
});
console.log(res.status, await res.json());
```

- **Sign in.** Without the sign-in-with-x client extension, every call is a new top-up. Stock clients sign in after the first 402, so a call served from credits costs the API two gate checks.
- **Python agents need `httpx`.** The sync `requests` client cannot run the extension's hooks.
- **Raise the spend cap** when the top-up is above $1: the official `@x402/core` client refuses larger USDC payments by default.
- **Allow about 45 s** on the request that carries the payment.
- **Read the answer:**
  - `402`: pay or sign in; the `PAYMENT-REQUIRED` header's `error` says why a payment was refused.
  - `401 sign_in_rejected`, with a `reason`: the sign-in proof was refused. Sign the next 402's challenge.
  - `403 buyer_not_recognized`: Lago does not know the paying address and will not onboard it.
  - `409 payment_already_used`: this payment was already recorded against an invoice. Do not resend it.
  - `409 payment_already_settled`: this payment already settled and served its request; it never serves another. Sign in to use the credits it bought.
  - `503 payment_pending`, with `Retry-After`: the payment may have gone through. Do not resend it: wait `Retry-After`, then start over. A stock client with the sign-in extension signs in and is served from the credits the payment bought once Lago has granted them (another `503 payment_pending` until then). A payment that already settled, resent, gets `409 payment_already_settled`.
  - `503 unavailable`: the API cannot check with Lago right now. Try again later.

## Measured behaviours and limitations

1. **The stock x402 client caps payments at $1.** `@x402/core` 2.28's client refuses any USDC payment above $1 (`DEFAULT_MAX_AMOUNT_PER_PAYMENT`) unless the agent raises `spendControls.maxAmountPerPayment` (measured). Keep `topUpAmountCents` at 100 or less, or tell agent builders to raise it.
2. **Solana fee payers rotate.** Measured live, `extra.feePayer` changed between gate checks: 4 distinct fee payers in 10 calls. The payment match ignores `extra.feePayer` on `solana:*` networks; Lago and the facilitator check it.
3. **Clocks must agree.** Measured live, an integer-second event timestamp dated the paid call before the subscription its top-up opened in the same second, and Lago never billed it. Timestamps therefore keep millisecond precision; measured again, the paid call's event then landed 78 ms after the subscription started, and was billed. Keep your server's clock NTP-synced with Lago's: a clock lagging by more than the time between the credit purchase answering and the call being served would still date that call before its subscription.
4. **Next.js keeps delivering after SIGTERM.** Measured: `next start` (Next 16.4.1) holds the usage delivery as `after()` work through SIGTERM. On serverless platforms the function's `maxDuration` bounds it (not tested): allow handler time + ~45 s.
5. **Next.js boots at build, and bills clients that left.** `next build` evaluates route modules, so a module-scope `createLagoX402(...)` boots against Lago at build time (see [Next.js](#nextjs) for the lazy alternative). A client that disconnects before the handler returns is still billed on Next, since `after()` runs anyway; Express and Hono bill only once the headers were sent.
6. **Hono needs `@hono/node-server`.** Node with `@hono/node-server` is the supported setup. Without its bindings (`app.request()`, other runtimes), the call is billed once the middleware sees the final response, and a client leaving cannot be seen. Tested: hono 4.13.13 with @hono/node-server 2.1.5; the `^4.6.0` floor works with @hono/node-server 1.x.
7. **Framework versions.** Express 4 and 5 are both tested. Next.js 16 only (tested on 16.4.1).
8. **Agents must sign in.** Without the sign-in-with-x client extension every call is a top-up. Python agents need `httpx`. Stock clients sign in first, so a funded call costs two gate checks.
9. **Long paths break sign-in.** A request path long enough to push the sign-in `uri` past Lago's 512-character limit makes that agent's sign-in fail (401).
10. **The Bazaar lists the top-up.** The listed price is necessarily `accepts[].amount`, the top-up; put the per-call rate in `description` and `tags`. Static routes only (no `routeTemplate`). An invalid `serviceName`, `tags`, `iconUrl` or `description` is refused at boot.
11. **Usage values are sent as `String(n)`.** Very large or very small numbers go out in exponent form (`1e+21`).
12. **Lago always settles.** The middleware never records a payment settled elsewhere: lago-api has no such record mode yet, and every payment goes through Lago's credit purchase.
13. **A local Lago behind mkcert TLS** needs Node to trust the mkcert root: set `NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"` in the process environment. There is no TLS option in the library's config.
14. **Changing an offer while a payment is pending.** If you change a route's `topUpAmountCents`, or the connection's pay-to, between an agent's `503 payment_pending` and its next attempt, that attempt gets the new offer, and a payment signed for the old one matches nothing (`stale_challenge`). An agent that signs in is served from its first payment's credits once Lago has granted them; one that does not sign in, as a stock client without the sign-in extension, pays the new top-up. The first payment's credits are kept in its wallet either way.

## Development

```bash
git clone https://github.com/getlago/lago-x402-js
cd lago-x402-js
npm install
npm run lint && npm run format:check && npm run typecheck
npm run build
npm test               # unit tests: no network, loopback only
npm run test:package   # npm pack, then require() and import() of every subpath
npm run test:next      # a real `next build && next start` (after `npm run build`)
```

### Live test

`npm run test:live` runs the three legs against a real Lago on Base Sepolia: a 402, a top-up paid by an agent without sign-in (should Lago still be settling it, the agent waits and signs in rather than resending the payment), the same key signing in and served from its credits, the paid call's `PAYMENT-SIGNATURE` sent again and refused with 409 `payment_already_settled`, and both usage events found in Lago. It is skipped unless `LAGO_API_URL`, `LAGO_API_KEY` and `X402_BUYER_EVM_PRIVATE_KEY` (a funded Base Sepolia buyer) are set. Optional: `LAGO_X402_CONNECTION_CODE`, `LIVE_PLAN_CODE`, `LIVE_METRIC_CODE`, `LIVE_WALLET_CODE`, `LIVE_ORIGIN` (default `http://localhost:4021`), `LIVE_TOP_UP_CENTS` (default 3) and `LIVE_WALLET_TIMEOUT_MS`.

Set Lago up once with `node scripts/live-setup.mjs`. It reads `LAGO_API_URL`, `LAGO_API_KEY`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `LIVE_EVM_PAYOUT` and, optionally, `LIVE_SVM_PAYOUT`, and creates the metric, the plan and the connection through Lago's API.

Testnets only: the test refuses any offer outside Base Sepolia and Solana devnet, and each run spends one top-up (3¢ by default) of Base Sepolia USDC, which CDP's faucet provides. Keep the credentials in your shell environment, never in a file in this repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest.

## Security

- The Lago API key is sent only to `apiUrl`, never across a redirect. The library reads no environment variables.
- `PAYMENT-SIGNATURE` and `SIGN-IN-WITH-X` are bearer credentials. The middleware never logs them or puts them in an error; make sure your own request logging does not either.
- A payment Lago already settled is never served again: presented in a new request, by anyone and under any signature, it gets 409 `payment_already_settled`.
- Put a rate limiter in front of the gate: see [How a request is handled](#how-a-request-is-handled).
- The sign-in challenge and the 402's `resource.url` come from your configured `origin`, never from `Host` or `X-Forwarded-Host`.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
