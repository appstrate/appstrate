// SPDX-License-Identifier: Apache-2.0

/**
 * Runner engine selection (plan §5 / Phase 3).
 *
 * Which in-container agent engine a run executes on. Pi (the
 * `@mariozechner/pi-coding-agent` loop) is the default for everything; a
 * `claude-code` subscription run executes on the official **Claude Agent SDK**
 * instead — the ToS-clean path that lets the official `claude` binary sign its
 * own client fingerprint, removing the sidecar `oauthWireFormat` forging the
 * Pi path relies on for subscriptions.
 *
 * Selection is gated by `RUNNER_CLAUDE_ENGINE` (a transition flag + kill-switch
 * — see `@appstrate/env`): when off, even `claude-code` stays on Pi, so the new
 * engine can land dark and flip in one place once validated.
 */

import type {
  LlmProxyOauthConfig,
  LlmProxyOauthPassthroughConfig,
  ModelSwap,
  OAuthWireFormat,
} from "@appstrate/core/sidecar-types";

/** The in-container agent engine for a run. */
export type RunEngine = "pi" | "claude";

/** Provider id of the Claude Pro/Max/Team subscription credential. */
const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/**
 * Pick the engine for a resolved model. `claude-code` → `"claude"` only when
 * the Claude engine is enabled; everything else (and `claude-code` while the
 * flag is off) → `"pi"`. Pure for unit testing — the caller reads the flag.
 */
export function selectRunEngine(
  resolved: { providerId: string },
  claudeEngineEnabled: boolean,
): RunEngine {
  if (claudeEngineEnabled && resolved.providerId === CLAUDE_CODE_PROVIDER_ID) {
    return "claude";
  }
  return "pi";
}

/**
 * Build the sidecar `/llm` config for an OAuth-credentialled run, choosing the
 * forging vs non-forging mode by engine:
 *
 *   - `claude` engine → `oauth-passthrough`: the official Claude Agent SDK
 *     binary signs its OWN fingerprint, so the sidecar must NOT apply
 *     `oauthWireFormat` (no identity headers, no system-prepend). It only swaps
 *     the bearer + ensures the OAuth beta.
 *   - `pi` engine → `oauth`: the Pi SDK does not sign a subscription
 *     fingerprint, so the sidecar forges it from the provider's `wireFormat`.
 *
 * Pure for unit testing. `wireFormat` is ignored on the `claude` path by
 * construction — passing it is harmless, mirroring the registry lookup the
 * caller does once for both branches.
 */
export function buildOauthSidecarLlm(params: {
  engine: RunEngine;
  baseUrl: string;
  credentialId: string;
  wireFormat?: OAuthWireFormat;
  modelSwap?: ModelSwap;
}): LlmProxyOauthConfig | LlmProxyOauthPassthroughConfig {
  const { engine, baseUrl, credentialId, wireFormat, modelSwap } = params;
  if (engine === "claude") {
    return {
      authMode: "oauth-passthrough",
      baseUrl,
      credentialId,
      ...(modelSwap ? { modelSwap } : {}),
    };
  }
  return {
    authMode: "oauth",
    baseUrl,
    credentialId,
    ...(wireFormat ? { wireFormat } : {}),
    ...(modelSwap ? { modelSwap } : {}),
  };
}
