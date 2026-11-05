/** Public error classes. Messages carry only endpoint names, HTTP statuses, route names and
 * Lago codes that pass `sanitizedLagoCodes`: never a key, a header or a raw body. */

export type LagoEndpoint = "gate_checks" | "credit_purchases" | "events" | "billable_metrics";

const SAFE_CODE = /^[A-Za-z0-9_.]{1,64}$/;

function isSafeCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_CODE.test(value);
}

/** Extracts Lago's `code` and `error_details` codes, keeping only identifier-shaped
 * keys and values. Everything else (free text, nested data) is dropped. */
export function sanitizedLagoCodes(body: unknown): {
  code: string | null;
  errorCodes: Record<string, string[]>;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { code: null, errorCodes: {} };
  }
  const record = body as Record<string, unknown>;
  const code = isSafeCode(record.code) ? record.code : null;
  const entries: [string, string[]][] = [];
  const details = record.error_details;
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    for (const [key, value] of Object.entries(details)) {
      if (!isSafeCode(key) || !Array.isArray(value)) continue;
      const codes = value.filter(isSafeCode);
      if (codes.length > 0) entries.push([key, codes]);
    }
  }
  // fromEntries defines own properties, so a "__proto__" key cannot touch the prototype.
  return { code, errorCodes: Object.fromEntries(entries) };
}

export class LagoX402ConfigError extends Error {
  readonly route: string | null;
  readonly reason: string;
  constructor(route: string | null, reason: string) {
    super(route === null ? `lago-x402 config: ${reason}` : `lago-x402 route "${route}": ${reason}`);
    this.name = "LagoX402ConfigError";
    this.route = route;
    this.reason = reason;
  }
}

export class LagoApiError extends Error {
  readonly endpoint: LagoEndpoint;
  readonly status: number;
  readonly code: string | null;
  readonly errorCodes: Readonly<Record<string, readonly string[]>>;
  /** `body` is the parsed answer; only its sanitized codes are kept. */
  constructor(endpoint: LagoEndpoint, status: number, body?: unknown) {
    const { code, errorCodes } = sanitizedLagoCodes(body);
    const details = Object.entries(errorCodes)
      .map(([field, codes]) => `${field}: ${codes.join(",")}`)
      .join("; ");
    super(
      `Lago ${endpoint} answered ${status}` + (code ? ` (${code})` : "") + (details ? ` [${details}]` : ""),
    );
    this.name = "LagoApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.code = code;
    this.errorCodes = errorCodes;
  }
}

export class LagoUnreachableError extends Error {
  readonly endpoint: LagoEndpoint;
  readonly reason: "timeout" | "network";
  constructor(endpoint: LagoEndpoint, reason: "timeout" | "network") {
    super(`Lago ${endpoint} unreachable (${reason})`);
    this.name = "LagoUnreachableError";
    this.endpoint = endpoint;
    this.reason = reason;
  }
}

export class LagoX402UsageError extends Error {
  readonly reason: "missing" | "invalid" | "threw" | "queue_full";
  constructor(reason: "missing" | "invalid" | "threw" | "queue_full") {
    super(`lago-x402 usage report failed (${reason})`);
    this.name = "LagoX402UsageError";
    this.reason = reason;
  }
}
