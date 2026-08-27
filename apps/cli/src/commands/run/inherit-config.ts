// SPDX-License-Identifier: Apache-2.0

/**
 * Fetch the per-space run-config (model / generation / proxy /
 * version pin / stored input layer) for `<spaceId, packageId>` and
 * merge it with the user's CLI flags + env vars. Source of truth lives server-side at
 * `GET /api/spaces/{spaceId}/packages/{scope}/{name}/run-config`
 * — the UI consumes the same payload, so a CLI run with no overrides
 * targets the same model and version the dashboard would.
 *
 * Merge order (highest priority first):
 *   1. Explicit CLI flags (--model / --proxy / @spec)
 *   2. Environment variables (APPSTRATE_MODEL_ID / APPSTRATE_PROXY)
 *   3. `run-config` payload returned by the API
 *   4. Built-in defaults (none for these fields)
 *
 * 404 from the run-config endpoint is "no inheritance, fall back to
 * flags + defaults" — typical for a system agent that hasn't been
 * installed in the space. Anything else bubbles as a hard error, and so
 * does a 200 whose body is not the current wire shape (see
 * `fetchRunConfigPayload`).
 */

import { CLI_USER_AGENT } from "../../lib/version.ts";
import { normalizeInstance } from "../../lib/instance-url.ts";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

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
   * `space_packages.input_settings.values` — layer 2 of the platform's
   * input resolution. Empty when nothing was inherited.
   */
  inputValues: Record<string, unknown>;
  /**
   * `space_packages.input_settings.locked` — input fields the editor
   * froze. Empty when nothing was inherited.
   */
  lockedInputFields: string[];
  /** True when the API call returned 200; false when it 404'd or was skipped. */
  inherited: boolean;
}

interface FetchRunConfigInput {
  instance: string;
  bearerToken: string;
  spaceId: string;
  orgId?: string;
  scope: string;
  name: string;
  fetchImpl?: typeof fetch;
}

export class RunConfigFetchError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "RunConfigFetchError";
  }
}

/**
 * Call `GET /api/spaces/{spaceId}/packages/{scope}/{name}/run-config`
 * and return the parsed payload. Returns `null` on 404 (no inheritance);
 * any other non-2xx surfaces as `RunConfigFetchError`, as does a 200 whose
 * body the reader cannot use.
 */
export async function fetchRunConfigPayload(
  input: FetchRunConfigInput,
): Promise<ResolvedRunConfig | null> {
  const fetchFn = input.fetchImpl ?? fetch;
  const instance = normalizeInstance(input.instance);
  // spaceId is `spc_<uuid>` — safe characters, no encoding needed.
  // scope is `@<slug>` — must NOT be percent-encoded (see bundle-fetch.ts:buildBundleUrl):
  // Hono's `:scope{@[^/]+}` route rejects `%40scope` as 404. Both scope
  // and name are validated upstream to a strict `[a-z0-9-]` charset.
  const url = `${instance}/api/spaces/${input.spaceId}/packages/${input.scope}/${input.name}/run-config`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.bearerToken}`,
    "User-Agent": CLI_USER_AGENT,
    "X-Space-Id": input.spaceId,
  };
  if (input.orgId) headers["X-Org-Id"] = input.orgId;

  const res = await fetchFn(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new RunConfigFetchError(
      `Failed to fetch run-config: HTTP ${res.status} ${res.statusText}`,
    );
  }
  // This is the only boundary between untrusted JSON and `ResolvedRunConfig`,
  // and the instance on the other end is NOT this build: `appstrate run
  // @scope/agent` talks to whatever version the user pinned, and the CLI has
  // no version handshake to negotiate one. So a shape gap has to be named
  // here or nowhere — `mergeRunConfig` dereferences `input` unguarded, and an
  // absent member would otherwise surface as `undefined is not an object`,
  // which names neither the field nor the server that omitted it.
  //
  // Only `input` is checked, deliberately: it is the one member the reader
  // requires to be PRESENT. Every other member is declared `T | null`, so the
  // `?? null` beside each collapses an absent one into a value the type
  // already permits and that states the truth ("nothing set"). Same narrowness
  // as `apiList` in `lib/api.ts`, which validates the single member it
  // unwraps and lets the rest of the envelope be.
  const payload: unknown = await res.json();
  const inputLayer = (payload as { input?: { values?: unknown; locked_fields?: unknown } } | null)
    ?.input;
  if (
    !inputLayer ||
    typeof inputLayer.values !== "object" ||
    inputLayer.values === null ||
    !Array.isArray(inputLayer.locked_fields)
  ) {
    throw new RunConfigFetchError(
      `Run-config from ${instance} has no usable \`input\` member ({ values, locked_fields }).`,
      "That instance predates the per-space stored input layer this CLI reads — upgrade it, or re-run with --no-inherit.",
    );
  }
  return payload as ResolvedRunConfig;
}

interface MergeRunConfigInputs {
  /** Inherited payload (null = no inheritance — flags + defaults only). */
  inherited: ResolvedRunConfig | null;
  /** `--model <id>` flag value. */
  flagModel?: string;
  /** `--proxy <id>` flag value. */
  flagProxy?: string;
  /** Whether the user explicitly passed `@spec` in the package id. */
  hasExplicitSpec: boolean;
  /** APPSTRATE_MODEL_ID env var. */
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
 * `proxyId` win over the value persisted in `space_packages` —
 * the CLI just adds an `env` rung so `APPSTRATE_MODEL_ID` /
 * `APPSTRATE_PROXY` keep working in CI.
 *
 * `versionPin`: an explicit `@spec` in the package id always wins;
 * otherwise the per-space pin feeds into the bundle URL. Identical to
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
    inputValues: inherited?.input.values ?? {},
    lockedInputFields: inherited?.input.locked_fields ?? [],
    inherited: inherited !== null,
  };
}
