import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  isValidIconUrl,
  isValidServiceName,
  sanitizeTags,
  validateDiscoveryExtension,
} from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { renderBazaar, validateDiscovery } from "../../src/bazaar.js";
import { validateConfig, type LagoX402Config, type LagoX402Discovery } from "../../src/config.js";
import { LagoX402ConfigError } from "../../src/errors.js";

const API_KEY = "test-key-for-bazaar-unit-tests";

function config(routeOver: Record<string, unknown> = {}): LagoX402Config {
  return {
    apiUrl: "https://api.getlago.com",
    apiKey: API_KEY,
    connectionCode: "conn_1",
    origin: "https://api.example.com",
    routes: {
      generate: {
        billableMetric: "tokens",
        planCode: "plan",
        walletCode: "wallet",
        topUpAmountCents: 500,
        estimatedCallCostCents: 2,
        wallet: { name: "w", rateAmount: "1" },
        ...routeOver,
      },
    },
  } as LagoX402Config;
}

function refusal(routeOver: Record<string, unknown>): LagoX402ConfigError {
  try {
    validateConfig(config(routeOver));
  } catch (e) {
    expect(e).toBeInstanceOf(LagoX402ConfigError);
    return e as LagoX402ConfigError;
  }
  throw new Error("expected validateConfig to throw");
}

/** What the official SDK produces for the same declaration, on a request with that method. */
function official(d: LagoX402Discovery): unknown {
  const input = "bodyType" in d ? d.body : d.queryParams;
  const declared = declareDiscoveryExtension({
    method: d.method,
    ...(input === undefined ? {} : { input }),
    ...(d.inputSchema === undefined ? {} : { inputSchema: d.inputSchema }),
    ...("bodyType" in d ? { bodyType: d.bodyType } : {}),
    ...(d.output === undefined ? {} : { output: d.output }),
  } as Parameters<typeof declareDiscoveryExtension>[0]).bazaar;
  return bazaarResourceServerExtension.enrichDeclaration!(declared, {
    method: d.method,
    adapter: { getPath: () => "/x" },
  });
}

const OUTPUT = {
  example: { text: "hello", usage: { tokens: 3 } },
  schema: { properties: { text: { type: "string" } }, required: ["text"] },
};

const declarations: [string, LagoX402Discovery][] = [
  ["GET bare", { method: "GET" }],
  ["HEAD bare", { method: "HEAD" }],
  [
    "GET full",
    {
      method: "GET",
      queryParams: { q: "weather in Paris", limit: 3 },
      inputSchema: { properties: { q: { type: "string" }, limit: { type: "integer" } }, required: ["q"] },
      output: OUTPUT,
    },
  ],
  ["DELETE with output example only", { method: "DELETE", output: { example: { ok: true } } }],
  ["POST bare", { method: "POST", bodyType: "json" }],
  [
    "POST full",
    {
      method: "POST",
      bodyType: "json",
      body: { prompt: "Write a haiku" },
      inputSchema: { properties: { prompt: { type: "string" } }, required: ["prompt"] },
      output: OUTPUT,
    },
  ],
  ["PUT form-data", { method: "PUT", bodyType: "form-data", body: { file: "x" } }],
  [
    "PATCH text",
    { method: "PATCH", bodyType: "text", body: { note: "n" }, output: { example: { ok: "yes" } } },
  ],
];

describe("renderBazaar", () => {
  it.each(declarations)(
    "renders exactly what declareDiscoveryExtension + enrichDeclaration produce: %s",
    (_name, d) => {
      const rendered = renderBazaar(validateDiscovery("generate", d));
      expect(rendered).toStrictEqual(official(d));
      // Same keys in the same order, at every depth.
      expect(JSON.stringify(rendered)).toBe(JSON.stringify(official(d)));
    },
  );

  it.each(declarations)("passes the facilitator's validateDiscoveryExtension: %s", (_name, d) => {
    const rendered = renderBazaar(validateDiscovery("generate", d));
    expect(validateDiscoveryExtension(rendered as never)).toStrictEqual({ valid: true });
  });

  it("the schema rejects an info of another method (the method is narrowed to the declared one)", () => {
    const rendered = renderBazaar({ method: "GET" }) as { info: { input: Record<string, unknown> } };
    rendered.info.input.method = "POST";
    expect(validateDiscoveryExtension(rendered as never).valid).toBe(false);
  });

  it("is pure and returns an independent copy every time", () => {
    const d = validateDiscovery("generate", declarations[5][1]);
    const a = renderBazaar(d);
    const b = renderBazaar(d);
    expect(a).toStrictEqual(b);
    expect(a).not.toBe(b);
    (a.info as { input: { body: Record<string, unknown> } }).input.body.mutated = true;
    expect(renderBazaar(d)).toStrictEqual(b);
  });
});

describe("validateConfig: discovery", () => {
  it("normalizes a discoverable route: frozen declaration and a frozen rendered extension", () => {
    const source = { method: "POST", bodyType: "json", body: { prompt: "hi" } };
    const route = validateConfig(config({ discoverable: true, discovery: source })).routes.get("generate")!;
    expect(route.discovery).toStrictEqual(source);
    expect(route.discovery).not.toBe(source);
    expect(Object.isFrozen(route.discovery)).toBe(true);
    expect(Object.isFrozen((route.discovery as { body: object }).body)).toBe(true);
    expect(route.bazaar).toStrictEqual(official(source as LagoX402Discovery));
    expect(Object.isFrozen(route.bazaar)).toBe(true);
    expect(Object.isFrozen((route.bazaar as { info: object }).info)).toBe(true);
    source.body.prompt = "changed after boot";
    expect((route.discovery as unknown as { body: { prompt: string } }).body.prompt).toBe("hi");
  });

  it("a route that is not discoverable renders no extension", () => {
    const route = validateConfig(config({ discovery: { method: "GET" } })).routes.get("generate")!;
    expect(route.bazaar).toBeUndefined();
    expect(validateConfig(config()).routes.get("generate")!.bazaar).toBeUndefined();
  });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const refused: [string, unknown, string][] = [
    ["a non-object", "GET", "discovery must be an object"],
    ["an array", [], "discovery must be an object"],
    ["a missing method", {}, "discovery.method"],
    ["a lower-case method", { method: "get" }, "discovery.method"],
    ["an unsupported method", { method: "OPTIONS" }, "discovery.method"],
    ["pathParams", { method: "GET", pathParams: { id: "1" } }, "discovery.pathParams"],
    ["routeTemplate", { method: "GET", routeTemplate: "/a/:id" }, "discovery.routeTemplate"],
    ["an unknown key", { method: "GET", extra: 1 }, "discovery.extra"],
    ["bodyType on a query method", { method: "GET", bodyType: "json" }, "discovery.bodyType"],
    ["body on a query method", { method: "DELETE", body: {} }, "discovery.body"],
    ["queryParams on a body method", { method: "POST", bodyType: "json", queryParams: {} }, "queryParams"],
    ["a body method without bodyType", { method: "POST" }, "discovery.bodyType"],
    ["an unknown bodyType", { method: "POST", bodyType: "xml" }, "discovery.bodyType"],
    ["non-object queryParams", { method: "GET", queryParams: [] }, "discovery.queryParams"],
    ["non-object body", { method: "POST", bodyType: "json", body: "x" }, "discovery.body"],
    ["non-object inputSchema", { method: "GET", inputSchema: 1 }, "discovery.inputSchema"],
    ["null inputSchema", { method: "GET", inputSchema: null }, "discovery.inputSchema"],
    ["non-JSON queryParams", { method: "GET", queryParams: { a: undefined } }, "discovery.queryParams"],
    ["a function in a schema", { method: "GET", inputSchema: { f: () => 1 } }, "discovery.inputSchema"],
    ["a cycle", { method: "GET", queryParams: circular }, "discovery.queryParams"],
    ["a class instance", { method: "GET", queryParams: { d: new Date() } }, "discovery.queryParams"],
    ["a non-finite number", { method: "GET", queryParams: { n: Infinity } }, "discovery.queryParams"],
    ["a non-object output", { method: "GET", output: "x" }, "discovery.output"],
    [
      "an unknown output key",
      { method: "GET", output: { example: 1, type: "json" } },
      "discovery.output.type",
    ],
    ["an output without example", { method: "GET", output: { schema: {} } }, "discovery.output.example"],
    ["a string example", { method: "GET", output: { example: "ok" } }, "discovery.output.example"],
    ["an array example", { method: "GET", output: { example: [1] } }, "discovery.output.example"],
    ["a falsy example", { method: "GET", output: { example: 0 } }, "discovery.output.example"],
    [
      "a non-JSON example",
      { method: "GET", output: { example: { a: undefined } } },
      "discovery.output.example",
    ],
    [
      "a non-object output schema",
      { method: "GET", output: { example: { a: 1 }, schema: [] } },
      "discovery.output.schema",
    ],
  ];

  it.each(refused)("refuses %s at boot, naming the route", (_name, discovery, reason) => {
    const err = refusal({ discoverable: true, discovery });
    expect(err.route).toBe("generate");
    expect(err.reason).toContain(reason);
    expect(err.message).not.toContain(API_KEY);
  });

  it("refuses an invalid declaration on a route that is not discoverable too", () => {
    expect(refusal({ discovery: { method: "TRACE" } }).reason).toContain("discovery.method");
  });

  it("never echoes a declared value in an error", () => {
    const err = refusal({
      discoverable: true,
      discovery: { method: "GET", queryParams: { s: () => "S3CR3T" } },
    });
    expect(err.message).not.toContain("S3CR3T");
  });
});

describe("validateConfig: resource metadata", () => {
  const long = (n: number) => "a".repeat(n);
  const serviceNames: [string, string][] = [
    ["plain", "Merchant AI"],
    ["32 characters", long(32)],
    ["33 characters", long(33)],
    ["empty", ""],
    ["non-ASCII", "Café"],
    ["a control character", "bad\nname"],
    ["a tab", "a\tb"],
    ["DEL", "a\x7fb"],
    ["only spaces", "   "],
    ["an emoji", "AI \u{1F600}"],
  ];
  it.each(serviceNames)("serviceName %s agrees with the facilitator", (_n, value) => {
    const accepted = isValidServiceName(value);
    const run = () => validateConfig(config({ resource: { serviceName: value } }));
    if (accepted) expect(run).not.toThrow();
    else expect(() => run()).toThrow(/resource\.serviceName/);
  });

  const tagSets: [string, string[]][] = [
    ["plain", ["ai", "text"]],
    ["empty list", []],
    ["five", ["a", "b", "c", "d", "e"]],
    ["six", ["a", "b", "c", "d", "e", "f"]],
    ["an empty entry", ["ai", ""]],
    ["a long entry", [long(33)]],
    ["a 32-char entry", [long(32)]],
    ["a non-ASCII entry", ["café"]],
    ["a control character", ["a\u0000b"]],
    ["a case-insensitive duplicate", ["Weather", "weather"]],
    ["an exact duplicate", ["ai", "ai"]],
  ];
  it.each(tagSets)("tags %s agrees with the facilitator", (_n, tags) => {
    // The facilitator drops what it dislikes; we accept exactly what it would keep whole.
    const kept = sanitizeTags(tags);
    const keptWhole = tags.length === 0 || (kept !== undefined && kept.length === tags.length);
    const run = () => validateConfig(config({ resource: { tags } }));
    if (keptWhole) expect(run).not.toThrow();
    else expect(() => run()).toThrow(/resource\.tags/);
  });

  const icons: [string, string][] = [
    ["https", "https://cdn.example.com/icon.png"],
    ["http", "http://cdn.example.com/icon.png"],
    ["with a port and query", "https://cdn.example.com:8443/i.png?v=2"],
    ["not a URL", "icon.png"],
    ["relative", "/icon.png"],
    ["data:", "data:image/png;base64,AAAA"],
    ["file:", "file:///etc/passwd"],
    ["ftp", "ftp://cdn.example.com/i.png"],
    ["userinfo", "https://user@cdn.example.com/i.png"],
    ["userinfo and password", "https://user:pw@cdn.example.com/i.png"],
    ["IPv4", "https://203.0.113.9/i.png"],
    ["IPv4 loopback", "http://127.0.0.1/i.png"],
    ["IPv6", "http://[2001:db8::1]/i.png"],
    ["IPv6 loopback", "http://[::1]/i.png"],
    ["localhost", "http://localhost/i.png"],
    ["LOCALHOST", "http://LOCALHOST:3000/i.png"],
    ["localhost.localdomain", "http://localhost.localdomain/i.png"],
    ["ip6-localhost", "http://ip6-localhost/i.png"],
    ["ip6-loopback", "http://ip6-loopback/i.png"],
    ["full-width localhost", "http://ｌｏｃａｌｈｏｓｔ/i.png"],
    ["percent-encoded localhost", "http://%6cocalhost/i.png"],
    ["all-digit host", "http://2130706433/i.png"],
    ["zero host", "http://0/i.png"],
    ["hex host", "http://0x7f000001/i.png"],
    ["a control character", "https://cdn.example.com/i\n.png"],
    ["2048 characters", "https://cdn.example.com/" + long(2048 - 24)],
    ["2049 characters", "https://cdn.example.com/" + long(2049 - 24)],
    ["an IDN host", "https://bücher.example/i.png"],
    ["a trailing-dot host", "https://cdn.example.com./i.png"],
  ];
  it.each(icons)("iconUrl %s agrees with the facilitator", (_n, value) => {
    const run = () => validateConfig(config({ resource: { iconUrl: value } }));
    if (isValidIconUrl(value)) expect(run).not.toThrow();
    else expect(() => run()).toThrow(/resource\.iconUrl/);
  });

  it("description is limited to 500 characters", () => {
    expect(() => validateConfig(config({ resource: { description: long(500) } }))).not.toThrow();
    expect(() =>
      validateConfig(config({ resource: { description: "\u{1F600}".repeat(500) } })),
    ).not.toThrow();
    const err = refusal({ resource: { description: long(501) } });
    expect(err.route).toBe("generate");
    expect(err.reason).toContain("resource.description");
  });

  it("errors name the route and the field but never the value", () => {
    const err = refusal({ resource: { serviceName: "S3CR3T-\n-name" } });
    expect(err.route).toBe("generate");
    expect(err.message).not.toContain("S3CR3T");
  });
});
