import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: `next`, `react` and the built package (`dist/`) resolve from there, so
 * the fixture needs no install of its own. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** @type {import("next").NextConfig} */
export default {
  turbopack: { root },
};
