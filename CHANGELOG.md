# Changelog

All notable changes to this project will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

### Added

- `createLagoX402(config)`: validates the config, then checks every route against Lago before it serves. The billable metric must sum the `value` property (`sum_agg`, `field_name: "value"`, no expression, not recurring), and a gate check without sign-in must answer a challenge with sign-in chains (lago-api with INT-331). A route Lago refuses rejects the boot with one `LagoX402ConfigError` naming every refused route and its reason. A route Lago cannot be reached for (5xx, 408, 429, timeout, network error, facilitator outage) answers 503 `unavailable` and is retried in the background (1 s doubling to 60 s, never keeping the process alive) until it becomes active, or is refused for good if Lago then refuses it.
- `x402.close({ timeoutMs })` (default 10 s): stops the background boot retries and waits for usage events still being delivered, keeping Node alive meanwhile, so it can be awaited in a shutdown handler.
- Every failure passed to `onError` is also logged with `console.warn("[lago-x402] <where> failed: <message>")`, so none is silent when no `onError` is set; a throwing `onError` is ignored.
- x402 v2 wire layer (internal, not exported yet): renders Lago gate-check challenges as `PAYMENT-REQUIRED` (with a `sign-in-with-x` challenge bound to the configured origin) and settled purchases as `PAYMENT-RESPONSE`; decodes `PAYMENT-SIGNATURE` and `SIGN-IN-WITH-X` without ever surfacing their contents in errors or logs.
- The gate (internal, not exported yet): answers each protected request from Lago's gate check (402 challenge, 401 sign-in refusal, 403/409/503, or serve), matches a payment against a fresh menu before forwarding it to Lago's credit purchase (a changed amount, pay-to or terms is a fresh 402, never an underpayment), retries a lost purchase answer once, and never answers 402 once money may have moved.
- Local config validation (internal, not exported yet): rejects bad origins, API URLs, route names, amounts, wallet limits and sign-in statements before any network call, without ever echoing the API key.
- Bazaar discovery: a route flagged `discoverable` declares how it is called (`discovery`: `method`, `queryParams` or `bodyType` + `body`, `inputSchema`, `output`; static routes only, `method` comes from config, never from the request). Its 402 carries the official `bazaar` extension and the payment forwarded to Lago carries the same one, so the facilitator catalogues the resource when it settles. Boot refuses an invalid declaration and, per the Bazaar spec's rules, an invalid `resource.serviceName`, `tags`, `iconUrl` or `description` (over 500 characters) instead of letting the facilitator drop them silently.
