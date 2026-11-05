/** The suite's network guard is wired, and wired the way the tests need it.
 *
 * Not a test of `undici`: that it can block an origin is its own business. This tests
 * OUR decision: that the guard is installed for every file in this suite, and that
 * loopback stays exempt so tests whose subject IS socket behaviour can stand up a real
 * server. Delete `setupFiles` from `vitest.config.ts` and the first case fails;
 * over-tighten the exemption and the second does.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

describe("unit tests cannot reach the network", () => {
  it("refuses a request to a remote origin", async () => {
    await expect(fetch("https://api.getlago.com/api/v1/events")).rejects.toThrow();
  });

  it("still allows a real loopback server", async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/gate_checks`, { method: "POST" });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });
});
