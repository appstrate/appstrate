// SPDX-License-Identifier: Apache-2.0

/**
 * Fetch the per-application run-config (model / generation / proxy /
 * version pin / stored input layer) for `<applicationId, packageId>` and
 * merge it with the user's CLI flags + env vars. Source of truth lives server-side at
 * `GET /api/applications/{applicationId}/packages/{scope}/{name}/run-config`
 * — the UI consumes the same payload, so a CLI run with no overrides
 * targets the same model and version the dashboard would.
 *
 * Merge order (highest priority first):
 *   1. Explicit CLI flags (--model / --proxy / @spec)
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
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

/**
 * Wire shape returned by the run-config endpoint. The canonical type
 * lives in `@appstrate/shared-types`; this alias keeps the legacy
 * CLI-local name available to existing callers and tests.
 */
type ResolvedRunConfigPayload = ResolvedRunConfig;

export interface InheritedRunConfig {
  /** Model id to pass to the run pipeline, or null when nothing is set. */
  modelId: string | null;
  /** Persisted generation defaults for local parity with platform runs. */
  generation: ModelGenerationSettings | null;
  /** Proxy id to pass to the run pipeline, or null when nothing is set. */
  proxyId: string | null;
  /** Pinned version label, when the user did not provide an explicit @spec. */
  versionPin: string | null;
  /**
   * `application_packages.input_settings.values` — layer 2 of the platform's
   * input resolution. Empty when nothing was inherited.
   */
  inputValues: Record<string, unknown>;
  /**
   * `application_packages.input_settings.locked` — input fields the editor
   * froze. Empty when nothing was inherited.
   */
  lockedInputFields: string[];
  /** True when the API call returned 200; false when it 404'd or was skipped. */
  inherited: boolean;
}

interface FetchRunConfigInput {
  instance: string;
  bearerToken: string;
  applicationId: string;
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
 * Call `GET /api/applications/{applicationId}/packages/{scope}/{name}/run-config`
 * and return the parsed payload. Returns `null` on 404 (no inheritance);
 * any other non-2xx surfaces as `RunConfigFetchError`.
 */
export async function fetchRunConfigPayload(
  input: FetchRunConfigInput,
): Promise<ResolvedRunConfigPayload | null> {
  const fetchFn = input.fetchImpl ?? fetch;
  const instance = normalizeInstance(input.instance);
  // applicationId is `app_<uuid>` — safe characters, no encoding needed.
  // scope is `@<slug>` — must NOT be percent-encoded (see bundle-fetch.ts:buildBundleUrl):
  // Hono's `:scope{@[^/]+}` route rejects `%40scope` as 404. Both scope
  // and name are validated upstream to a strict `[a-z0-9-]` charset.
  const url = `${instance}/api/applications/${input.applicationId}/packages/${input.scope}/${input.name}/run-config`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.bearerToken}`,
    "User-Agent": CLI_USER_AGENT,
    "X-Application-Id": input.applicationId,
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

interface MergeRunConfigInputs {
  /** Inherited payload (null = no inheritance — flags + defaults only). */
  inherited: ResolvedRunConfigPayload | null;
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
 * `inputValues` / `lockedInputFields`: passed through untouched — they are
 * not a CLI flag's business. `run.ts` layers them between the author
 * defaults and the caller's `--input`, exactly where the server puts them.
 */
export function mergeRunConfig(inputs: MergeRunConfigInputs): InheritedRunConfig {
  const inherited = inputs.inherited;
  const modelId = inputs.flagModel ?? inputs.envModel ?? inherited?.modelId ?? null;
  const proxyId = inputs.flagProxy ?? inputs.envProxy ?? inherited?.proxyId ?? null;
  const versionPin = inputs.hasExplicitSpec ? null : (inherited?.version_pin ?? null);
  return {
    modelId,
    generation: inherited?.generation ?? null,
    proxyId,
    versionPin,
    inputValues: inherited?.input?.values ?? {},
    lockedInputFields: inherited?.input?.locked_fields ?? [],
    inherited: inherited !== null,
  };
}
