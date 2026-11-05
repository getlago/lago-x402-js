/** `npm run test:package`, after `npm run build`: the package exactly as npm would publish it.
 *
 * 1. `npm pack` the package and check the file list: `package.json`, `dist/**`, `CHANGELOG.md`,
 *    `LICENSE` and `README.md` (optional until it exists), nothing else.
 * 2. Check that `dist` imports only Node built-ins, its own files and declared (peer)
 *    dependencies: the consumers below resolve from the repo's node_modules, which also holds
 *    every dev dependency, so an undeclared runtime import would otherwise go unnoticed.
 * 3. Unpack the tarball into `.package-check/node_modules/lago-x402` inside the repo (git-ignored),
 *    so its dependencies resolve by walking up to the repo's node_modules: no install, no network.
 * 4. From a `"type": "commonjs"` consumer, `require()` every subpath and `import()` it, asserting
 *    the exported names and that both give the same module instance; then the same through
 *    `import()` from an ES module consumer.
 *
 * Removes `.package-check` when done, pass or fail. */
import { execFileSync, spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(ROOT, ".package-check");
const INSTALLED = join(SCRATCH, "node_modules", "lago-x402");

/** Every subpath and exactly the names it exports at runtime: the public API, so an accidental
 * export (or a missing one) fails the check. */
const EXPORTS = {
  "lago-x402": [
    "LagoApiError",
    "LagoUnreachableError",
    "LagoX402ConfigError",
    "LagoX402UsageError",
    "createLagoX402",
  ],
  "lago-x402/express": ["lagoX402"],
  "lago-x402/hono": ["lagoX402"],
  "lago-x402/next": ["withLagoX402"],
};
const TOP_LEVEL_FILES = ["package.json", "README.md", "CHANGELOG.md", "LICENSE"];
const REQUIRED_FILES = ["package.json", "CHANGELOG.md", "LICENSE"];

class CheckFailed extends Error {}

function fail(message) {
  throw new CheckFailed(message);
}

/** `npm pack` into the scratch directory; returns the tarball's path and its file list. */
function pack() {
  const out = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", SCRATCH], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  // npm 10 prints an array, npm 11+ an object keyed by package name.
  const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!result || typeof result.filename !== "string" || !Array.isArray(result.files)) {
    fail("npm pack printed no tarball description");
  }
  return { tarball: join(SCRATCH, result.filename), files: result.files.map((f) => f.path).sort() };
}

function checkFileList(files) {
  const unexpected = files.filter((path) => !TOP_LEVEL_FILES.includes(path) && !path.startsWith("dist/"));
  if (unexpected.length > 0) fail(`unexpected files in the tarball: ${unexpected.join(", ")}`);
  const required = [...REQUIRED_FILES];
  if (existsSync(join(ROOT, "README.md"))) required.push("README.md");
  for (const specifier of Object.keys(EXPORTS)) {
    const name = specifier === "lago-x402" ? "index" : specifier.slice("lago-x402/".length);
    required.push(`dist/${name}.js`, `dist/${name}.d.ts`);
  }
  const missing = required.filter((path) => !files.includes(path));
  if (missing.length > 0) fail(`missing from the tarball: ${missing.join(", ")}`);
}

/** Every module specifier a compiled file loads at runtime (static, re-export, side-effect and
 * dynamic imports; `import type` is erased by tsc). */
function specifiersOf(source) {
  const found = [];
  const patterns = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function checkImports(files) {
  const manifest = JSON.parse(readFileSync(join(INSTALLED, "package.json"), "utf8"));
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const problems = [];
  for (const file of files.filter((path) => path.endsWith(".js"))) {
    for (const specifier of specifiersOf(readFileSync(join(INSTALLED, file), "utf8"))) {
      if (specifier.startsWith(".")) {
        const target = posix.join(posix.dirname(file), specifier);
        if (!files.includes(target)) problems.push(`${file} imports ${specifier}, which is not packed`);
      } else if (specifier.startsWith("node:")) {
        if (!builtinModules.includes(specifier.slice("node:".length))) {
          problems.push(`${file} imports an unknown built-in ${specifier}`);
        }
      } else if (!declared.has(packageNameOf(specifier))) {
        problems.push(`${file} imports ${specifier}, which is not a dependency or peer dependency`);
      }
    }
  }
  if (problems.length > 0) fail(problems.join("\n"));
}

function unpack(tarball) {
  mkdirSync(INSTALLED, { recursive: true });
  // npm tarballs hold everything under `package/`.
  execFileSync("tar", ["-xzf", tarball, "-C", INSTALLED, "--strip-components=1"], { stdio: "pipe" });
}

/** Shared by both consumers: `load(specifier)` gives a module namespace or exports object. */
const ASSERTIONS = String.raw`
const expected = JSON.parse(process.argv[2]);
const installed = process.argv[3];

function exportedNames(ns) {
  // Node adds __esModule to a require()d ES module only when it has a default export.
  return Object.keys(ns).filter((key) => key !== "__esModule").sort();
}

async function check(how, load, resolve) {
  for (const [specifier, names] of Object.entries(expected)) {
    const resolved = resolve(specifier);
    if (!resolved.startsWith(installed)) {
      throw new Error(how + " resolved " + specifier + " outside the unpacked tarball");
    }
    const ns = await load(specifier);
    const actual = exportedNames(ns);
    if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) {
      throw new Error(how + "(" + specifier + ") exports " + JSON.stringify(actual) + ", expected " + JSON.stringify(names));
    }
    for (const name of names) {
      if (typeof ns[name] !== "function") throw new Error(how + "(" + specifier + ")." + name + " is not a function");
    }
  }
}

/** Every adapter throws the core's own LagoX402ConfigError for an object createLagoX402 did not
 * make: the subpaths share one instance of the core module. */
async function checkSharedCore(how, load) {
  const { LagoX402ConfigError } = await load("lago-x402");
  const attach = {
    "lago-x402/express": (m) => m.lagoX402({}, "paid"),
    "lago-x402/hono": (m) => m.lagoX402({}, "paid"),
    "lago-x402/next": (m) => m.withLagoX402({}, "paid", async () => new Response(null)),
  };
  for (const [specifier, call] of Object.entries(attach)) {
    let thrown;
    try {
      call(await load(specifier));
    } catch (err) {
      thrown = err;
    }
    if (!(thrown instanceof LagoX402ConfigError)) {
      throw new Error(how + "(" + specifier + ") does not throw the core's LagoX402ConfigError");
    }
  }
}
`;

const CJS_CONSUMER = `"use strict";
${ASSERTIONS}
(async () => {
  await check("require", (s) => require(s), (s) => require.resolve(s));
  await check("import", (s) => import(s), (s) => require.resolve(s));
  for (const specifier of Object.keys(expected)) {
    const required = require(specifier);
    const imported = await import(specifier);
    for (const name of expected[specifier]) {
      if (required[name] !== imported[name]) {
        throw new Error(specifier + "." + name + ": require() and import() gave different instances");
      }
    }
  }
  await checkSharedCore("require", (s) => require(s));
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`;

const ESM_CONSUMER = `import { fileURLToPath } from "node:url";
${ASSERTIONS}
try {
  await check("import", (s) => import(s), (s) => fileURLToPath(import.meta.resolve(s)));
  await checkSharedCore("import", (s) => import(s));
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
`;

/** Runs a consumer from the scratch directory; its output is shown only when it fails. */
function runConsumer(file) {
  const result = spawnSync(process.execPath, [file, JSON.stringify(EXPORTS), INSTALLED + sep], {
    cwd: SCRATCH,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`${file} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
}

function main() {
  if (!existsSync(join(ROOT, "dist", "index.js"))) fail("dist/ is missing: run `npm run build` first");
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  try {
    const { tarball, files } = pack();
    checkFileList(files);
    unpack(tarball);
    checkImports(files);
    // A package scope of its own, so "lago-x402" never resolves to the repo itself.
    writeFileSync(
      join(SCRATCH, "package.json"),
      JSON.stringify({ name: "lago-x402-package-check", private: true, type: "commonjs" }, null, 2),
    );
    writeFileSync(join(SCRATCH, "consumer.js"), CJS_CONSUMER);
    writeFileSync(join(SCRATCH, "consumer.mjs"), ESM_CONSUMER);
    runConsumer("consumer.js");
    runConsumer("consumer.mjs");
    console.log(`package check passed on Node ${process.versions.node}: ${files.length} files packed`);
    console.log(
      `  require() and import() from CommonJS, import() from ESM: ${Object.keys(EXPORTS).join(", ")}`,
    );
  } finally {
    rmSync(SCRATCH, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  if (!(err instanceof CheckFailed)) throw err;
  console.error(`package check failed: ${err.message}`);
  process.exitCode = 1;
}
