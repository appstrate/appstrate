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
export const PI_SDK_VERSION = "0.86.1";
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
