import { LagoUnreachableError, type LagoEndpoint } from "./errors.js";

export type { LagoEndpoint } from "./errors.js";

/** The one HTTP client every Lago call goes through. The key is held in a private field
 * (invisible to inspect/JSON), sent only to `apiUrl`, and never across a redirect. */
export class LagoClient {
  readonly #base: string;
  readonly #apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.#base = apiUrl.replace(/\/+$/, "");
    this.#apiKey = apiKey;
  }

  /** Never throws on an HTTP status; `body` is parsed JSON or `null`. Network errors,
   * timeouts and redirects throw `LagoUnreachableError` (carrying no underlying error). */
  async request(
    endpoint: LagoEndpoint,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(this.#base + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed };
    } catch {
      throw new LagoUnreachableError(endpoint, signal.aborted ? "timeout" : "network");
    }
  }
}
