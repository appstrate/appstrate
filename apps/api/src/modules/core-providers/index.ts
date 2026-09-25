// SPDX-License-Identifier: Apache-2.0

/**
 * Core Providers module — the canonical API-key model provider catalog
 * shipped with every Appstrate deployment.
 *
 * Each entry is a `ModelProviderDefinition` carrying wire format, auth
 * metadata, and a featured list (catalog ids). All per-model metadata
 * (label, contextWindow, maxTokens, capabilities, cost) comes from Pi's
 * pinned model registry (`apps/api/src/services/model-catalog.ts`): a
 * provider offers the records of its Pi provider (`catalogProviderId ??
 * providerId`) on its `apiShape`.
 *
 * Featured lists are pinned here, a few current flagships per provider.
 * Any id present in `featuredModels` is marked `featured: true` in the
 * registry response and auto-seeded on first connection
 * (`use-auto-seed-models.ts`); the rest of the offer lives under "All
 * models". Registration fails when a featured id leaves the offer.
 *
 * The UI consumes this catalog exclusively via
 * `GET /api/model-provider-credentials/registry` — no client-side
 * hardcoding. Adding a new provider is a single entry here.
 *
 * OAuth-flavoured providers live in their own opt-in workspace modules
 * (`@appstrate/module-codex`, `@appstrate/module-claude-code`, …). The
 * `baseUrlOverridable` entries — one per wire format — are the escape
 * hatch for self-hosted or third-party endpoints not covered by a named
 * preset: `openai-compatible` for the OpenAI chat-completions API,
 * `anthropic-compatible` for the Anthropic Messages API. Each carries
 * its own base URL on the credential.
 *
 * Routing: api_key flows fetch the provider's `defaultBaseUrl` (or the
 * per-credential override when `baseUrlOverridable: true`) directly.
 * Retries are handled by the Pi SDK natively for both OpenAI and
 * Anthropic SDKs (Retry-After honoring + jitter, `maxRetries: 2`).
 */

import type { AppstrateModule, ModelProviderDefinition } from "@appstrate/core/module";

const anthropic: ModelProviderDefinition = {
  providerId: "anthropic",
  displayName: "Anthropic",
  iconUrl: "anthropic",
  description: "Bring your own Anthropic API key.",
  docsUrl: "https://docs.anthropic.com/en/api",
  apiShape: "anthropic-messages",
  defaultBaseUrl: "https://api.anthropic.com",
  baseUrlOverridable: false,
  authMode: "api_key",
  featured: true,
  featuredModels: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"],
};

const cerebras: ModelProviderDefinition = {
  providerId: "cerebras",
  displayName: "Cerebras",
  iconUrl: "cerebras",
  description: "Bring your own Cerebras API key.",
  docsUrl: "https://inference-docs.cerebras.ai/api-reference",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.cerebras.ai/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: ["qwen-3.8-27b", "gpt-oss-120b"],
};

const deepseek: ModelProviderDefinition = {
  providerId: "deepseek",
  displayName: "DeepSeek",
  iconUrl: "deepseek",
  description: "Bring your own DeepSeek API key.",
  docsUrl: "https://api-docs.deepseek.com/",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.deepseek.com/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: ["deepseek-flash", "deepseek-v4-pro"],
};

const fireworksAi: ModelProviderDefinition = {
  providerId: "fireworks-ai",
  catalogProviderId: "fireworks",
  displayName: "Fireworks AI",
  iconUrl: "fireworks-ai",
  description: "Bring your own Fireworks AI API key.",
  docsUrl: "https://docs.fireworks.ai/api-reference/post-chatcompletions",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: [
    "accounts/fireworks/routers/glm-5p3-fast",
    "accounts/fireworks/models/glm-5p3-flash",
    "accounts/fireworks/models/kimi-k3",
  ],
};

const groq: ModelProviderDefinition = {
  providerId: "groq",
  displayName: "Groq",
  iconUrl: "groq",
  description: "Bring your own Groq API key.",
  docsUrl: "https://console.groq.com/docs/api-reference",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  // Groq serves several models under namespaced ids (`openai/gpt-oss-120b`).
  featuredModels: ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b", "openai/gpt-oss-safeguard-20b"],
};

const mistral: ModelProviderDefinition = {
  providerId: "mistral",
  displayName: "Mistral",
  iconUrl: "mistral",
  description: "Bring your own Mistral API key.",
  docsUrl: "https://docs.mistral.ai/api/",
  apiShape: "mistral-conversations",
  defaultBaseUrl: "https://api.mistral.ai",
  baseUrlOverridable: false,
  authMode: "api_key",
  featured: true,
  featuredModels: ["zai-glm-5-3", "zai-glm-5-2", "mistral-medium-2604"],
};

const moonshot: ModelProviderDefinition = {
  providerId: "moonshot",
  catalogProviderId: "moonshotai",
  displayName: "Moonshot AI",
  iconUrl: "moonshot",
  description: "Bring your own Moonshot AI (Kimi) API key.",
  docsUrl: "https://platform.moonshot.ai/docs",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.moonshot.ai/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: ["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"],
};

const openai: ModelProviderDefinition = {
  providerId: "openai",
  displayName: "OpenAI",
  iconUrl: "openai",
  description: "Bring your own OpenAI API key.",
  docsUrl: "https://platform.openai.com/docs/api-reference",
  apiShape: "openai-responses",
  defaultBaseUrl: "https://api.openai.com/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featured: true,
  featuredModels: ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-sol"],
};

const openrouter: ModelProviderDefinition = {
  providerId: "openrouter",
  displayName: "OpenRouter",
  iconUrl: "openrouter",
  description: "Aggregator with hundreds of models behind one API key.",
  docsUrl: "https://openrouter.ai/docs",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: [],
  // `GET /models` answers any key: keys are checked by inference.
  publicModelListing: true,
};

const togetherAi: ModelProviderDefinition = {
  providerId: "together-ai",
  catalogProviderId: "together",
  displayName: "Together AI",
  iconUrl: "together-ai",
  description: "Bring your own Together AI API key.",
  docsUrl: "https://docs.together.ai/reference/chat-completions-1",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.together.xyz/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: ["deepseek-ai/DeepSeek-V4.1-Flash", "zai-org/GLM-5.3-Flash", "zai-org/GLM-5.3"],
};

const xai: ModelProviderDefinition = {
  providerId: "xai",
  displayName: "xAI",
  iconUrl: "xai",
  description: "Bring your own xAI API key.",
  docsUrl: "https://docs.x.ai/api",
  apiShape: "openai-responses",
  defaultBaseUrl: "https://api.x.ai/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: ["grok-4.6", "grok-4.5", "grok-4.3"],
};

const zai: ModelProviderDefinition = {
  providerId: "zai",
  displayName: "Z.ai",
  iconUrl: "zai",
  description: "Bring your own Z.ai (GLM) API key.",
  docsUrl: "https://docs.z.ai/api-reference",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.z.ai/api/paas/v4",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: ["glm-5.3-flash", "glm-5.3", "glm-5.2"],
};

/**
 * OpenCode Go — single-key subscription aggregating several open-source
 * coding models (GLM, Kimi, DeepSeek, MiMo) behind one OpenAI-compatible
 * endpoint. Structurally an aggregator (openrouter-class), but it exposes a
 * small, fixed model set, so `featuredModels` pins that set rather than
 * relying on live search.
 *
 * Only the `/chat/completions` (openai-completions) models are wired. Go
 * serves some models (MiniMax M3) only on an Anthropic-style `/messages`
 * endpoint; those need a second provider entry (different apiShape) and are
 * out of scope for this first pass. Auth is a static Bearer key — no OAuth.
 * `GET /models` answers any key, hence `publicModelListing`. Go bills by a
 * dollar-equivalent cap, not per token, so ledger cost is indicative only.
 */
const opencodeGo: ModelProviderDefinition = {
  providerId: "opencode-go",
  displayName: "OpenCode Go",
  iconUrl: "opencode-go",
  description:
    "One subscription, many open-source coding models (GLM, Kimi, DeepSeek, MiMo) via a single OpenCode Go key.",
  docsUrl: "https://opencode.ai/docs/go/",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://opencode.ai/zen/go/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  publicModelListing: true,
  featuredModels: [
    "kimi-k2.7-code",
    "kimi-k2.6",
    "glm-5.2",
    "glm-5.1",
    "minimax-m2.7",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.6-plus",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "mimo-v2.5",
    "mimo-v2.5-pro",
  ],
};

const openaiCompatible: ModelProviderDefinition = {
  providerId: "openai-compatible",
  displayName: "OpenAI-compatible (custom)",
  iconUrl: "custom-endpoint",
  description:
    "Self-hosted or third-party endpoint exposing the OpenAI chat-completions API (Ollama, vLLM, LiteLLM, …).",
  apiShape: "openai-completions",
  defaultBaseUrl: "http://localhost:11434",
  baseUrlOverridable: true,
  authMode: "api_key",
  featuredModels: [],
};

const anthropicCompatible: ModelProviderDefinition = {
  providerId: "anthropic-compatible",
  displayName: "Anthropic-compatible (custom)",
  iconUrl: "custom-endpoint",
  description:
    "Self-hosted or third-party endpoint exposing the Anthropic Messages API (LiteLLM proxy, vendors publishing an Anthropic-compatible endpoint, …).",
  docsUrl: "https://docs.anthropic.com/en/api/messages",
  apiShape: "anthropic-messages",
  // LiteLLM's default proxy port — the usual way to serve this wire format
  // locally. Ollama's 11434 speaks chat-completions, not Messages.
  defaultBaseUrl: "http://localhost:4000",
  baseUrlOverridable: true,
  authMode: "api_key",
  featuredModels: [],
};

const coreProvidersModule: AppstrateModule = {
  manifest: { id: "core-providers", name: "Core Model Providers", version: "1.0.0" },

  async init() {
    // Fully declarative — `modelProviders()` does the registration.
  },

  modelProviders() {
    return [
      anthropic,
      cerebras,
      deepseek,
      fireworksAi,
      groq,
      mistral,
      moonshot,
      openai,
      openrouter,
      togetherAi,
      xai,
      zai,
      opencodeGo,
      openaiCompatible,
      anthropicCompatible,
    ];
  },
};

export default coreProvidersModule;
