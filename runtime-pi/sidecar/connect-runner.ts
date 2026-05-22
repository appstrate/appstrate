// SPDX-License-Identifier: Apache-2.0

/**
 * connect-runner — executes an integration's `login` MCP tool (the
 * OrchestratedStrategy, spec §4.3/§4.4) and collects a {@link CredentialBundle}.
 *
 * Boundary (spec §4.7): EXECUTION lives in the sidecar. This module owns the
 * orchestration of one login dance; it deliberately does NOT do credential
 * substitution itself — that stays in the egress proxy (`credential-proxy.ts`
 * / MITM), which substitutes the transient `inputs` into the tool's
 * `api_call({ substituteBody:true })` bodies at the boundary. The runner only:
 *
 *   1. builds the **names-only** {@link ConnectToolContext} — the tool learns
 *      *which* `{{placeholders}}` it may use, never their values (invariant
 *      §1.2.1: the secret never reaches the tool's code), and
 *   2. validates the tool's return against the manifest's `produces`
 *      (`validateConnectToolResult`), failing closed and never echoing
 *      captured material.
 *
 * The actual MCP `tools/call` (and parsing the structured result into a plain
 * object) is injected as a {@link ConnectToolInvoker}, so this orchestration is
 * unit-testable in process mode without a container — the same DI posture the
 * rest of the sidecar uses.
 */

import {
  validateConnectToolResult,
  type ConnectToolContext,
  type CredentialBundle,
} from "@appstrate/connect/connect";

/**
 * Invokes the integration's login tool. Production wires this to the spawned
 * integration MCP client's `tools/call` (parsing the `CallToolResult` content
 * into the plain `{ outputs, … }` object the contract expects). The transient
 * `inputs` credential source must already be installed on the egress path so
 * the tool's `api_call` bodies resolve `{{name}}` placeholders proxy-side.
 *
 * Receives the names-only context — never the secret values.
 */
export type ConnectToolInvoker = (
  toolName: string,
  context: ConnectToolContext,
) => Promise<unknown>;

export interface RunConnectToolInput {
  /** Auth key being connected (`auths.{key}`). */
  authKey: string;
  /** MCP tool name from `connect.tool`. */
  toolName: string;
  /**
   * Names of the bootstrap credential fields the tool may reference as
   * `{{name}}`. Names ONLY — the values live in the transient proxy context.
   */
  inputFields: string[];
  /** Injectable outputs the tool is expected to produce (`connect.produces`). */
  produces?: readonly string[];
}

/**
 * Run one connect-tool login dance and return the validated bundle.
 * Throws `ConnectToolContractError` (from the pure contract) on a malformed or
 * incomplete result — never with secret material in the message.
 */
export async function runConnectTool(
  input: RunConnectToolInput,
  invoke: ConnectToolInvoker,
): Promise<CredentialBundle> {
  const context: ConnectToolContext = {
    authKey: input.authKey,
    inputFields: [...input.inputFields],
  };
  const raw = await invoke(input.toolName, context);
  const result = validateConnectToolResult(raw, input.produces);
  return {
    outputs: result.outputs,
    ...(result.identityClaims ? { identityClaims: result.identityClaims } : {}),
    ...(result.scopesGranted ? { scopesGranted: result.scopesGranted } : {}),
    expiresAt: result.expiresAt ?? null,
  };
}
