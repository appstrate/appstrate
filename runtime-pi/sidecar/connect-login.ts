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

import {
  resolveAfpsHttpDelivery,
  type AfpsHttpDelivery,
  type HttpDeliveryPlan,
} from "@appstrate/connect";
import type { CredentialBundle } from "@appstrate/connect/connect";
import type { ManifestDeliveryHttp } from "@appstrate/core/sidecar-types";
import type { McpHost } from "./mcp-host.ts";
import type { IntegrationCredentialsSource } from "./integration-credentials-source.ts";
import { logger } from "./logger.ts";

/**
 * AFPS 2.0 `auths.{key}.delivery.http` block — snake_case (`in`, `name`,
 * `value`, `prefix?`, `encoding?`, `allow_server_override?`), as carried on the
 * spawn spec's `connectLogin.deliveryHttp`. The `value` is a
 * `{$credential.<field>}` template; {@link resolveAfpsHttpDelivery} (the same
 * resolver the platform spawn/credentials services use) renders it into a
 * {@link HttpDeliveryPlan} directly.
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
  opts.source.setActiveInputs(opts.inputs, opts.authKey);
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
      // No header to inject — install a zero-value plan so the session's
      // auth still replaces the payload and becomes the active auth.
      const zeroPlan: HttpDeliveryPlan = {
        headerName: "",
        headerPrefix: "",
        value: "",
        allowServerOverride: false,
      };
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
        zeroPlan,
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
    // Close the substitution window unconditionally — the secret-injection
    // window must not stay open past this primitive even on error.
    opts.source.clearActiveInputs();
  }
}

/**
 * Parse the first text content block of a `CallToolResult` as JSON into the
 * login-tool contract. Throws on a missing/non-text first block or invalid
 * JSON, or when `outputs` is absent / not a string map.
 */
function parseLoginToolResult(result: {
  content?: Array<{ type: string; text?: string }>;
}): LoginToolResult {
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
  const identityClaims = coerceStringMap(obj.identityClaims);
  if (identityClaims) out.identityClaims = identityClaims;
  if (typeof obj.expiresAt === "string" || obj.expiresAt === null) {
    out.expiresAt = obj.expiresAt;
  }
  if (Array.isArray(obj.scopesGranted) && obj.scopesGranted.every((s) => typeof s === "string")) {
    out.scopesGranted = obj.scopesGranted as string[];
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
