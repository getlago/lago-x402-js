/** Suite-wide network guard.
 *
 * A unit test that stubs HTTP by patching one function keeps "passing" after the code
 * moves to a different call path: it just starts hitting the real API instead.
 *
 * Guarding at the DISPATCHER rather than at `globalThis.fetch` is the point: it is the
 * layer every `fetch` call funnels through, so it cannot be sidestepped by a module that
 * captured `fetch` earlier or by a rename of the calling function.
 *
 * `127.0.0.1` stays reachable on purpose. Some properties in this suite (timeouts,
 * redirects, socket behaviour) are only honestly tested against a real server. Allowing
 * loopback keeps those tests real while everything else is sealed.
 */
import { MockAgent, setGlobalDispatcher } from "undici";

/** Loopback in the forms undici presents an origin in: bare host, or host:port. */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect(LOOPBACK);
setGlobalDispatcher(agent);
