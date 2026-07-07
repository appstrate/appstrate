// SPDX-License-Identifier: Apache-2.0

/**
 * Connect-login execution substrate (P1) — sidecar-side primitive.
 *
 * Calls an integration's `login` MCP tool with the user's transient login
 * secret substituted into the tool's outbound HTTP **proxy-side**, then
 * captures the resulting session so it becomes injectable for the rest of
 * the run.
 *
 * Security contract:
 *   - The login tool is invoked with `arguments: {}`. The raw login secret
 *     is delivered ONLY via the MITM proxy's transient-input substitution
 *     (opened here via `source.setActiveInputs`), never as a tool argument.
 *     The tool code therefore never receives the secret.
 *   - The substitution window is opened before the tool call and closed in
 *     a `finally`, so it shuts even on error — the secret can never leak
 *     into a later, unrelated request.
 *   - Neither the inputs nor the captured outputs are ever logged, and the
 *     inputs never appear in the returned bundle.
 */

import { resolveAfpsHttpDelivery, type AfpsHttpDelivery } from "@appstrate/connect/afps-delivery";
import type { CredentialBundle } from "@appstrate/connect/connect";
import type { ManifestDeliveryHttp } from "@appstrate/core/sidecar-types";
import type { McpHost } from "./mcp-host.ts";
import type { IntegrationCredentialsSource } from "./integration-credentials-source.ts";
import { logger } from "./logger.ts";

/**
 * AFPS `auths.{key}.delivery.http` block — snake_case (`in`, `name`,
 * `value`, `prefix?`, `encoding?`, `allow_server_override?`), as carried on the
 * spawn spec's `connectLogin.deliveryHttp`. The `value` is a
 * `{$credential.<field>}` template; {@link resolveAfpsHttpDelivery} (the same
 * resolver the platform spawn/credentials services use) renders it into a
 * concrete `HttpDeliveryPlan` directly.
 */
type DeliveryHttp = ManifestDeliveryHttp;

export interface RunConnectLoginOptions {
  /** Multiplexing host holding the integration's connected MCP client. */
  host: McpHost;
  /** Normalised namespace the integration registered under. */
  namespace: string;
  /** Login tool name as advertised by the upstream (un-namespaced). */
  toolName: string;
  /**
   * Optional allowlist of output keys the login tool is permitted to
   * produce. When provided, every key of the tool's `outputs` must appear
   * here — an unexpected key fails the call.
   */
  produces?: readonly string[];
  /** Transient login secret(s), keyed by placeholder name. Never logged. */
  inputs: Record<string, string>;
  /** Credentials source whose substitution window + session we drive. */
  source: IntegrationCredentialsSource;
  /** Auth key the captured session maps to. */
  authKey: string;
  /** Auth type (`oauth2`, `api_key`, …) — drives delivery defaults. */
  authType: string;
  /** URL allowlist carried onto the captured session. */
  authorizedUris: readonly string[];
  /** Manifest `delivery.http` block used to render the session header. */
  deliveryHttp: DeliveryHttp;
}

interface LoginToolResult {
  outputs: Record<string, string>;
  identityClaims?: Record<string, string>;
  expiresAt?: string | null;
  scopesGranted?: string[];
}

/**
 * Run the connect-login flow against an integration's `login` MCP tool.
 *
 * Returns the captured {@link CredentialBundle} (outputs + optional
 * metadata). The bundle never carries the transient inputs.
 */
export async function runConnectLogin(opts: RunConnectLoginOptions): Promise<CredentialBundle> {
  // Open the proxy-side substitution window. From here until the `finally`
  // below, the MITM listener will substitute `{{key}}` placeholders in the
  // login tool's outbound requests. Passing `authKey` also suppresses that
  // auth's (possibly stale) delivery plan for the duration, so the login tool's
  // own headers — e.g. a cookie jar carried across the login redirect chain —
  // reach upstream untouched and a re-login isn't clobbered by the dead session.
  // The `authorizedUris` envelope binds substitution to the login's declared
  // targets — the transient secret is only ever substituted for a request whose
  // URL matches one of them, never leaked to an off-allowlist host (P2-1).
  opts.source.setActiveInputs(opts.inputs, opts.authKey, opts.authorizedUris);
  try {
    const client = opts.host.getUpstreamClient(opts.namespace);
    if (!client) {
      throw new Error(
        `connect-login: no upstream client registered for namespace '${opts.namespace}'`,
      );
    }

    // The secret is delivered ONLY via proxy-side substitution — the tool
    // is called with empty arguments (security contract).
    const result = await client.callTool({ name: opts.toolName, arguments: {} }, {});

    const parsed = parseLoginToolResult(result);

    // Validate the outputs against the declared `produces` allowlist.
    if (Object.keys(parsed.outputs).length === 0) {
      throw new Error("connect-login: login tool returned empty outputs");
    }
    if (opts.produces) {
      const allowed = new Set(opts.produces);
      for (const key of Object.keys(parsed.outputs)) {
        if (!allowed.has(key)) {
          throw new Error(`connect-login: login tool produced undeclared output '${key}'`);
        }
      }
    }

    // Render the session's delivery plan and install it as the integration's
    // injectable session. A null plan (e.g. custom auth with no header) still
    // installs the auth, but leaves deliveryPlans untouched (nothing to inject).
    const plan = resolveAfpsHttpDelivery(
      opts.authType,
      parsed.outputs,
      opts.deliveryHttp as AfpsHttpDelivery,
    );
    if (plan) {
      opts.source.setSessionOutputs(
        {
          authKey: opts.authKey,
          authType: opts.authType,
          fields: parsed.outputs,
          authorizedUris: [...opts.authorizedUris],
          ...(parsed.identityClaims ? { identityClaims: parsed.identityClaims } : {}),
          ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
          ...(parsed.scopesGranted ? { scopesGranted: parsed.scopesGranted } : {}),
        },
        plan,
      );
    } else {
      // P1 hardening (R8a) — refuse the zero-plan installation path that
      // used to silently install a `{ headerName: "", value: "" }`
      // injection rule. An empty headerName masks two real misconfigurations:
      //   (a) the manifest declared `delivery.http` with an empty `name`
      //       (schema enforces minLength: 1, but a hand-crafted spec /
      //       direct DB write could still reach here), and
      //   (b) the manifest declared NO http delivery at all but routed
      //       the auth through the connect-login primitive without
      //       declaring an alternative (`delivery.env`).
      // Either way, the runtime can't legitimately inject anything; the
      // older behaviour produced silent auth failures upstream rather than
      // a clear boot error. AFPS §7.3 requires every auth to declare
      // either `delivery.env` or `delivery.http` with a non-empty header
      // name — surface that requirement here.
      throw new Error(
        `connect-login: auth '${opts.authKey}' for integration namespace '${opts.namespace}' resolved to no injectable header. Manifest must declare either delivery.env or delivery.http with a non-empty header name.`,
      );
    }

    logger.info("connect-login captured session", {
      namespace: opts.namespace,
      authKey: opts.authKey,
      // Counts only — never the values.
      outputCount: Object.keys(parsed.outputs).length,
    });

    return {
      outputs: parsed.outputs,
      ...(parsed.identityClaims ? { identityClaims: parsed.identityClaims } : {}),
      ...(parsed.expiresAt !== undefined ? { expiresAt: parsed.expiresAt } : {}),
      ...(parsed.scopesGranted ? { scopesGranted: parsed.scopesGranted } : {}),
    };
  } finally {
    // Close ONLY this login's substitution window unconditionally — the
    // secret-injection window must not stay open past this primitive even on
    // error. Scoping to `authKey` leaves a concurrent re-login's window intact
    // (a clear-all would reopen the other login to a spurious 401 — P3).
    opts.source.clearActiveInputs(opts.authKey);
  }
}

/**
 * Parse the first text content block of a `CallToolResult` as JSON into the
 * login-tool contract. Throws on a missing/non-text first block or invalid
 * JSON, or when `outputs` is absent / not a string map.
 */
function parseLoginToolResult(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): LoginToolResult {
  // Honor the tool-level error flag. An `isError: true` CallToolResult is a
  // failure signal, NOT a session payload — parsing its content as login
  // outputs would either throw an opaque JSON error or, worse, mis-capture an
  // error body as a "session". Surface the tool's own text as the failure.
  if (result.isError) {
    const errFirst = result.content?.[0];
    const detail =
      errFirst && errFirst.type === "text" && typeof errFirst.text === "string"
        ? errFirst.text
        : "";
    throw new Error(`connect-login: login tool reported an error${detail ? `: ${detail}` : ""}`);
  }
  const first = result.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("connect-login: login tool result missing a text content block");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(first.text);
  } catch {
    throw new Error("connect-login: login tool result is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("connect-login: login tool result is not a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const outputs = coerceStringMap(obj.outputs);
  if (!outputs) {
    throw new Error("connect-login: login tool result `outputs` is not a string map");
  }
  const out: LoginToolResult = { outputs };
  // AFPS wire format is canonical snake_case (`identity_claims`, `expires_at`,
  // `scopes_granted`).
  const identityClaims = coerceStringMap(obj.identity_claims);
  if (identityClaims) out.identityClaims = identityClaims;
  const expiresAtRaw = obj.expires_at;
  if (typeof expiresAtRaw === "string" || expiresAtRaw === null) {
    out.expiresAt = expiresAtRaw;
  }
  const scopesGrantedRaw = obj.scopes_granted;
  if (Array.isArray(scopesGrantedRaw) && scopesGrantedRaw.every((s) => typeof s === "string")) {
    out.scopesGranted = scopesGrantedRaw as string[];
  }
  return out;
}

/** Narrow an unknown to a flat `Record<string, string>`, or `null`. */
function coerceStringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}
