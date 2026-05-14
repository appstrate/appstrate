// SPDX-License-Identifier: Apache-2.0

/**
 * Core Providers module — the canonical API-key model provider catalog
 * shipped with every Appstrate deployment.
 *
 * Each entry is a `ModelProviderDefinition` carrying its own apiShape,
 * default base URL, and a curated model whitelist (id, label, context
 * window, capabilities). Per-token cost is **not** stored inline when
 * the model is covered by the vendored Portkey pricing catalog
 * (openai / anthropic / mistral / google) — the registry endpoint
 * derives `cost` from `lookupModelCost(apiShape, id)` at serialization,
 * keeping a single source of truth. Inline `cost` is reserved for
 * catalog-absent providers (cerebras, groq, xai, codex) or intentional
 * overrides. The UI consumes this catalog exclusively via
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
  featured: true,
  models: [
    {
      id: "claude-haiku-4-5-20251001",
      label: "Claude Haiku 4.5",
      contextWindow: 200_000,
      maxTokens: 64_000,
      capabilities: ["text", "image", "reasoning"],
    },
    {
      id: "claude-opus-4-6",
      label: "Claude Opus 4.6",
      contextWindow: 200_000,
      maxTokens: 128_000,
      capabilities: ["text", "image", "reasoning"],
    },
    {
      id: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      contextWindow: 200_000,
      maxTokens: 64_000,
      capabilities: ["text", "image", "reasoning"],
    },
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
  models: [
    {
      id: "llama3.3-70b",
      label: "Llama 3.3 70B",
      contextWindow: 131_072,
      maxTokens: 16_384,
      capabilities: ["text"],
    },
    {
      id: "llama-4-scout-17b-16e-instruct",
      label: "Llama 4 Scout",
      contextWindow: 131_072,
      maxTokens: 16_384,
      capabilities: ["text", "image"],
    },
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
  featured: true,
  models: [
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      capabilities: ["text", "image", "reasoning"],
      cost: { input: 0.3, output: 2.5 },
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      capabilities: ["text", "image", "reasoning"],
      cost: { input: 1.25, output: 10 },
    },
    {
      id: "gemini-3.1-pro-preview",
      label: "Gemini 3.1 Pro",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      capabilities: ["text", "image", "reasoning"],
      cost: { input: 2, output: 12 },
    },
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
  models: [
    {
      id: "gemma2-9b-it",
      label: "Gemma 2 9B",
      contextWindow: 8_192,
      maxTokens: 8_192,
      capabilities: ["text"],
    },
    {
      id: "llama-3.3-70b-versatile",
      label: "Llama 3.3 70B",
      contextWindow: 131_072,
      maxTokens: 32_768,
      capabilities: ["text", "image"],
    },
    {
      id: "mixtral-8x7b-32768",
      label: "Mixtral 8x7B",
      contextWindow: 32_768,
      maxTokens: 32_768,
      capabilities: ["text"],
    },
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
  featured: true,
  models: [
    {
      id: "codestral-latest",
      label: "Codestral",
      contextWindow: 256_000,
      maxTokens: 32_768,
      capabilities: ["text"],
    },
    {
      id: "devstral-2512",
      label: "Devstral 2",
      contextWindow: 256_000,
      maxTokens: 32_768,
      capabilities: ["text"],
    },
    {
      id: "mistral-large-latest",
      label: "Mistral Large",
      contextWindow: 128_000,
      maxTokens: 32_768,
      capabilities: ["text", "image"],
    },
    {
      id: "mistral-medium-latest",
      label: "Mistral Medium",
      contextWindow: 128_000,
      maxTokens: 32_768,
      capabilities: ["text"],
    },
    {
      id: "mistral-small-latest",
      label: "Mistral Small",
      contextWindow: 128_000,
      maxTokens: 32_768,
      capabilities: ["text", "image"],
    },
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
  models: [
    {
      id: "gpt-5-mini",
      label: "GPT-5 mini",
      contextWindow: 400_000,
      maxTokens: 128_000,
      capabilities: ["text", "image", "reasoning"],
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      capabilities: ["text", "image", "reasoning"],
    },
    {
      id: "o4-mini",
      label: "o4-mini",
      contextWindow: 200_000,
      maxTokens: 100_000,
      capabilities: ["text", "image", "reasoning"],
    },
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
  models: [
    {
      id: "grok-3",
      label: "Grok 3",
      contextWindow: 131_072,
      maxTokens: 65_536,
      capabilities: ["text", "image"],
      cost: { input: 3, output: 15 },
    },
    {
      id: "grok-3-mini",
      label: "Grok 3 Mini",
      contextWindow: 131_072,
      maxTokens: 65_536,
      capabilities: ["text", "image", "reasoning"],
      cost: { input: 0.3, output: 0.5 },
    },
    {
      id: "grok-4",
      label: "Grok 4",
      contextWindow: 131_072,
      maxTokens: 65_536,
      capabilities: ["text", "image", "reasoning"],
      cost: { input: 2, output: 6 },
    },
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
