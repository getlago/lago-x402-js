/** Bazaar discovery: boot-time validation of a route's `resource` metadata and `discovery`
 * declaration, and the rendering of the official `bazaar` extension (the one a 402 carries and
 * the facilitator catalogues when a payment that carries it settles).
 *
 * Static routes only: the declaration has no path parameters, `method` is declared in config
 * (never read from a request), and nothing here ever looks at request data. Unlike the
 * facilitator, which silently drops what it dislikes, an invalid value is refused at boot.
 * Errors name the route and the field, never the value. */
import { domainToASCII } from "node:url";
import type { LagoX402Discovery, NormalizedRoute } from "./config.js";
import { LagoX402ConfigError } from "./errors.js";

const MAX_DESCRIPTION_CHARS = 500;
const MAX_SERVICE_NAME = 32;
const MAX_TAGS = 5;
const MAX_TAG = 32;
const MAX_ICON_URL = 2048;
const MAX_JSON_DEPTH = 64;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ALL_DIGITS = /^\d+$/;
const HEX_LITERAL = /^0x[0-9a-f]+$/i;

const QUERY_METHODS: readonly string[] = ["GET", "HEAD", "DELETE"];
const BODY_METHODS: readonly string[] = ["POST", "PUT", "PATCH"];
const BODY_TYPES: readonly string[] = ["json", "form-data", "text"];
const QUERY_KEYS = ["method", "queryParams", "inputSchema", "output"];
const BODY_KEYS = ["method", "bodyType", "body", "inputSchema", "output"];

type Json = Record<string, unknown>;

function fail(route: string, reason: string): never {
  throw new LagoX402ConfigError(route, reason);
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPrintableAscii(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && PRINTABLE_ASCII.test(v);
}

/** The facilitator's `isValidIconUrl` rules (spec: Service Metadata, Validation Rules). */
function isValidIconUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ICON_URL || CONTROL_CHAR.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.host.startsWith("[")) return false;
  let hostname: string;
  try {
    hostname = decodeURIComponent(parsed.hostname);
  } catch {
    return false;
  }
  const ascii = domainToASCII(hostname);
  if (ascii === "") return false;
  hostname = ascii.toLowerCase();
  return !(
    LOOPBACK_HOSTNAMES.has(hostname) ||
    IPV4.test(hostname) ||
    ALL_DIGITS.test(hostname) ||
    HEX_LITERAL.test(hostname)
  );
}

/** Refuses what the facilitator would silently drop from a route's `resource` metadata. The
 * type checks (strings, array of strings) already ran; this applies the spec's value rules. */
export function validateResourceMetadata(route: string, resource: NormalizedRoute["resource"]): void {
  const { description, serviceName, tags, iconUrl } = resource;
  if (description !== undefined && Array.from(description).length > MAX_DESCRIPTION_CHARS) {
    fail(route, `resource.description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
  }
  if (serviceName !== undefined && !isPrintableAscii(serviceName, MAX_SERVICE_NAME)) {
    fail(route, `resource.serviceName must be 1 to ${MAX_SERVICE_NAME} printable ASCII characters`);
  }
  if (tags !== undefined) {
    if (tags.length > MAX_TAGS) fail(route, `resource.tags must have at most ${MAX_TAGS} entries`);
    const seen = new Set<string>();
    for (const tag of tags) {
      if (!isPrintableAscii(tag, MAX_TAG)) {
        fail(route, `resource.tags entries must be 1 to ${MAX_TAG} printable ASCII characters`);
      }
      const key = tag.toLowerCase();
      if (seen.has(key)) fail(route, "resource.tags must not repeat an entry (case-insensitive)");
      seen.add(key);
    }
  }
  if (iconUrl !== undefined && !isValidIconUrl(iconUrl)) {
    fail(
      route,
      "resource.iconUrl must be an absolute http(s) URL of at most 2048 characters, without credentials, " +
        "whose host is not an IP literal, a loopback name, all digits or a hex literal",
    );
  }
}

/** Plain JSON only (what the 402 header can carry byte for byte): no undefined, NaN, Infinity,
 * functions, symbols, class instances or cycles. */
function isJson(v: unknown, depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((item) => isJson(item, depth + 1));
  if (isRecord(v)) {
    const proto = Object.getPrototypeOf(v) as unknown;
    return (
      (proto === Object.prototype || proto === null) &&
      Object.values(v).every((item) => isJson(item, depth + 1))
    );
  }
  return false;
}

function jsonObject(route: string, field: string, v: unknown): Json | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v) || !isJson(v)) fail(route, `${field} must be a plain JSON object`);
  return v;
}

export function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const item of Object.values(v)) deepFreeze(item);
  }
  return v;
}

/** Validates a route's declaration and returns a deep-frozen private copy. */
export function validateDiscovery(route: string, raw: unknown): LagoX402Discovery {
  if (!isRecord(raw)) fail(route, "discovery must be an object");
  const method = raw.method;
  const isQuery = typeof method === "string" && QUERY_METHODS.includes(method);
  const isBody = typeof method === "string" && BODY_METHODS.includes(method);
  if (!isQuery && !isBody) fail(route, "discovery.method must be GET, HEAD, DELETE, POST, PUT or PATCH");
  const allowed = isQuery ? QUERY_KEYS : BODY_KEYS;
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail(route, `discovery.${key} is not supported for ${method as string}`);
  }
  if (isBody && (typeof raw.bodyType !== "string" || !BODY_TYPES.includes(raw.bodyType))) {
    fail(route, `discovery.bodyType must be one of ${BODY_TYPES.join(", ")} for ${method as string}`);
  }
  const input = jsonObject(
    route,
    isQuery ? "discovery.queryParams" : "discovery.body",
    raw[isQuery ? "queryParams" : "body"],
  );
  const inputSchema = jsonObject(route, "discovery.inputSchema", raw.inputSchema);
  let output: { example: unknown; schema?: Json } | undefined;
  if (raw.output !== undefined) {
    if (!isRecord(raw.output)) fail(route, "discovery.output must be an object");
    for (const key of Object.keys(raw.output)) {
      if (key !== "example" && key !== "schema") fail(route, `discovery.output.${key} is not supported`);
    }
    // The official builder drops `output` unless `example` is truthy, and its schema types the
    // example as an object: refuse anything else instead of dropping it or failing validation.
    if (!isRecord(raw.output.example) || !isJson(raw.output.example)) {
      fail(route, "discovery.output.example is required and must be a plain JSON object");
    }
    const schema = jsonObject(route, "discovery.output.schema", raw.output.schema);
    output = { example: raw.output.example, ...(schema === undefined ? {} : { schema }) };
  }
  const clean = {
    method,
    ...(isBody ? { bodyType: raw.bodyType } : {}),
    ...(input === undefined ? {} : isQuery ? { queryParams: input } : { body: input }),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(output === undefined ? {} : { output }),
  };
  return deepFreeze(structuredClone(clean) as unknown as LagoX402Discovery);
}

/** The `bazaar` extension exactly as the official `declareDiscoveryExtension(...).bazaar`
 * followed by `bazaarResourceServerExtension.enrichDeclaration` (method narrowed) yields it:
 * same keys, same order. Pure: the same declaration always renders the same bytes. */
export function renderBazaar(d: LagoX402Discovery): Json {
  const output = d.output;
  const outputInfo = output ? { output: { type: "json", example: output.example } } : {};
  const outputSchema = output
    ? {
        output: {
          type: "object",
          properties: { type: { type: "string" }, example: { type: "object", ...output.schema } },
          required: ["type"],
        },
      }
    : {};
  const inputSchema = d.inputSchema ?? { properties: {} };
  const isBody = "bodyType" in d;
  const info = isBody
    ? { type: "http", method: d.method, bodyType: d.bodyType, body: d.body ?? {} }
    : { type: "http", method: d.method, queryParams: d.queryParams ?? {} };
  const inputProperties = isBody
    ? {
        type: { type: "string", const: "http" },
        method: { type: "string", enum: [d.method] },
        bodyType: { type: "string", enum: ["json", "form-data", "text"] },
        body: inputSchema,
      }
    : {
        type: { type: "string", const: "http" },
        method: { type: "string", enum: [d.method] },
        queryParams: { type: "object", ...inputSchema },
      };
  return structuredClone({
    info: { input: info, ...outputInfo },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: inputProperties,
          required: isBody ? ["type", "method", "bodyType", "body"] : ["type", "method"],
          additionalProperties: false,
        },
        ...outputSchema,
      },
      required: ["input"],
    },
  });
}
