# Contributing

## Development setup

```bash
git clone https://github.com/getlago/lago-x402-js
cd lago-x402-js
npm install
```

Working on the package needs Node `^22.19 || >=24` (`devEngines` in `package.json`; npm warns on an older one). That is newer than the `>=22.12` the package supports (`engines`), because eslint and the unit tests' network guard (undici) need it. CI runs the package check on Node 22.12.0, so the supported minimum stays tested.

## Run tests

```bash
# Unit tests (fast; no network, loopback only)
npm test

# The package as npm would publish it: file list, runtime imports,
# require() from CommonJS and import() from ESM of every subpath
npm run build && npm run test:package

# lago-x402/next in a real `next build && next start`
npm run build && npm run test:next
```

The unit suite is sealed against the network (`tests/support/no_network.ts` installs a dispatcher that refuses every origin but loopback). Lago is a fake on `127.0.0.1` (`tests/support/fake-lago.ts`), agents are built with the official x402 client libraries (`tests/support/agent.ts`), and every adapter is exercised over real HTTP (`tests/support/frameworks.ts`).

### Live test

`npm run test:live` runs the three legs against a real Lago on Base Sepolia and spends one testnet top-up per run. It is skipped unless its environment is set; see "Live test" in the [README](README.md#live-test). Use testnet credentials only, keep them in your shell environment, and never paste their values into an issue, a commit or a pull request.

## Build and type-check

```bash
npm run lint
npm run format:check
npm run typecheck
npm run build
```

## Where things live

- `src/index.ts` — the core exports (`createLagoX402`, the error classes, the config types)
- `src/config.ts` — config types and the local validation that runs before any network call
- `src/x402.ts` — `createLagoX402`: wiring, boot, `close()`
- `src/boot.ts` — the boot checks and their background retries
- `src/gate.ts` — the three legs of a protected request
- `src/error-map.ts` — Lago's gate-check and credit-purchase refusals → what the agent gets
- `src/wire.ts` — x402 v2 headers in and out, the sign-in challenge, `resource.url`
- `src/bazaar.ts` — Bazaar metadata validation and the `bazaar` extension
- `src/usage.ts` — usage events: one per served call, retries, bounded queue
- `src/lago-client.ts` — the one HTTP client to Lago
- `src/adapter.ts` — what the framework adapters share
- `src/express.ts`, `src/hono.ts`, `src/next.ts` — the adapters
- `tests/unit/` — unit tests; `tests/unit/behaviour.test.ts` runs every leg and refusal through each adapter, `tests/unit/security.test.ts` checks that no secret ever leaks
- `tests/integration/` — the Next.js fixture app and its `next build && next start` test
- `tests/live/` — the live test against a real Lago
- `scripts/check-package.mjs` — `npm run test:package`
- `scripts/live-setup.mjs` — creates what the live test needs through Lago's API

## Rules the code keeps

A change that breaks one of these needs a very good reason, written down in the pull request:

- **Never log, serialize or put in an error** the API key, `PAYMENT-SIGNATURE`, `SIGN-IN-WITH-X`, or a raw request or response body. Errors carry only route names, endpoint names, HTTP statuses and Lago codes.
- **The API key goes only to `apiUrl`**, never across a redirect. The library reads no environment variables.
- **The gate fails closed.** Anything unexpected is a 503; nothing that may follow a settled payment is ever a 402.
- **Metering never breaks a response.** Failures after the handler ran go to `onError` and the log line, never to the client.
- **The gate never decides on a path.** Routes are attached through the framework's router; the sign-in challenge and `resource.url` come from the configured `origin`.
- **Write down what was measured rather than chosen** (in the module comment and, when merchants or agent builders feel it, in the README's "Measured behaviours and limitations").

## No secrets, ever

This is a public repository. Tests use throwaway keys only (`generatePrivateKey()`, `nacl.sign.keyPair()`); credentials come from the environment and never from a file in the tree. Before each commit, run [gitleaks](https://github.com/gitleaks/gitleaks):

```bash
gitleaks protect --staged --redact -v
```

## Pull request checklist

- [ ] Unit tests cover the change
- [ ] Existing tests still pass (`npm test`)
- [ ] TypeScript compiles cleanly (`npm run typecheck`)
- [ ] Linter and formatter clean (`npm run lint`, `npm run format:check`)
- [ ] `npm run build` and `npm run test:package` succeed
- [ ] `npm run test:next` succeeds if `src/next.ts` or `src/adapter.ts` changed
- [ ] CHANGELOG.md updated under `## [Unreleased]`
- [ ] README updated if the public API or a documented behaviour changed
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org)
