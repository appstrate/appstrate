// SPDX-License-Identifier: Apache-2.0

/**
 * Core Providers module — the canonical API-key model provider catalog
 * shipped with every Appstrate deployment.
 *
 * Each entry is a `ModelProviderDefinition` carrying wire format, auth
 * metadata, and a curated featured list (just catalog ids). All per-
 * model metadata (label, contextWindow, maxTokens, capabilities, cost)
 * comes from the vendored LiteLLM catalog
 * (`apps/api/src/services/pricing-catalog.ts`). A boot-time check fails
 * loudly if any featured id is absent from the catalog — there are no
 * inline overrides.
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
  featuredModels: ["claude-haiku-4-5-20251001", "claude-opus-4-6", "claude-sonnet-4-6"],
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
  featuredModels: ["llama-3.3-70b", "gpt-oss-120b"],
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
  featuredModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.1-pro-preview"],
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
  featuredModels: ["llama-3.3-70b-versatile", "kimi-k2-instruct-0905"],
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
  featuredModels: [
    "codestral-latest",
    "devstral-2512",
    "mistral-large-latest",
    "mistral-medium-latest",
    "mistral-small-latest",
  ],
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
  featuredModels: ["gpt-5-mini", "gpt-5.4", "o4-mini"],
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
  featuredModels: ["grok-3", "grok-3-mini", "grok-4"],
};

const openaiCompatible: ModelProviderDefinition = {
  providerId: "openai-compatible",
  displayName: "OpenAI-compatible (custom)",
  iconUrl: "openai",
  description:
    "Self-hosted or third-party endpoint exposing the OpenAI chat-completions API (Ollama, vLLM, LiteLLM, …).",
  apiShape: "openai-chat",
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
      googleAi,
      groq,
      mistral,
      openai,
      openrouter,
      xai,
      openaiCompatible,
    ];
  },
};

export default coreProvidersModule;
