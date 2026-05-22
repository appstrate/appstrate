// SPDX-License-Identifier: Apache-2.0

/**
 * connect-tool contract (spec §4.3) — the pure data boundary between the
 * connect-runner (trusted, in the credential path) and an integration's
 * untrusted `login` MCP tool.
 *
 * Two hard invariants this contract encodes:
 *
 *  1. **The tool never sees a secret.** Its input carries only the *names* of
 *     the credential fields (decision #1 in spec §11), so it can build
 *     `api_call({ body: "…={{identifiant}}…", substituteBody: true })`
 *     placeholders. The trusted proxy substitutes the transient `inputs` at
 *     the egress boundary; the value never crosses into tool code.
 *
 *  2. **The tool's output is validated against `produces`.** The manifest
 *     declares the injectable `outputs` it expects (`connect.tool.produces`);
 *     {@link validateConnectToolResult} projects the tool's returned map down
 *     to exactly those keys and fails closed if any are missing. This is what
 *     makes `produces` the authoritative injectable set that `delivery.*`
 *     gating (spec §4.6) is checked against.
 *
 * Pure module: no DB, no Redis, no sidecar — safe to publish on npm.
 */

/**
 * What the connect-runner hands the `login` tool. Field *names* only — the
 * tool echoes them as `{{name}}` placeholders in its `api_call` bodies; the
 * proxy resolves them from the transient context.
 */
export interface ConnectToolContext {
  /** Auth key being connected (`auths.{key}`), for the tool's bookkeeping. */
  authKey: string;
  /**
   * Names of the bootstrap credential fields available for `{{name}}`
   * substitution. Never the values — substitution is proxy-side.
   */
  inputFields: string[];
}

/**
 * The raw shape a `login` tool returns. The runner validates it via
 * {@link validateConnectToolResult} before it becomes a `CredentialBundle`.
 */
export interface ConnectToolResult {
  /** Injectable material captured by the login dance (session id, token…). */
  outputs: Record<string, string>;
  /** Optional identity claims promoted from the dance → `identity_claims`. */
  identityClaims?: Record<string, string>;
  /** Optional upstream-granted scopes → `scopes_granted`. */
  scopesGranted?: string[];
  /** Optional expiry of the captured material → `expires_at`. */
  expiresAt?: string | null;
}

export type ConnectToolErrorReason =
  | "invalid_result" // not an object / outputs not a string map
  | "empty_outputs" // no produces declared and the tool returned nothing
  | "missing_output"; // a declared `produces` key is absent from outputs

/** Structured failure of the connect-tool contract. Never echoes secret material. */
export class ConnectToolContractError extends Error {
  readonly reason: ConnectToolErrorReason;
  /** When `missing_output`: the `produces` keys the tool failed to return. */
  readonly missing?: string[];

  constructor(reason: ConnectToolErrorReason, message: string, missing?: string[]) {
    super(message);
    this.name = "ConnectToolContractError";
    this.reason = reason;
    if (missing) this.missing = missing;
  }
}

/** Project a raw value to a `Record<string,string>`, dropping non-string entries. */
function toStringMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Validate + normalise a `login` tool's return value into a
 * {@link ConnectToolResult}.
 *
 * - `outputs` must be a non-empty string map.
 * - When `produces` is declared, every promised key MUST be present
 *   (fail-closed) and the result is projected down to exactly those keys —
 *   so an over-sharing tool cannot smuggle extra injectables past the
 *   manifest's declared `produces` set. When `produces` is absent, all string
 *   outputs are kept (must be ≥ 1).
 *
 * Throws {@link ConnectToolContractError} — never includes output *values*
 * in the message, so a failure can't leak captured session material.
 */
export function validateConnectToolResult(
  raw: unknown,
  produces?: readonly string[],
): ConnectToolResult {
  if (typeof raw !== "object" || raw === null || !("outputs" in raw)) {
    throw new ConnectToolContractError(
      "invalid_result",
      "connect-tool result must be an object with an `outputs` map",
    );
  }
  const allOutputs = toStringMap((raw as { outputs: unknown }).outputs);

  let outputs: Record<string, string>;
  if (produces && produces.length > 0) {
    const missing = produces.filter((k) => allOutputs[k] === undefined);
    if (missing.length > 0) {
      throw new ConnectToolContractError(
        "missing_output",
        `connect-tool did not produce declared output(s): ${missing.join(", ")}`,
        missing,
      );
    }
    // Authoritative injectable set = exactly `produces`. Extras are dropped.
    outputs = {};
    for (const k of produces) outputs[k] = allOutputs[k]!;
  } else {
    outputs = allOutputs;
    if (Object.keys(outputs).length === 0) {
      throw new ConnectToolContractError(
        "empty_outputs",
        "connect-tool returned no outputs and the manifest declares no `produces`",
      );
    }
  }

  const result: ConnectToolResult = { outputs };
  const identityClaims = toStringMap((raw as { identityClaims?: unknown }).identityClaims);
  if (Object.keys(identityClaims).length > 0) result.identityClaims = identityClaims;
  const scopes = (raw as { scopesGranted?: unknown }).scopesGranted;
  if (Array.isArray(scopes)) {
    const clean = scopes.filter((s): s is string => typeof s === "string");
    if (clean.length > 0) result.scopesGranted = clean;
  }
  const expiresAt = (raw as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt === "string") result.expiresAt = expiresAt;
  else if (expiresAt === null) result.expiresAt = null;

  return result;
}
