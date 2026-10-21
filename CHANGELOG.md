# Changelog

All notable changes to this project will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

### Added

- x402 v2 wire layer (internal, not exported yet): renders Lago gate-check challenges as `PAYMENT-REQUIRED` (with a `sign-in-with-x` challenge bound to the configured origin) and settled purchases as `PAYMENT-RESPONSE`; decodes `PAYMENT-SIGNATURE` and `SIGN-IN-WITH-X` without ever surfacing their contents in errors or logs.
- The gate (internal, not exported yet): answers each protected request from Lago's gate check (402 challenge, 401 sign-in refusal, 403/409/503, or serve), matches a payment against a fresh menu before forwarding it to Lago's credit purchase (a changed amount, pay-to or terms is a fresh 402, never an underpayment), retries a lost purchase answer once, and never answers 402 once money may have moved.
- Local config validation (internal, not exported yet): rejects bad origins, API URLs, route names, amounts, wallet limits and sign-in statements before any network call, without ever echoing the API key.
