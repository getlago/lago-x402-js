/** Boot checks: before a route serves, Lago must confirm it can bill it. Two reads per route:
 * the billable metric (it must sum the `value` property the usage event sends), then leg 1's
 * E7, which must answer a challenge an agent can sign in to (lago-api with INT-331).
 *
 * A route is `checking` until its first check ends, then `active`, `refused` (for good) or
 * `unreachable` (retried in the background, 1 s doubling to 60 s, on unref'd timers). Reasons
 * carry only fixed text, endpoint names, HTTP statuses and sanitized Lago codes, never a body. */
import type { LagoX402ErrorWhere, NormalizedConfig, NormalizedRoute } from "./config.js";
import { LagoApiError, LagoUnreachableError, LagoX402ConfigError } from "./errors.js";
import { GATE_CHECKS_PATH, gateCheckBody } from "./gate.js";
import type { LagoClient } from "./lago-client.js";
import { parseGateCheck, renderSignIn } from "./wire.js";

export type CheckResult = { ok: true } | { ok: false; definitive: boolean; reason: string };

export type RouteState = "checking" | "active" | "refused" | "unreachable";

export interface BootOptions {
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface Refusal {
  route: string;
  reason: string;
}

type Report = (err: Error, where: LagoX402ErrorWhere) => void;

/** Lago codes and error names a reason may quote (context §3). */
const SAFE_CODE = /^[A-Za-z0-9_.]{1,64}$/;
const NO_SIGN_IN = "this Lago does not support sign-in-with-x; it needs lago-api with INT-331";

const OK: CheckResult = { ok: true };
const definitive = (reason: string): CheckResult => ({ ok: false, definitive: true, reason });
const unreachable = (reason: string): CheckResult => ({ ok: false, definitive: false, reason });

/** Answers worth waiting out rather than refusing a route for: Lago or a proxy in front of it
 * is down, busy or slow. Everything else is Lago's verdict on the configuration. */
function transient(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The metric as a reason may name it: quoted only when its code is log-safe. */
function metricLabel(route: NormalizedRoute): string {
  return SAFE_CODE.test(route.billableMetric)
    ? `billable metric "${route.billableMetric}"`
    : "the route's billable metric";
}

/** The n-th background retry's delay (n from 1): base, doubling, capped. */
export function retryDelayMs(retry: number, o: BootOptions): number {
  return Math.min(o.retryMaxMs, o.retryBaseMs * 2 ** (retry - 1));
}

/** What makes a metric unable to bill the event the middleware sends
 * (`properties.value`, summed, per call). */
function metricProblems(metric: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const aggregation = metric.aggregation_type;
  if (aggregation !== "sum_agg") {
    const is = typeof aggregation === "string" && SAFE_CODE.test(aggregation) ? ` (is ${aggregation})` : "";
    problems.push(`aggregation_type must be sum_agg${is}`);
  }
  if (metric.field_name !== "value") problems.push('field_name must be "value"');
  const expression = metric.expression;
  if (expression !== null && expression !== undefined && expression !== "") {
    problems.push("expression must be empty");
  }
  if (metric.recurring !== false) problems.push("recurring must be false");
  return problems;
}

async function checkMetric(
  client: LagoClient,
  config: NormalizedConfig,
  route: NormalizedRoute,
): Promise<CheckResult> {
  const answer = await client.request(
    "billable_metrics",
    "GET",
    `/billable_metrics/${encodeURIComponent(route.billableMetric)}`,
    undefined,
    config.timeouts.gateCheckMs,
  );
  if (answer.status !== 200) {
    const err = new LagoApiError("billable_metrics", answer.status, answer.body);
    if (transient(answer.status)) return unreachable(err.message);
    // Only Lago's own 404 means "no such metric"; a bare 404 more likely means a wrong apiUrl.
    if (answer.status === 404 && err.code === "billable_metric_not_found") {
      return definitive(`${metricLabel(route)} not found in Lago (${err.code})`);
    }
    return definitive(err.message);
  }
  const metric = isPlainObject(answer.body) ? answer.body.billable_metric : undefined;
  if (!isPlainObject(metric)) {
    return definitive(new LagoApiError("billable_metrics", 200, { code: "unexpected_answer" }).message);
  }
  const problems = metricProblems(metric);
  if (problems.length > 0) {
    return definitive(`${metricLabel(route)} cannot bill x402 calls: ${problems.join("; ")}`);
  }
  return OK;
}

async function checkGate(
  client: LagoClient,
  config: NormalizedConfig,
  route: NormalizedRoute,
): Promise<CheckResult> {
  const answer = await client.request(
    "gate_checks",
    "POST",
    GATE_CHECKS_PATH,
    gateCheckBody(config, route),
    config.timeouts.gateCheckMs,
  );
  if (answer.status !== 200) {
    const err = new LagoApiError("gate_checks", answer.status, answer.body);
    // third_party_error: Lago could not read the facilitator (Solana fee payer) for this
    // challenge, an outage on their side rather than a verdict on the route.
    if (transient(answer.status) || err.code === "third_party_error") return unreachable(err.message);
    return definitive(err.message);
  }
  let gate: ReturnType<typeof parseGateCheck>;
  try {
    gate = parseGateCheck(answer.body);
  } catch (err) {
    if (err instanceof LagoApiError) return definitive(NO_SIGN_IN);
    throw err;
  }
  if (gate.kind === "pass") return definitive("Lago passed a request without a sign-in");
  // Rendered exactly as a 402 would be: chains no agent can sign with do not count.
  const signIn = renderSignIn({
    origin: config.origin,
    resourceUrl: config.origin.origin + "/",
    statement: config.signInStatement,
    signInChains: gate.signInChains,
  });
  if (signIn.supportedChains.length === 0) {
    return definitive("Lago's challenge offers no sign-in chain this middleware can render");
  }
  return OK;
}

/** One boot check of one route. Never rejects. */
export async function checkRoute(
  client: LagoClient,
  config: NormalizedConfig,
  route: NormalizedRoute,
): Promise<CheckResult> {
  try {
    const metric = await checkMetric(client, config, route);
    if (!metric.ok) return metric;
    return await checkGate(client, config, route);
  } catch (err) {
    if (err instanceof LagoUnreachableError) return unreachable(err.message);
    const name = err instanceof Error && SAFE_CODE.test(err.name) ? err.name : "unknown";
    return unreachable(`boot check failed unexpectedly (${name})`);
  }
}

/** Every route's state, the first round of checks, and the background retries. */
export class Boot {
  readonly #client: LagoClient;
  readonly #config: NormalizedConfig;
  readonly #report: Report;
  readonly #options: BootOptions;
  readonly #states = new Map<string, RouteState>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #stopped = false;

  constructor(client: LagoClient, config: NormalizedConfig, report: Report, options: BootOptions) {
    this.#client = client;
    this.#config = config;
    this.#report = report;
    this.#options = options;
  }

  /** Checks every route concurrently. Resolves with the definitive refusals, in config order;
   * when there are none, unreachable routes start retrying in the background. */
  async start(): Promise<Refusal[]> {
    const names = [...this.#config.routes.keys()];
    for (const name of names) this.#states.set(name, "checking");
    const results = await Promise.all(names.map((name) => this.#check(name)));
    const refused: Refusal[] = [];
    const retry: string[] = [];
    results.forEach((result, i) => {
      const name = names[i];
      if (result.ok) this.#states.set(name, "active");
      else if (result.definitive) {
        this.#states.set(name, "refused");
        refused.push({ route: name, reason: result.reason });
      } else {
        this.#states.set(name, "unreachable");
        this.#notify(unreachableError(name, result.reason));
        retry.push(name);
      }
    });
    // A refusal rejects the whole boot: nothing is left retrying behind it.
    if (refused.length === 0) for (const name of retry) this.#schedule(name, 1);
    return refused;
  }

  state(name: string): RouteState | undefined {
    return this.#states.get(name);
  }

  /** No retry runs after this, and a check still in flight is ignored when it ends. */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  #check(name: string): Promise<CheckResult> {
    return checkRoute(this.#client, this.#config, this.#config.routes.get(name)!);
  }

  #schedule(name: string, retry: number): void {
    if (this.#stopped) return;
    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        void this.#retry(name, retry);
      },
      retryDelayMs(retry, this.#options),
    );
    // A route waiting for Lago must never keep the process alive.
    timer.unref();
    this.#timers.add(timer);
  }

  async #retry(name: string, retry: number): Promise<void> {
    const result = await this.#check(name);
    if (this.#stopped) return;
    if (result.ok) {
      this.#states.set(name, "active");
    } else if (result.definitive) {
      this.#states.set(name, "refused");
      this.#notify(new LagoX402ConfigError(name, result.reason));
    } else {
      this.#notify(unreachableError(name, result.reason));
      this.#schedule(name, retry + 1);
    }
  }

  #notify(err: Error): void {
    try {
      this.#report(err, "boot");
    } catch {
      // A failing reporter must never stop the retries.
    }
  }
}

/** A failed attempt on a route that will be retried (route names are log-safe by config). */
function unreachableError(name: string, reason: string): Error {
  return new Error(`lago-x402 route "${name}": ${reason}; retrying`);
}
