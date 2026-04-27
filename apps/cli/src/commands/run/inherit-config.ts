// SPDX-License-Identifier: Apache-2.0

/**
 * Fetch the per-application run-config for `<appId, packageId>` and
 * merge it with the user's CLI flags + env vars. Source of truth lives
 * server-side at `GET /api/applications/{appId}/packages/{scope}/{name}/run-config`
 * — the UI consumes the same payload, so a CLI run with no overrides
 * reproduces the UI run byte-for-byte.
 *
 * Merge order (highest priority first):
 *   1. Explicit CLI flags (--config / --model / --proxy / @spec)
 *   2. Environment variables (APPSTRATE_MODEL / APPSTRATE_PROXY)
 *   3. `run-config` payload returned by the API
 *   4. Built-in defaults (none for these fields)
 *
 * 404 from the run-config endpoint is "no inheritance, fall back to
 * flags + defaults" — typical for a system agent that hasn't been
 * installed in the application. Anything else bubbles as a hard error.
 */

import { CLI_USER_AGENT } from "../../lib/version.ts";
import { normalizeInstance } from "../../lib/instance-url.ts";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import { deepMergeConfig } from "@appstrate/core/schema-validation";

export { deepMergeConfig };

/**
 * Wire shape returned by the run-config endpoint. The canonical type
 * lives in `@appstrate/shared-types`; this alias keeps the legacy
 * CLI-local name available to existing callers and tests.
 */
export type ResolvedRunConfigPayload = ResolvedRunConfig;

export interface InheritedRunConfig {
  /** Resolved agent config (merge of inherited + flag overrides). */
  config: Record<string, unknown>;
  /** Model id to pass to the run pipeline, or null when nothing is set. */
  modelId: string | null;
  /** Proxy id to pass to the run pipeline, or null when nothing is set. */
  proxyId: string | null;
  /** Pinned version label, when the user did not provide an explicit @spec. */
  versionPin: string | null;
  /** Provider ids declared on the package's manifest. Empty when run-config was not consulted. */
  requiredProviders: string[];
  /** True when the API call returned 200; false when it 404'd or was skipped. */
  inherited: boolean;
}

export interface FetchRunConfigInput {
  instance: string;
  bearerToken: string;
  appId: string;
  orgId?: string;
  scope: string;
  name: string;
  fetchImpl?: typeof fetch;
}

export class RunConfigFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunConfigFetchError";
  }
}

/**
 * Call `GET /api/applications/{appId}/packages/{scope}/{name}/run-config`
 * and return the parsed payload. Returns `null` on 404 (no inheritance);
 * any other non-2xx surfaces as `RunConfigFetchError`.
 */
export async function fetchRunConfigPayload(
  input: FetchRunConfigInput,
): Promise<ResolvedRunConfigPayload | null> {
  const fetchFn = input.fetchImpl ?? fetch;
  const instance = normalizeInstance(input.instance);
  // appId is `app_<uuid>` — safe characters, no encoding needed.
  // scope is `@<slug>` — must NOT be percent-encoded (see bundle-fetch.ts:buildBundleUrl):
  // Hono's `:scope{@[^/]+}` route rejects `%40scope` as 404. Both scope
  // and name are validated upstream to a strict `[a-z0-9-]` charset.
  const url = `${instance}/api/applications/${input.appId}/packages/${input.scope}/${input.name}/run-config`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.bearerToken}`,
    "User-Agent": CLI_USER_AGENT,
    "X-App-Id": input.appId,
  };
  if (input.orgId) headers["X-Org-Id"] = input.orgId;

  const res = await fetchFn(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new RunConfigFetchError(
      `Failed to fetch run-config: HTTP ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as ResolvedRunConfigPayload;
}

export interface MergeRunConfigInputs {
  /** Inherited payload (null = no inheritance — flags + defaults only). */
  inherited: ResolvedRunConfigPayload | null;
  /** `--config <json>` value already parsed into an object, or undefined. */
  flagConfig?: Record<string, unknown>;
  /** `--model <id>` flag value. */
  flagModel?: string;
  /** `--proxy <id>` flag value. */
  flagProxy?: string;
  /** Whether the user explicitly passed `@spec` in the package id. */
  hasExplicitSpec: boolean;
  /** APPSTRATE_MODEL env var. */
  envModel?: string;
  /** APPSTRATE_PROXY env var. */
  envProxy?: string;
}

/**
 * Apply the documented merge order.
 *
 * `modelId` / `proxyId`: first-non-null wins (`flag > env > inherited`).
 * Mirrors the platform's per-run override precedence on
 * `POST /api/agents/.../run` where the request body's `modelId` /
 * `proxyId` win over the value persisted in `application_packages` —
 * the CLI just adds an `env` rung so `APPSTRATE_MODEL_ID` /
 * `APPSTRATE_PROXY` keep working in CI.
 *
 * `versionPin`: an explicit `@spec` in the package id always wins;
 * otherwise the per-app pin feeds into the bundle URL. Identical to
 * the platform's `?version=` query param semantics.
 *
 * `config`: deep-merged. `flagConfig` overrides `inherited.config` at
 * the leaf — siblings at every level are preserved.
 *
 *     inherited:  { providers: { gmail: { scopes: ["read"] } } }
 *     flagConfig: { providers: { slack: { token: "xyz" } } }
 *     result:     { providers: { gmail: { … }, slack: { … } } }
 *
 * A previous shallow merge silently dropped the `gmail` key in that
 * scenario, which had no UI-side equivalent — the dashboard's
 * settings form never partial-merges, it edits the persisted record
 * via a full replace. Deep-merge is the closest fit to the user's
 * mental model of "override just this leaf" for a one-off CLI run.
 *
 * Arrays are replaced wholesale (treated as atomic values). Explicit
 * `null` clears the inherited leaf; `undefined` is ignored. Pass the
 * full config (`{}` for empty) when the run-config endpoint is
 * unreachable — the helper is called for both cases.
 */
export function mergeRunConfig(inputs: MergeRunConfigInputs): InheritedRunConfig {
  const inherited = inputs.inherited;
  const config = deepMergeConfig(inherited?.config ?? {}, inputs.flagConfig);
  const modelId = inputs.flagModel ?? inputs.envModel ?? inherited?.modelId ?? null;
  const proxyId = inputs.flagProxy ?? inputs.envProxy ?? inherited?.proxyId ?? null;
  const versionPin = inputs.hasExplicitSpec ? null : (inherited?.versionPin ?? null);
  return {
    config,
    modelId,
    proxyId,
    versionPin,
    requiredProviders: inherited?.requiredProviders ?? [],
    inherited: inherited !== null,
  };
}
