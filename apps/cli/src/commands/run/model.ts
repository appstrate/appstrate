// SPDX-License-Identifier: Apache-2.0

/**
 * Model + API-key resolution for `appstrate run`.
 *
 * Two mutually-exclusive sources, selected by `--model-source`:
 *
 *   env (default) — the user brings their own LLM credentials. The CLI
 *     builds a `Model<Api>` from `--model-api` + `--model` (or env vars)
 *     and pulls the provider API key from env.
 *
 *   preset — the CLI picks a preset id from `GET /api/models` exposed by
 *     the pinned Appstrate instance, routes LLM traffic through
 *     `/api/llm-proxy/<api>/*`, and passes the caller's Appstrate bearer
 *     token (API key or JWT) as the "API key" — the platform resolves
 *     the preset server-side and injects upstream credentials. No
 *     provider key ever hits the CLI in preset mode.
 *
 * A missing key (env mode) is a hard error before any network call —
 * early exit with an actionable message is better UX than a 401 from
 * the upstream.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { listModelPresets, PROXY_SUPPORTED_APIS, type ModelPreset } from "../../lib/models.ts";

export type ModelSource = "env" | "preset";

export interface ModelFlags {
  modelApi?: string;
  model?: string;
  llmApiKey?: string;
}

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
}

export interface PresetResolutionInputs {
  /** CLI profile (for `GET /api/models` + bearer token lookup). */
  profileName: string;
  /** Preset id. Optional — falls back to the org default when omitted. */
  modelId?: string;
  /** Appstrate instance base URL (profile.instance). */
  instance: string;
  /** Bearer token to carry to `/api/llm-proxy/*`. Must have `llm-proxy:call`. */
  bearerToken: string;
  /**
   * Org id pinned on the profile. Forwarded as `X-Org-Id` on every
   * upstream call so `requireOrgContext` resolves without falling back
   * to the header-less path (JWT auth uses `deferOrgResolution`, which
   * requires the header). API-key auth pre-resolves the org inline and
   * ignores the header.
   */
  orgId: string;
  /**
   * Test seam — inject a presets loader to avoid hitting the network in
   * unit tests. Production calls `listModelPresets(profileName)`.
   */
  presetsLoader?: (profileName: string) => Promise<ModelPreset[]>;
}

const PROVIDER_BY_API: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "mistral-conversations": "mistral",
  "google-generative-ai": "google",
  "google-vertex": "google-vertex",
  "azure-openai-responses": "azure-openai-responses",
  "bedrock-converse-stream": "amazon-bedrock",
};

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  google: "GOOGLE_API_KEY",
};

export class ModelResolutionError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

export function resolveModel(flags: ModelFlags): ResolvedModel {
  const api = flags.modelApi ?? process.env.APPSTRATE_MODEL_API ?? "anthropic-messages";
  const modelId = flags.model ?? process.env.APPSTRATE_MODEL_ID ?? "claude-sonnet-4-5";

  const provider = PROVIDER_BY_API[api];
  if (!provider) {
    throw new ModelResolutionError(
      `Unknown --model-api "${api}"`,
      `Accepted values: ${Object.keys(PROVIDER_BY_API).join(", ")}`,
    );
  }

  const providerEnvKey = ENV_KEY_BY_PROVIDER[provider];
  const apiKey =
    flags.llmApiKey ??
    (providerEnvKey ? process.env[providerEnvKey] : undefined) ??
    process.env.APPSTRATE_LLM_API_KEY ??
    process.env.LLM_API_KEY;

  if (!apiKey) {
    const want = providerEnvKey ? `$${providerEnvKey}` : "$APPSTRATE_LLM_API_KEY";
    throw new ModelResolutionError(
      `No LLM API key resolved for provider "${provider}"`,
      `Set ${want} or pass --llm-api-key. (Model API: ${api})`,
    );
  }

  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api: api as Api,
    provider,
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };

  return { model, apiKey };
}

/**
 * Resolve a model preset against `GET /api/models` on the pinned instance.
 * Returns a `Model<Api>` whose `baseUrl` points at `/api/llm-proxy/<api>/v1`
 * and whose `modelId` is the preset id (the platform substitutes the real
 * upstream id server-side). The bearer token is passed through as the
 * "apiKey" — pi-ai sends it as `Authorization: Bearer …`.
 *
 * Only protocol families wired on `/api/llm-proxy/*` today are accepted;
 * picking an unsupported preset (e.g. `google-generative-ai`) fails fast
 * with an actionable message so the user can switch preset or mode
 * before any LLM call goes out.
 */
export async function resolvePresetModel(inputs: PresetResolutionInputs): Promise<ResolvedModel> {
  const loader = inputs.presetsLoader ?? listModelPresets;
  const presets = await loader(inputs.profileName);
  const preset = pickPreset(presets, inputs.modelId);
  if (!PROXY_SUPPORTED_APIS.has(preset.api)) {
    throw new ModelResolutionError(
      `Preset "${preset.id}" uses protocol "${preset.api}", which /api/llm-proxy/* does not route yet.`,
      `Supported today: ${Array.from(PROXY_SUPPORTED_APIS).join(", ")}. ` +
        `Pick another preset or run with --model-source env.`,
    );
  }

  const baseUrl = buildProxyBaseUrl(inputs.instance, preset.api);
  // pi-ai's Anthropic SDK path sends auth as `x-api-key`, but the
  // platform's auth pipeline reads `Authorization: Bearer`. We inject
  // the bearer via model.headers and pass a placeholder `apiKey` to
  // satisfy the Anthropic SDK constructor — the platform strips
  // inbound `x-api-key` (not in HEADERS_TO_FORWARD) and injects the
  // real upstream key from server-side storage. Net effect: the
  // placeholder never leaves the platform's network. See
  // `apps/api/src/services/llm-proxy/anthropic.ts:HEADERS_TO_FORWARD`.
  //
  // OAuth-keyed Anthropic presets need an extra trick: the upstream
  // (`sk-ant-oat-*`) is gated to Claude-Code identity at the BODY level
  // — system prompt + tool-name renaming — which pi-ai injects locally
  // only when its `apiKey.includes("sk-ant-oat")` detection fires. So we
  // mirror the prefix in the placeholder. pi-ai then takes its OAuth
  // path: it tries to set `Authorization: Bearer <oauth-placeholder>` AND
  // reshapes the body. The Anthropic SDK's `defaultHeaders` (= our
  // `model.headers`) is applied AFTER the auth header in `buildHeaders`
  // (later wins), so our `Authorization: Bearer <appstrate-token>`
  // overrides pi-ai's OAuth bearer before the request leaves the
  // process — the proxy still authenticates with the Appstrate token,
  // and the reshaped body flows through to the real OAuth upstream.
  const isAnthropic = preset.api === "anthropic-messages";
  const isAnthropicOAuth = isAnthropic && preset.keyKind === "oauth";
  const headers: Record<string, string> = { "X-Org-Id": inputs.orgId };
  if (isAnthropic) {
    headers["Authorization"] = `Bearer ${inputs.bearerToken}`;
  }
  const model: Model<Api> = {
    id: preset.id,
    name: preset.label,
    api: preset.api as Api,
    provider: deriveProvider(preset.api),
    baseUrl,
    reasoning: preset.reasoning ?? false,
    input: (preset.input ?? ["text"]) as ("text" | "image")[],
    cost: preset.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: preset.contextWindow ?? 200_000,
    maxTokens: preset.maxTokens ?? 8192,
    headers,
  };
  // Placeholder for anthropic — never reaches upstream (see comment above).
  // For OAuth-keyed presets the placeholder must mirror the `sk-ant-oat-`
  // prefix so pi-ai's local detection picks it up; for plain API-key
  // presets any non-OAuth string is fine. For other APIs, pi-ai's SDK
  // sends `Authorization: Bearer <apiKey>` natively.
  let apiKey: string;
  if (isAnthropicOAuth) {
    apiKey = "sk-ant-oat-placeholder";
  } else if (isAnthropic) {
    apiKey = "x-platform-bearer-injected-via-headers";
  } else {
    apiKey = inputs.bearerToken;
  }
  return { model, apiKey };
}

function pickPreset(presets: ModelPreset[], requestedId?: string): ModelPreset {
  if (presets.length === 0) {
    throw new ModelResolutionError(
      "No model presets are available on this Appstrate instance",
      "Ask an admin to configure one in Settings → Models, or run with --model-source env.",
    );
  }
  if (requestedId) {
    const match = presets.find((p) => p.id === requestedId);
    if (!match) {
      const available = presets.map((p) => `  - ${p.id} (${p.api})`).join("\n");
      throw new ModelResolutionError(
        `No preset matches "${requestedId}"`,
        `Available presets:\n${available}\nRun \`appstrate models list\` to discover them.`,
      );
    }
    if (!match.enabled) {
      throw new ModelResolutionError(
        `Preset "${requestedId}" is disabled`,
        "Pick another preset or ask an admin to enable it.",
      );
    }
    return match;
  }
  const defaultPreset = presets.find((p) => p.isDefault && p.enabled);
  if (!defaultPreset) {
    throw new ModelResolutionError(
      "No default preset is set on this instance",
      "Pass --model <preset-id>, or ask an admin to mark a default in Settings → Models.",
    );
  }
  return defaultPreset;
}

function buildProxyBaseUrl(instance: string, api: string): string {
  const trimmed = instance.replace(/\/+$/, "");
  // Each SDK appends its own canonical suffix to `baseURL`; we stop one
  // segment short so the suffix lands on the platform's
  // `/api/llm-proxy/<api>/v1/…` route.
  //   - OpenAI SDK appends `/chat/completions` → baseUrl carries `/v1`.
  //   - Anthropic SDK appends `/v1/messages`   → baseUrl is the bare
  //     route prefix (no `/v1`).
  //   - Mistral SDK appends `/v1/chat/completions` → baseUrl is the bare
  //     route prefix (no `/v1`). Despite the protocol family name
  //     `mistral-conversations`, pi-ai uses Mistral's `chat.stream` which
  //     hits `/v1/chat/completions`, not the Beta `/v1/conversations`
  //     agentic API.
  if (api === "openai-completions") {
    return `${trimmed}/api/llm-proxy/openai-completions/v1`;
  }
  if (api === "anthropic-messages") {
    return `${trimmed}/api/llm-proxy/anthropic-messages`;
  }
  if (api === "mistral-conversations") {
    return `${trimmed}/api/llm-proxy/mistral-conversations`;
  }
  throw new ModelResolutionError(
    `CLI preset mode does not yet route protocol "${api}"`,
    `Supported today: ${Array.from(PROXY_SUPPORTED_APIS).join(", ")}. Pick a compatible preset or use --model-source env.`,
  );
}

function deriveProvider(api: string): string {
  return PROVIDER_BY_API[api] ?? "custom";
}

/** Exported for tests. */
export const _PROVIDER_BY_API_FOR_TESTING = PROVIDER_BY_API;
