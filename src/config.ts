/** Public config types and the local validation that runs before any network call.
 * Error messages name routes but never echo a config value (the API key least of all). */

import { LagoX402ConfigError } from "./errors.js";
import { DEFAULT_SIGN_IN_STATEMENT } from "./wire.js";

/** Placeholder: a later task replaces it with the Bazaar discovery shape and validates it. */
export type LagoX402Discovery = Record<string, unknown>;

export type LagoX402ErrorWhere = "boot" | "gate.check" | "gate.purchase" | "usage.extract" | "usage.send";

export interface LagoX402Route {
  billableMetric: string;
  planCode: string;
  walletCode: string;
  topUpAmountCents: number;
  estimatedCallCostCents: number;
  wallet: {
    name: string;
    rateAmount: string;
    paidTopUpMinAmountCents?: number;
    paidTopUpMaxAmountCents?: number;
  };
  resource?: {
    description?: string;
    mimeType?: string;
    serviceName?: string;
    tags?: string[];
    iconUrl?: string;
  };
  discoverable?: boolean;
  discovery?: LagoX402Discovery;
}

export interface LagoX402Config {
  apiUrl: string;
  apiKey: string;
  connectionCode: string;
  origin: string;
  routes: Record<string, LagoX402Route>;
  signInStatement?: string;
  timeouts?: { gateCheckMs?: number; creditPurchaseMs?: number; eventMs?: number };
  onError?: (err: unknown, where: LagoX402ErrorWhere) => void;
}

export interface NormalizedRoute {
  readonly name: string;
  readonly billableMetric: string;
  readonly planCode: string;
  readonly walletCode: string;
  readonly topUpAmountCents: number;
  readonly estimatedCallCostCents: number;
  readonly wallet: {
    readonly name: string;
    readonly rate_amount: string;
    readonly currency: "USD";
    readonly paid_top_up_min_amount_cents?: number;
    readonly paid_top_up_max_amount_cents?: number;
  };
  readonly resource: {
    readonly description?: string;
    readonly mimeType?: string;
    readonly serviceName?: string;
    readonly tags?: readonly string[];
    readonly iconUrl?: string;
  };
  readonly discoverable: boolean;
  readonly discovery?: LagoX402Discovery;
}

export interface NormalizedConfig {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly connectionCode: string;
  readonly origin: URL;
  readonly signInStatement: string;
  readonly timeouts: {
    readonly gateCheckMs: number;
    readonly creditPurchaseMs: number;
    readonly eventMs: number;
  };
  readonly onError?: (err: unknown, where: LagoX402ErrorWhere) => void;
  readonly routes: ReadonlyMap<string, NormalizedRoute>;
}

const DEFAULT_TIMEOUTS = { gateCheckMs: 5000, creditPurchaseMs: 45000, eventMs: 10000 };
const ROUTE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const RATE_AMOUNT = /^\d+(\.\d{1,5})?$/;
const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/i;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_OR_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// Lago API keys are printable ASCII; this also rules out every Unicode space and invisible character.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
// Node's setTimeout treats anything above 2^31-1 ms as 1 ms.
const MAX_TIMEOUT_MS = 2147483647;
const MAX_STATEMENT_BYTES = 256;

function fail(route: string | null, reason: string): never {
  throw new LagoX402ConfigError(route, reason);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function positiveSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function parseUrl(v: unknown): URL | null {
  if (typeof v !== "string" || CONTROL_OR_SPACE.test(v)) return null;
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

function validateApiUrl(v: unknown): string {
  const url = parseUrl(v);
  const raw = v as string;
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    fail(null, "apiUrl must be an http(s) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

/** Mirrors lago-api `X402::Origin.normalize`. */
function validateOrigin(v: unknown): URL {
  const msg =
    "origin must be a bare https origin (http only for localhost, 127.0.0.1 or [::1]) without path, query, fragment or credentials";
  const url = parseUrl(v);
  const raw = v as string;
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("@") ||
    !(url.hostname.startsWith("[") || HOSTNAME.test(url.hostname)) ||
    (url.protocol === "http:" && !LOOPBACK_HOSTS.includes(url.hostname))
  ) {
    fail(null, msg);
  }
  return new URL(url.origin);
}

function validateStatement(v: unknown): string {
  if (v === undefined) return DEFAULT_SIGN_IN_STATEMENT;
  if (
    typeof v !== "string" ||
    v.length === 0 ||
    CONTROL_OR_BREAK.test(v) ||
    Buffer.byteLength(v, "utf8") > MAX_STATEMENT_BYTES
  ) {
    fail(
      null,
      `signInStatement must be a non-empty single line of at most ${MAX_STATEMENT_BYTES} UTF-8 bytes without control characters`,
    );
  }
  return v;
}

function validateTimeouts(v: unknown): NormalizedConfig["timeouts"] {
  if (v !== undefined && !isRecord(v)) fail(null, "timeouts must be an object");
  const out = { ...DEFAULT_TIMEOUTS };
  for (const key of Object.keys(DEFAULT_TIMEOUTS) as (keyof typeof DEFAULT_TIMEOUTS)[]) {
    const value = v?.[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
      fail(null, `timeouts.${key} must be a positive integer of at most ${MAX_TIMEOUT_MS} ms`);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

function optionalString(name: string, field: string, v: unknown): void {
  if (v !== undefined && typeof v !== "string") fail(name, `${field} must be a string`);
}

function validateRoute(name: string, raw: unknown): NormalizedRoute {
  if (!ROUTE_NAME.test(name)) fail(null, "route names must match /^[A-Za-z0-9_.:-]{1,64}$/");
  if (!isRecord(raw)) fail(name, "route must be an object");
  for (const field of ["billableMetric", "planCode", "walletCode"] as const) {
    if (!nonEmptyString(raw[field])) fail(name, `${field} must be a non-empty string`);
  }
  if (!positiveSafeInt(raw.topUpAmountCents)) fail(name, "topUpAmountCents must be a positive safe integer");
  if (!positiveSafeInt(raw.estimatedCallCostCents)) {
    fail(name, "estimatedCallCostCents must be a positive safe integer");
  }

  const w = raw.wallet;
  if (!isRecord(w)) fail(name, "wallet must be an object");
  if (!nonEmptyString(w.name)) fail(name, "wallet.name must be a non-empty string");
  if (typeof w.rateAmount !== "string" || !RATE_AMOUNT.test(w.rateAmount) || !/[1-9]/.test(w.rateAmount)) {
    fail(name, "wallet.rateAmount must be a positive decimal string with at most 5 decimals");
  }
  const min = w.paidTopUpMinAmountCents;
  const max = w.paidTopUpMaxAmountCents;
  if (min !== undefined && !positiveSafeInt(min)) {
    fail(name, "wallet.paidTopUpMinAmountCents must be a positive safe integer");
  }
  if (max !== undefined && !positiveSafeInt(max)) {
    fail(name, "wallet.paidTopUpMaxAmountCents must be a positive safe integer");
  }
  if (min !== undefined && max !== undefined && min > max) {
    fail(name, "wallet.paidTopUpMinAmountCents must not exceed paidTopUpMaxAmountCents");
  }
  if (max !== undefined && raw.topUpAmountCents > max) {
    fail(name, "topUpAmountCents must not exceed wallet.paidTopUpMaxAmountCents");
  }

  const res = raw.resource;
  if (res !== undefined && !isRecord(res)) fail(name, "resource must be an object");
  const resource: { -readonly [K in keyof NormalizedRoute["resource"]]: NormalizedRoute["resource"][K] } = {};
  if (res !== undefined) {
    for (const field of ["description", "mimeType", "serviceName", "iconUrl"] as const) {
      optionalString(name, `resource.${field}`, res[field]);
      if (res[field] !== undefined) resource[field] = res[field] as string;
    }
    if (res.tags !== undefined) {
      if (!Array.isArray(res.tags) || res.tags.some((t) => typeof t !== "string")) {
        fail(name, "resource.tags must be an array of strings");
      }
      resource.tags = Object.freeze([...(res.tags as string[])]);
    }
  }

  if (raw.discoverable !== undefined && typeof raw.discoverable !== "boolean") {
    fail(name, "discoverable must be a boolean");
  }
  const discoverable = raw.discoverable === true;
  if (raw.discovery !== undefined && !isRecord(raw.discovery)) fail(name, "discovery must be an object");
  if (discoverable && raw.discovery === undefined)
    fail(name, "discoverable routes require a discovery object");

  const route: NormalizedRoute = {
    name,
    billableMetric: raw.billableMetric as string,
    planCode: raw.planCode as string,
    walletCode: raw.walletCode as string,
    topUpAmountCents: raw.topUpAmountCents,
    estimatedCallCostCents: raw.estimatedCallCostCents,
    wallet: Object.freeze({
      name: w.name,
      rate_amount: w.rateAmount,
      currency: "USD" as const,
      ...(min !== undefined ? { paid_top_up_min_amount_cents: min } : {}),
      ...(max !== undefined ? { paid_top_up_max_amount_cents: max } : {}),
    }),
    resource: Object.freeze(resource),
    discoverable,
    ...(raw.discovery !== undefined
      ? { discovery: structuredClone(raw.discovery) as LagoX402Discovery }
      : {}),
  };
  return Object.freeze(route);
}

export function validateConfig(c: LagoX402Config): NormalizedConfig {
  if (!isRecord(c)) fail(null, "config must be an object");
  const apiUrl = validateApiUrl(c.apiUrl);
  const key = c.apiKey;
  if (typeof key !== "string" || !PRINTABLE_ASCII.test(key)) fail(null, "apiKey is invalid");
  if (!nonEmptyString(c.connectionCode)) fail(null, "connectionCode must be a non-empty string");
  const origin = validateOrigin(c.origin);
  const signInStatement = validateStatement(c.signInStatement);
  const timeouts = validateTimeouts(c.timeouts);
  if (c.onError !== undefined && typeof c.onError !== "function") fail(null, "onError must be a function");
  if (!isRecord(c.routes)) fail(null, "routes must be an object");
  const names = Object.keys(c.routes);
  if (names.length === 0) fail(null, "at least one route is required");
  const routes = new Map<string, NormalizedRoute>();
  for (const name of names) routes.set(name, validateRoute(name, c.routes[name]));

  return Object.freeze({
    apiUrl,
    apiKey: key,
    connectionCode: c.connectionCode,
    origin,
    signInStatement,
    timeouts,
    ...(c.onError !== undefined ? { onError: c.onError } : {}),
    routes,
  });
}
