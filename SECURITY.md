# Security

## Reporting a vulnerability

**Please don't open a public GitHub issue.** Email `security@getlago.com` instead. Coordinated disclosure is appreciated.

## What the middleware guarantees

These are the rules a report can hold us to:

- **The Lago API key goes only to `apiUrl`.** It travels in the `Authorization` header of requests to the configured `apiUrl`, never across a redirect (redirects are refused), and never into an error, a log line or a response. The library reads no environment variables.
- **`PAYMENT-SIGNATURE` and `SIGN-IN-WITH-X` are bearer credentials, and are never logged.** A `PAYMENT-SIGNATURE` is a signed payment authorization: whoever captures one can present it as the agent's payment until the authorization expires. A `SIGN-IN-WITH-X` header is a sign-in proof: whoever holds one can sign in as the agent until Lago uses up its nonce on a served call, or the proof expires. The middleware never logs them, never puts them or any part of them (signatures, nonces) in an error, and never echoes them in a response. Your own request logging, APM, proxies and error trackers must not record them either: redact both headers wherever you log requests.
- **Errors and log lines carry only route names, Lago endpoint names, HTTP statuses and Lago error codes**, never a raw request or response body, a handler's exception text or Lago's free text.
- **The sign-in challenge and the 402's `resource.url` come from the configured `origin`**, never from `Host`, `X-Forwarded-Host` or an absolute-form request target.
- **A settled payment serves one request.** Lago answers a payment it already settled from its record and recognizes it by its authorization, not its signature, so a settled authorization read from the chain can be presented again under any signature. The middleware serves such an answer only on its own retry of the credit purchase (after a lost answer, a 5xx or `credit_grant_failed`); a settled payment presented in a new request gets 409 `payment_already_settled`, and nothing is served or billed.
- **The gate fails closed.** A request is served only on a clear answer from Lago, and nothing that may follow a settled payment is ever answered with a 402.

## Scope

- Anything in `src/`, and the package as published (`dist/`)
- The Lago client (`src/lago-client.ts`): where the API key is sent, redirects, timeouts
- Header decoding and rendering (`src/wire.ts`), the payment match, the settled-payment rule and the fail-closed rules (`src/gate.ts`, `src/error-map.ts`)
- The framework adapters (`src/express.ts`, `src/hono.ts`, `src/next.ts`): a request that reaches a handler without passing the gate, or a served response that loses `private`
- Error-policy gaps: a secret in an error, a log line or a response; metering that breaks a served response

## Out of scope

- Issues in `@x402/core`, the official x402 clients, the facilitator, or the frameworks — please report those upstream
- Lago's own API security — that goes through `security@getlago.com` for the platform, not this package
- Customer-side misuse (e.g., logging the payment or sign-in headers with your own middleware, or logging API keys via `onError`)

## Versions covered

We patch the latest minor of each supported major. Unreleased development versions are not security-supported — pin to a release.
