/** Creates, through Lago's API only, what `npm run test:live` needs, if it is missing:
 *
 * - a billable metric summing the `value` property (`sum_agg`, not recurring);
 * - a usage-only USD monthly plan with one standard charge on that metric at "0.01" a unit,
 *   accepting target wallets (the organization needs `events_targeting_wallets`);
 * - the x402 connection: Base Sepolia (plus Solana devnet when LIVE_SVM_PAYOUT is set), its
 *   payout addresses, the CDP API key, and LIVE_ORIGIN as an allowed origin. When the connection
 *   exists, only LIVE_ORIGIN is added to its allowed origins (no credential is sent again).
 *
 * Then asks Lago for one gate check without sign-in, which must answer a challenge.
 *
 * Run it from the repo root: `node scripts/live-setup.mjs`. It reads, from the environment only:
 * LAGO_API_URL (Lago's API base; /api/v1 is appended when missing), LAGO_API_KEY,
 * CDP_API_KEY_ID, CDP_API_KEY_SECRET (only to create the connection), LIVE_EVM_PAYOUT, optional
 * LIVE_SVM_PAYOUT, and the codes LAGO_X402_CONNECTION_CODE, LIVE_PLAN_CODE, LIVE_METRIC_CODE,
 * LIVE_WALLET_CODE, plus LIVE_ORIGIN and LIVE_TOP_UP_CENTS, with the live test's defaults.
 *
 * Prints only codes, HTTP statuses and Lago's error codes: never a request or a response body
 * (the connection's carries the CDP secret), never an environment value but the codes. The API
 * key goes only to LAGO_API_URL, the CDP key only to its x402 connections endpoint. */

const env = process.env;
const BASE_SEPOLIA = "eip155:84532";
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/** What Lago may surface of an answer: identifier-shaped codes only. */
const SAFE_CODE = /^[A-Za-z0-9_.]{1,64}$/;

class SetupFailed extends Error {}

function setting(name, fallback) {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

function required(name) {
  const value = env[name];
  if (value === undefined || value === "") throw new SetupFailed(`${name} is not set`);
  return value;
}

function apiBase(raw) {
  let url;
  try {
    url = new URL(raw.replace(/\/+$/, ""));
  } catch {
    throw new SetupFailed("LAGO_API_URL is not a URL");
  }
  if (!url.pathname.endsWith("/api/v1")) url.pathname = url.pathname.replace(/\/+$/, "") + "/api/v1";
  return url.href;
}

/** `HTTP status code [field: codes]`, from identifier-shaped values only. */
function codesOf(answer) {
  const parts = [`HTTP ${answer.status}`];
  const body = answer.body;
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    if (SAFE_CODE.test(String(body.code ?? ""))) parts.push(body.code);
    const details = body.error_details;
    if (details !== null && typeof details === "object" && !Array.isArray(details)) {
      for (const [field, codes] of Object.entries(details)) {
        if (!SAFE_CODE.test(field) || !Array.isArray(codes)) continue;
        const safe = codes.filter((code) => typeof code === "string" && SAFE_CODE.test(code));
        if (safe.length > 0) parts.push(`[${field}: ${safe.join(", ")}]`);
      }
    }
  }
  return parts.join(" ");
}

function hint(answer) {
  const code = answer.body?.code;
  if (answer.status === 401) return " (check LAGO_API_KEY)";
  if (answer.status === 403 && typeof code === "string" && code.startsWith("write_action_not_allowed")) {
    return " (the API key lacks this permission)";
  }
  if (code === "feature_unavailable") return " (premium license or x402_payments flag missing)";
  return "";
}

async function main() {
  const api = apiBase(required("LAGO_API_URL"));
  const apiKey = required("LAGO_API_KEY");
  const connectionCode = setting("LAGO_X402_CONNECTION_CODE", "lago_x402_js_live");
  const planCode = setting("LIVE_PLAN_CODE", "lago_x402_js_live_plan");
  const metricCode = setting("LIVE_METRIC_CODE", "lago_x402_js_live_units");
  const walletCode = setting("LIVE_WALLET_CODE", "lago_x402_js_live_credits");
  const origin = setting("LIVE_ORIGIN", "http://localhost:4021");
  const topUpCents = Number(setting("LIVE_TOP_UP_CENTS", "3"));
  if (!Number.isSafeInteger(topUpCents) || topUpCents <= 0) {
    throw new SetupFailed("LIVE_TOP_UP_CENTS must be a positive integer");
  }

  async function lago(method, path, body) {
    let res;
    try {
      res = await fetch(api + path, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      // A system code (ECONNREFUSED, a TLS verification code) or the error's name: never its
      // message, which may name the host.
      const code = err?.cause?.code ?? err?.name;
      throw new SetupFailed(
        `cannot reach Lago (${SAFE_CODE.test(String(code)) ? code : "network error"})` +
          (String(code).includes("CERT") ? "; for a local CA, set NODE_EXTRA_CA_CERTS" : ""),
      );
    }
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      // No JSON body: the status says enough.
    }
    return { status: res.status, body: parsed };
  }

  function ok(what, answer) {
    if (answer.status >= 200 && answer.status < 300) return;
    throw new SetupFailed(`${what}: ${codesOf(answer)}${hint(answer)}`);
  }

  const say = (line) => console.log(line);
  const segment = encodeURIComponent;

  // 1. The billable metric.
  let metric = await lago("GET", `/billable_metrics/${segment(metricCode)}`);
  if (metric.status === 404) {
    const created = await lago("POST", "/billable_metrics", {
      billable_metric: {
        name: "lago-x402-js live units",
        code: metricCode,
        description: "Units the lago-x402 live test reports (properties.value).",
        aggregation_type: "sum_agg",
        field_name: "value",
        recurring: false,
      },
    });
    ok(`billable metric ${metricCode}: create`, created);
    say(`billable metric ${metricCode}: created (${created.status})`);
    metric = created;
  } else {
    ok(`billable metric ${metricCode}: read`, metric);
    say(`billable metric ${metricCode}: exists (${metric.status})`);
  }
  const bm = metric.body?.billable_metric ?? {};
  const metricProblems = [];
  if (bm.aggregation_type !== "sum_agg") metricProblems.push("aggregation_type must be sum_agg");
  if (bm.field_name !== "value") metricProblems.push('field_name must be "value"');
  if (bm.recurring !== false) metricProblems.push("recurring must be false");
  if (bm.expression) metricProblems.push("expression must be empty");
  if (metricProblems.length > 0) {
    throw new SetupFailed(
      `billable metric ${metricCode} cannot bill x402 calls: ${metricProblems.join("; ")}`,
    );
  }
  if (typeof bm.lago_id !== "string") throw new SetupFailed(`billable metric ${metricCode}: no lago_id`);

  // 2. The plan.
  let plan = await lago("GET", `/plans/${segment(planCode)}`);
  if (plan.status === 404) {
    const created = await lago("POST", "/plans", {
      plan: {
        name: "lago-x402-js live plan",
        code: planCode,
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        pay_in_advance: false,
        charges: [
          {
            billable_metric_id: bm.lago_id,
            charge_model: "standard",
            pay_in_advance: false,
            invoiceable: true,
            accepts_target_wallet: true,
            properties: { amount: "0.01" },
          },
        ],
      },
    });
    ok(`plan ${planCode}: create`, created);
    say(`plan ${planCode}: created (${created.status})`);
    plan = created;
  } else {
    ok(`plan ${planCode}: read`, plan);
    say(`plan ${planCode}: exists (${plan.status})`);
  }
  const p = plan.body?.plan ?? {};
  const charges = Array.isArray(p.charges)
    ? p.charges.filter((c) => c?.billable_metric_code === metricCode)
    : [];
  const planProblems = [];
  if (p.amount_currency !== "USD") planProblems.push("currency must be USD");
  if (p.amount_cents !== 0) planProblems.push("amount_cents must be 0 (usage only)");
  if (charges.length === 0) planProblems.push(`no charge on ${metricCode}`);
  if (charges.some((c) => c.accepts_target_wallet !== true)) {
    planProblems.push(
      "its charge does not accept target wallets (is events_targeting_wallets enabled for the organization?)",
    );
  }
  if (planProblems.length > 0) {
    throw new SetupFailed(`plan ${planCode} cannot gate x402 calls: ${planProblems.join("; ")}`);
  }

  // 3. The x402 connection.
  const connection = await lago("GET", `/x402_connections/${segment(connectionCode)}`);
  if (connection.status === 404) {
    const svmPayout = env.LIVE_SVM_PAYOUT;
    const networks = svmPayout ? [BASE_SEPOLIA, SOLANA_DEVNET] : [BASE_SEPOLIA];
    const created = await lago("POST", "/x402_connections", {
      x402_connection: {
        code: connectionCode,
        name: "lago-x402-js live",
        networks,
        payout_addresses: { evm: required("LIVE_EVM_PAYOUT"), ...(svmPayout ? { svm: svmPayout } : {}) },
        cdp_api_key_id: required("CDP_API_KEY_ID"),
        cdp_api_key_secret: required("CDP_API_KEY_SECRET"),
        allowed_origins: [origin],
        auto_create_customers: true,
      },
    });
    ok(`x402 connection ${connectionCode}: create`, created);
    say(`x402 connection ${connectionCode}: created (${created.status}), ${networks.length} network(s)`);
  } else {
    ok(`x402 connection ${connectionCode}: read`, connection);
    const current = connection.body?.x402_connection ?? {};
    const origins = Array.isArray(current.allowed_origins) ? current.allowed_origins : [];
    const count = Array.isArray(current.networks) ? current.networks.length : 0;
    if (origins.includes(origin)) {
      say(
        `x402 connection ${connectionCode}: exists (${connection.status}), ${count} network(s), origin allowed`,
      );
    } else {
      const updated = await lago("PUT", `/x402_connections/${segment(connectionCode)}`, {
        x402_connection: { allowed_origins: [...origins, origin] },
      });
      ok(`x402 connection ${connectionCode}: update allowed_origins`, updated);
      say(`x402 connection ${connectionCode}: exists, ${count} network(s), origin added (${updated.status})`);
    }
  }

  // 4. One gate check without sign-in: the route must answer a challenge with sign-in chains.
  const check = await lago("POST", "/x402/gate_checks", {
    gate_check: {
      connection_code: connectionCode,
      plan_code: planCode,
      billable_metric_code: metricCode,
      wallet_code: walletCode,
      amount_cents: topUpCents,
      estimated_call_cost_cents: 1,
    },
  });
  ok("gate check", check);
  const gate = check.body?.gate_check ?? {};
  if (!Array.isArray(gate.requirements) || !Array.isArray(gate.sign_in_chains)) {
    throw new SetupFailed(
      "gate check: no challenge with sign-in chains (does this Lago support sign-in-with-x on gate checks? lago-api main since 26 October 2026)",
    );
  }
  const offMainnet = gate.requirements.every(
    (r) => r?.network === BASE_SEPOLIA || r?.network === SOLANA_DEVNET,
  );
  if (!offMainnet) throw new SetupFailed("gate check: a requirement is not on Base Sepolia or Solana devnet");
  say(
    `gate check: challenge (${check.status}), ${gate.requirements.length} requirement(s), ` +
      `${gate.sign_in_chains.length} sign-in chain(s), testnets only`,
  );
  say("ready for npm run test:live");
}

try {
  await main();
} catch (err) {
  if (!(err instanceof SetupFailed)) {
    // Never print an unexpected error's message: it could quote a body.
    console.error(`live setup failed unexpectedly (${err?.name ?? "error"})`);
  } else {
    console.error(`live setup failed: ${err.message}`);
  }
  process.exitCode = 1;
}
