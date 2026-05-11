// SPDX-License-Identifier: Apache-2.0

/**
 * Core Providers module — ships the three API-key model providers
 * (`openai`, `anthropic`, `openai-compatible`) that any Appstrate
 * deployment is expected to support out of the box.
 *
 * No legal grey area, no reverse-engineered wire format — these are
 * direct API integrations against the canonical platform.* hosts. The
 * module is enabled by default in `.env.example` (`MODULES=oidc,webhooks,
 * core-providers,...`).
 *
 * OAuth-flavoured providers (codex, codex-fork-X, ...) live in their own
 * modules so operators can disable them granularly — see
 * `apps/api/src/modules/codex/` for the canonical example.
 */

import type { AppstrateModule, ModelProviderDefinition } from "@appstrate/core/module";

const openai: ModelProviderDefinition = {
  providerId: "openai",
  displayName: "OpenAI",
  iconUrl: "openai",
  description: "Bring your own OpenAI API key.",
  docsUrl: "https://platform.openai.com/docs/api-reference",
  apiShape: "openai-chat",
  defaultBaseUrl: "https://api.openai.com",
  baseUrlOverridable: false,
  authMode: "api_key",
  models: [],
};

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
  models: [],
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
    // Nothing to initialize — the contribution is fully declarative.
    // The runtime registry pulls providers from `modelProviders()` at boot.
  },

  modelProviders() {
    return [openai, anthropic, openaiCompatible];
  },
};

export default coreProvidersModule;
