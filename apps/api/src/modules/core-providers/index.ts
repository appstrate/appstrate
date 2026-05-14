// SPDX-License-Identifier: Apache-2.0

/**
 * Core Providers module — the canonical API-key model provider catalog
 * shipped with every Appstrate deployment.
 *
 * Each entry is a `ModelProviderDefinition` carrying wire format, auth
 * metadata, and a *curated featured list* (3-5 ids per provider). For
 * providers covered by the vendored LiteLLM catalog (openai / anthropic
 * / mistral / google-ai / cerebras / groq / xai), the inline `models[]`
 * carries only `{ id, label?, recommended? }` — `contextWindow`,
 * `maxTokens`, `capabilities`, and `cost` come from
 * `apps/api/src/services/pricing-catalog.ts`. Inline metadata stays
 * full only for non-catalog providers (codex subscription,
 * `openai-compatible`, `openrouter`'s live-search shape).
 *
 * Featured semantics: any id present in this inline `models[]` is
 * marked `featured: true` in the registry response. The picker also
 * exposes every other catalog model under "All models" — so the
 * platform stays a marketplace of the full Portkey-routable surface
 * without losing editorial curation up top.
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
  portkeyProvider: "anthropic",
  featured: true,
  models: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  ],
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
  portkeyProvider: "openai",
  // `llama-3.3-70b` (with dash, LiteLLM canonical) — note the catalog
  // doesn't carry `llama-4-scout-17b-16e-instruct`; users who need it
  // pick "Custom".
  models: [
    { id: "llama-3.3-70b", label: "Llama 3.3 70B" },
    { id: "gpt-oss-120b", label: "GPT-OSS 120B" },
  ],
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
  portkeyProvider: "google",
  featured: true,
  models: [
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
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
  portkeyProvider: "openai",
  // `gemma2-9b-it` / `mixtral-8x7b-32768` aren't in LiteLLM's groq
  // index; users still pick them via "Custom" if needed.
  models: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    { id: "kimi-k2-instruct-0905", label: "Kimi K2 Instruct" },
  ],
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
  portkeyProvider: "mistral-ai",
  featured: true,
  models: [
    { id: "codestral-latest", label: "Codestral" },
    { id: "devstral-2512", label: "Devstral 2" },
    { id: "mistral-large-latest", label: "Mistral Large" },
    { id: "mistral-medium-latest", label: "Mistral Medium" },
    { id: "mistral-small-latest", label: "Mistral Small" },
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
  portkeyProvider: "openai",
  featured: true,
  models: [
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "o4-mini", label: "o4-mini" },
  ],
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
  // Portkey OSS has no native `openrouter` slug — route through `openai`
  // with the upstream URL forced via `custom_host`. Portkey's OpenAI
  // implementation rewrites paths permissively enough for OpenRouter's
  // OpenAI-completions surface.
  portkeyProvider: "openai",
  // Empty catalog — the UI fetches models live via the OpenRouter search combobox.
  models: [],
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
  portkeyProvider: "openai",
  models: [
    { id: "grok-3", label: "Grok 3" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
    { id: "grok-4", label: "Grok 4" },
  ],
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
  portkeyProvider: "openai",
  models: [],
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
