/** Line-by-line port of lago-api's `X402::SignInWithX::Message.build`
 * (`app/services/x402/sign_in_with_x/message.rb`, lago-api main).
 *
 * The cross-implementation tests verify the official client's signature over THIS text,
 * which proves Lago rebuilds exactly what the agent signed. Ruby semantics are kept on
 * purpose: only `nil` and `false` are falsy (an empty string is truthy), `nil` interpolates
 * and joins as `""`, and `split(":", 2)` keeps everything after the first colon. */

type Payload = Record<string, unknown>;

// ACCOUNTS = {"eip155" => "Ethereum", "solana" => "Solana"}.freeze
const ACCOUNTS: Readonly<Record<string, string>> = { eip155: "Ethereum", solana: "Solana" };

/** Ruby truthiness: everything but `nil` and `false`. */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** Ruby `"#{value}"` / `Array#join` for the string-typed values Lago accepts (`nil` → ""). */
function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Ruby `string.split(sep, 2)`: `""` → `[]`, no separator → `[string]`. */
function split2(value: string, separator: string): string[] {
  if (value === "") return [];
  const at = value.indexOf(separator);
  return at === -1 ? [value] : [value.slice(0, at), value.slice(at + separator.length)];
}

/** Ruby `Array(value)`. */
function rubyArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// def self.build(payload, empty_statement_line: true)
export function lagoSiwxMessage(
  payload: Payload,
  { emptyStatementLine }: { emptyStatementLine: boolean } = { emptyStatementLine: true },
): string {
  // namespace, reference = payload["chainId"].to_s.split(":", 2)
  const [namespace, reference] = split2(str(payload.chainId), ":");
  // account = ACCOUNTS.fetch(namespace) { raise ArgumentError, "unsupported chain ..." }
  if (namespace === undefined || !Object.hasOwn(ACCOUNTS, namespace)) {
    throw new Error(`unsupported chain ${str(payload.chainId)}`);
  }
  const account = ACCOUNTS[namespace];

  const lines: unknown[] = [
    `${str(payload.domain)} wants you to sign in with your ${account} account:`,
    payload.address,
    "",
    ...statementLines(payload.statement, emptyStatementLine),
    `URI: ${str(payload.uri)}`,
    `Version: ${str(payload.version)}`,
    `Chain ID: ${str(reference)}`,
    `Nonce: ${str(payload.nonce)}`,
    `Issued At: ${str(payload.issuedAt)}`,
  ];
  // lines.concat(optional_lines(payload))
  lines.push(...optionalLines(payload));
  // lines.join("\n")
  return lines.map(str).join("\n");
}

// def self.statement_lines(statement, empty_statement_line)
function statementLines(statement: unknown, emptyStatementLine: boolean): unknown[] {
  if (truthy(statement)) {
    return [statement, ""];
  } else if (emptyStatementLine) {
    return [""];
  } else {
    return [];
  }
}

// def self.optional_lines(payload)
function optionalLines(payload: Payload): string[] {
  const lines: string[] = [];
  if (truthy(payload.expirationTime)) lines.push(`Expiration Time: ${str(payload.expirationTime)}`);
  if (truthy(payload.notBefore)) lines.push(`Not Before: ${str(payload.notBefore)}`);
  if (truthy(payload.requestId)) lines.push(`Request ID: ${str(payload.requestId)}`);
  // resources = Array(payload["resources"])
  const resources = rubyArray(payload.resources);
  // lines.push("Resources:", *resources.map { |resource| "- #{resource}" }) if resources.any?
  if (resources.some(truthy)) lines.push("Resources:", ...resources.map((resource) => `- ${str(resource)}`));
  return lines;
}
