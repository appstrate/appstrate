// SPDX-License-Identifier: Apache-2.0

/**
 * Core Providers module — the canonical API-key model provider catalog
 * shipped with every Appstrate deployment.
 *
 * Each entry is a `ModelProviderDefinition` carrying wire format, auth
 * metadata, and a featured list (just catalog ids). All per-model
 * metadata (label, contextWindow, maxTokens, capabilities, cost) comes
 * from the vendored LiteLLM catalog
 * (`apps/api/src/services/pricing-catalog.ts`). A boot-time check fails
 * loudly if any featured id is absent from the catalog — there are no
 * inline overrides.
 *
 * Featured lists are AUTO-GENERATED (`data/featured-models.json`): the
 * newest tool-calling models per provider, computed weekly by
 * `scripts/refresh-pricing-catalog.ts` from the LiteLLM catalog ∩
 * models.dev release dates, regenerated atomically with the catalogs
 * so every id is guaranteed present. To pin an editorial choice,
 * replace `featured("<id>")` with a hardcoded string[] on that
 * definition — the weekly diff then leaves it untouched.
 *
 * Featured semantics: any id present in `featuredModels` is marked
 * `featured: true` in the registry response. For catalog-covered
 * providers, the picker also exposes every other catalog model under
 * "All models". The same `featuredModels` set also drives the
 * onboarding auto-seed (`use-auto-seed-models.ts`).
 *
 * The UI consumes this catalog exclusively via
 * `GET /api/model-provider-credentials/registry` — no client-side
 * hardcoding. Adding a new provider is a single entry here.
 *
 * OAuth-flavoured providers live in their own opt-in workspace modules
 * (`@appstrate/module-codex`, `@appstrate/module-claude-code`, …). The
 * `openai-compatible` entry stays as the escape hatch for self-hosted
 * or third-party OpenAI-compatible endpoints not covered by a named
 * preset (vLLM, Ollama, LiteLLM, etc.).
 *
 * Routing: api_key flows fetch the provider's `defaultBaseUrl` (or the
 * per-credential override when `baseUrlOverridable: true`) directly.
 * Retries are handled by the Pi SDK natively for both OpenAI and
 * Anthropic SDKs (Retry-After honoring + jitter, `maxRetries: 2`).
 */

import type { AppstrateModule, ModelProviderDefinition } from "@appstrate/core/module";
import autoFeatured from "../../data/featured-models.json" with { type: "json" };

/**
 * Generated featured lists — see module docstring. Lookup is total: a
 * provider absent from the JSON (models.dev coverage gap) gets an empty
 * featured group, which the picker and onboarding auto-seed both
 * tolerate.
 */
const FEATURED = autoFeatured as Record<string, string[]>;
const featured = (providerId: string): string[] => FEATURED[providerId] ?? [];

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
  featuredModels: featured("anthropic"),
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
  featuredModels: featured("cerebras"),
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
  featuredModels: featured("deepseek"),
};

const fireworksAi: ModelProviderDefinition = {
  providerId: "fireworks-ai",
  displayName: "Fireworks AI",
  iconUrl: "fireworks-ai",
  description: "Bring your own Fireworks AI API key.",
  docsUrl: "https://docs.fireworks.ai/api-reference/post-chatcompletions",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: featured("fireworks-ai"),
};

const googleAi: ModelProviderDefinition = {
  providerId: "google-ai",
  displayName: "Google AI",
  iconUrl: "google-ai",
  description: "Bring your own Google AI Studio API key.",
  docsUrl: "https://ai.google.dev/gemini-api/docs",
  apiShape: "google-generative-ai",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  baseUrlOverridable: false,
  authMode: "api_key",
  featured: true,
  featuredModels: featured("google-ai"),
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
  // Groq serves several models under namespaced ids (`openai/gpt-oss-120b`,
  // `moonshotai/kimi-k2-instruct-0905`) — the catalog vendors them verbatim.
  featuredModels: featured("groq"),
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
  featuredModels: featured("mistral"),
};

const moonshot: ModelProviderDefinition = {
  providerId: "moonshot",
  displayName: "Moonshot AI",
  iconUrl: "moonshot",
  description: "Bring your own Moonshot AI (Kimi) API key.",
  docsUrl: "https://platform.moonshot.ai/docs",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.moonshot.ai/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: featured("moonshot"),
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
  featuredModels: featured("openai"),
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
  // Empty catalog — the UI fetches models live via the OpenRouter search combobox.
  featuredModels: [],
};

const togetherAi: ModelProviderDefinition = {
  providerId: "together-ai",
  displayName: "Together AI",
  iconUrl: "together-ai",
  description: "Bring your own Together AI API key.",
  docsUrl: "https://docs.together.ai/reference/chat-completions-1",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.together.xyz/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: featured("together-ai"),
};

const xai: ModelProviderDefinition = {
  providerId: "xai",
  displayName: "xAI",
  iconUrl: "xai",
  description: "Bring your own xAI API key.",
  docsUrl: "https://docs.x.ai/api",
  apiShape: "openai-completions",
  defaultBaseUrl: "https://api.x.ai/v1",
  baseUrlOverridable: false,
  authMode: "api_key",
  featuredModels: featured("xai"),
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
  featuredModels: featured("zai"),
};

/**
 * OpenCode Go — single-key subscription aggregating several open-source
 * coding models (GLM, Kimi, DeepSeek, MiMo) behind one OpenAI-compatible
 * endpoint. Structurally an aggregator (openrouter-class), but unlike
 * openrouter it exposes a small, fixed model set, so we vendor a dedicated
 * `opencode-go` pricing catalog and pin `featuredModels` here rather than
 * relying on live search.
 *
 * Only the `/chat/completions` (openai-completions) models are wired. Go
 * also serves Qwen/MiniMax on an Anthropic-style `/messages` endpoint;
 * those need a second provider entry (different apiShape) and are out of
 * scope for this first pass. Auth is a static Bearer key — no OAuth.
 *
 * Pinned `featuredModels` (not `featured("opencode-go")`) so the weekly
 * LiteLLM-driven `featured-models.json` regen can never touch this
 * non-LiteLLM provider. Costs in `data/pricing/opencode-go.json` are
 * per-token approximations cribbed from the underlying vendors — Go bills
 * by a dollar-equivalent cap, not per token, so ledger cost is indicative
 * only.
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
  featuredModels: [
    "glm-5.2",
    "glm-5.1",
    "kimi-k2.7",
    "kimi-k2.6",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "mimo-v2.5",
    "mimo-v2.5-pro",
  ],
};

const openaiCompatible: ModelProviderDefinition = {
  providerId: "openai-compatible",
  displayName: "OpenAI-compatible (custom)",
  iconUrl: "openai",
  description:
    "Self-hosted or third-party endpoint exposing the OpenAI chat-completions API (Ollama, vLLM, LiteLLM, …).",
  apiShape: "openai-completions",
  defaultBaseUrl: "http://localhost:11434",
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
      googleAi,
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
    ];
  },
};

export default coreProvidersModule;
