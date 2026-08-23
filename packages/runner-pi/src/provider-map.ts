// SPDX-License-Identifier: Apache-2.0

/**
 * The Pi `MODEL_API` shape → Pi SDK {@link ModelRuntime} provider-key map.
 *
 * Kept in its own module — with NO Pi SDK import — so the boot-critical
 * consumers (`runtime-pi/entrypoint.ts` builds `model.provider` here; the
 * `appstrate` CLI resolves the same key) can pull it WITHOUT dragging
 * `pi-runner.ts` and, through it, the heavy `@earendil-works/pi-coding-agent`
 * module. `pi-runner.ts` and the package barrel re-export from here so every
 * existing import path (`@appstrate/runner-pi`) keeps working.
 */

import type { ModelApiShape } from "@appstrate/core/sidecar-types";

/**
 * Pi provider key an aliased container is bound to — canonical, naming no
 * vendor. {@link PROVIDER_BY_API} resolves `pi-messages` to it; not a built-in
 * pi provider id, so its credential goes in via `setPiRuntimeCredential`.
 */
export const ALIAS_PI_PROVIDER_KEY = "appstrate";

/**
 * `@earendil-works/pi-ai` build this image was compiled against, stamped onto
 * {@link PI_SDK_VERSION_HEADER}. A proxy for `pi-messages` compatibility, not a
 * protocol version.
 */
export const PI_SDK_VERSION = "0.84.2";
/* Pinned against every manifest in the repo by `test/pi-sdk-version.test.ts`. */

/** Container → sidecar only; never forwarded to a backing. */
export const PI_SDK_VERSION_HEADER = "x-appstrate-pi-sdk";

/**
 * Single source of truth for both the in-container path (entrypoint builds
 * `model.provider` from it) and the CLI's local-run resolver, which imports
 * this const + {@link deriveProviderFromApi} rather than keeping its own copy.
 */
export const PROVIDER_BY_API: Record<ModelApiShape, string> = {
  "pi-messages": ALIAS_PI_PROVIDER_KEY,
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "openai",
  "openai-codex-responses": "openai-codex",
  "mistral-conversations": "mistral",
  "google-generative-ai": "google",
  "google-vertex": "google-vertex",
  "azure-openai-responses": "azure-openai-responses",
  "bedrock-converse-stream": "amazon-bedrock",
};

/**
 * Convert a Pi `MODEL_API` string into the provider key the Pi SDK's
 * {@link ModelRuntime} uses to select its native provider and look up API keys.
 */
export function deriveProviderFromApi(api: string): string {
  const provider = (PROVIDER_BY_API as Record<string, string>)[api];
  if (!provider) throw new Error(`PiRunner: unknown model api "${api}"`);
  return provider;
}

/**
 * Appstrate model-provider id → the Pi SDK provider key that backs it.
 *
 * ## Why this exists
 *
 * Pi does not carry provider quirks on the model record: it RE-DERIVES them
 * per request from `model.provider` and `model.baseUrl` — which spelling of
 * the system role to send (`system` vs `developer`), which token-cap field,
 * which thinking dialect to parse back. Appstrate proxies every platform
 * inference call (chat → `/api/llm-proxy/*`, container runs → the sidecar), so
 * `baseUrl` is ours, not the vendor's. If `provider` is ALSO generic — derived
 * from the api shape via {@link deriveProviderFromApi} — Pi has nothing left
 * to recognise and falls back to plain-OpenAI shape. DeepSeek answers that
 * with `400 unknown variant 'developer'`; the quieter mismatches just degrade.
 *
 * Keeping the REAL provider key on the proxied model is Pi's own documented
 * answer to this ("Override Existing Provider — the simplest use case:
 * redirect an existing provider through a proxy", `pi-coding-agent`
 * docs/custom-provider.md). Auth still resolves against the key we register
 * ourselves, and nothing re-points `baseUrl`: only GitHub Copilot's OAuth
 * resolver returns one, and no proxied Appstrate model uses it.
 *
 * Mapped ids are Pi's built-in provider ids — pinned against Pi's own
 * registry by `test/provider-map.test.ts`, so a rename upstream fails there
 * instead of silently reverting a provider to the generic shape.
 */
export const PI_PROVIDER_BY_MODEL_PROVIDER: Readonly<Record<string, string>> = {
  cerebras: "cerebras",
  deepseek: "deepseek",
  "fireworks-ai": "fireworks",
  groq: "groq",
  moonshot: "moonshotai",
  "opencode-go": "opencode-go",
  openrouter: "openrouter",
  "together-ai": "together",
  xai: "xai",
  zai: "zai",
};

/**
 * The Pi provider key for a model, preferring the real backing provider and
 * falling back to the api shape's generic key.
 *
 * The fallback covers three cases, all correct: a provider Pi has no entry for
 * (`openai-compatible` — a self-hosted OpenAI server IS the generic shape), an
 * Appstrate provider whose id already equals Pi's (`anthropic`, `openai`,
 * `mistral`), and a caller with no provider id at all (the CLI resolving an
 * ALIASED preset, whose backing the platform deliberately withholds).
 */
export function derivePiProvider(providerId: string | null | undefined, api: string): string {
  return (providerId && PI_PROVIDER_BY_MODEL_PROVIDER[providerId]) || deriveProviderFromApi(api);
}
