/** The package's core API (context §4): nothing else is exported from "lago-x402". */
import type { LagoX402Config } from "./config.js";
import { createLagoX402 as create, type LagoX402 } from "./x402.js";

/** Validates `config`, checks every route against Lago, and resolves once each route is
 * `active` or waiting for Lago to become reachable (it answers 503 meanwhile and is retried in
 * the background). Rejects with one `LagoX402ConfigError` naming every route Lago refused. */
export function createLagoX402(config: LagoX402Config): Promise<LagoX402> {
  return create(config);
}

export type { LagoX402 } from "./x402.js";
export type { LagoX402Config, LagoX402Discovery, LagoX402ErrorWhere, LagoX402Route } from "./config.js";
export type { LagoEndpoint } from "./errors.js";
export { LagoApiError, LagoUnreachableError, LagoX402ConfigError, LagoX402UsageError } from "./errors.js";
