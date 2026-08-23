// SPDX-License-Identifier: Apache-2.0

/**
 * The shared alias-boundary predicates, kept in the always-on tier so a
 * regression fails every pre-merge run:
 *   - `checkAliasInvariants` — behind every surface that ACCEPTS an alias
 *     (env-seeded registry skip, POST/PUT /api/models 400). Route-level
 *     coverage lives in the label-gated integration suite.
 *   - `isAliasInferenceCall` — behind the sidecar's narrowed `/llm/*` surface
 *     for a run that already HAS an alias.
 *   - `maskAliasedTokenLimits` — behind the agent container's env contract for
 *     such a run (`buildRuntimePiEnv`).
 */

import { describe, it, expect } from "bun:test";
import {
  checkAliasInvariants,
  isAliasableApiShape,
  isAliasInferenceCall,
  maskAliasedTokenLimits,
  ALIAS_INFERENCE_PATHS,
  ALIASABLE_API_SHAPES,
} from "../src/model-swap.ts";
import { deriveResponseReserveTokens, isUsableMaxOutputTokens } from "../src/token-budget.ts";
import type { ModelApiShape, ModelSwap } from "../src/sidecar-types.ts";

describe("checkAliasInvariants", () => {
  const wellFormed = {
    label: "Appstrate Medium",
    apiShape: "anthropic-messages" as ModelApiShape,
    authMode: "api_key" as const,
  };

  it("accepts a labelled, body-model, api-key alias", () => {
    expect(checkAliasInvariants(wellFormed)).toBeNull();
  });

  it("requires an explicit label (derived labels name the backing)", () => {
    expect(checkAliasInvariants({ ...wellFormed, label: undefined })).toBe("missing_label");
    expect(checkAliasInvariants({ ...wellFormed, label: null })).toBe("missing_label");
    expect(checkAliasInvariants({ ...wellFormed, label: "" })).toBe("missing_label");
  });

  it("rejects url-model protocols (the swap only rewrites the body `model` field)", () => {
    const urlModelShapes: ModelApiShape[] = [
      "google-generative-ai",
      "google-vertex",
      "azure-openai-responses",
      "bedrock-converse-stream",
    ];
    for (const shape of urlModelShapes) {
      expect(checkAliasInvariants({ ...wellFormed, apiShape: shape })).toBe("non_aliasable_shape");
    }
  });

  it("rejects oauth-subscription providers (the oauth path is a pure bearer-swap)", () => {
    expect(checkAliasInvariants({ ...wellFormed, authMode: "oauth2" })).toBe("oauth_provider");
  });

  it("reports the label violation before the shape/auth ones (route error precedence)", () => {
    expect(
      checkAliasInvariants({ label: undefined, apiShape: wellFormed.apiShape, authMode: "oauth2" }),
    ).toBe("missing_label");
  });

  it("isAliasableApiShape matches the body-model protocol whitelist", () => {
    const bodyModelShapes: ModelApiShape[] = [
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
      "openai-codex-responses",
      "mistral-conversations",
      // pi-ai's own protocol also carries the id as a top-level body `model`,
      // so a gateway that speaks it is aliasable on the same terms.
      "pi-messages",
    ];
    for (const shape of bodyModelShapes) {
      expect(isAliasableApiShape(shape)).toBe(true);
    }
    expect(isAliasableApiShape("google-generative-ai")).toBe(false);
  });
});

/**
 * `ALIAS_INFERENCE_PATHS` / `isAliasInferenceCall` — the allowlist the sidecar
 * narrows an ALIASED run's `/llm/*` surface to (issue #1198). A wrong path here
 * breaks every real run of that protocol family, and a missing entry silently
 * re-opens the passthrough, so both directions are pinned per shape.
 *
 * Each expected path is the literal the in-container SDK appends to
 * `MODEL_BASE_URL` (= `<sidecar>/llm`, whose `/llm` prefix `deriveLlmTarget`
 * strips), taken from the SDK sources rather than inferred.
 */
describe("isAliasInferenceCall", () => {
  /**
   * A swap whose CLIENT speaks `shape`. The predicate reads only that field —
   * the backing's own protocol is a different fact and deliberately not the one
   * the inbound allowlist keys on (an aliased container posts `/messages`
   * whatever the vendor behind the sidecar is), so every case here varies the
   * client shape and pins the backing to something else.
   */
  function clientSwap(shape: ModelApiShape): ModelSwap {
    return {
      alias: "appstrate-medium",
      real: "some-backing",
      clientApiShape: shape,
      backingApiShape: "anthropic-messages",
    };
  }

  const expectedPaths: ReadonlyArray<[ModelApiShape, string]> = [
    // `@anthropic-ai/sdk` — `messages.create` posts '/v1/messages'.
    ["anthropic-messages", "/v1/messages"],
    // `openai` — `chat.completions.create` posts '/chat/completions'.
    ["openai-completions", "/chat/completions"],
    // `openai` — `responses.create` posts '/responses'.
    ["openai-responses", "/responses"],
    // pi-ai `resolveCodexUrl` appends '/codex/responses' itself.
    ["openai-codex-responses", "/codex/responses"],
    // pi-ai resolves 'v1/chat/completions' against a slash-terminated base URL.
    ["mistral-conversations", "/v1/chat/completions"],
    // pi-ai's own vendor-neutral protocol posts '<baseUrl>/messages'. This is
    // the one an ALIASED container speaks — see `ALIAS_CLIENT_API_SHAPE`.
    ["pi-messages", "/messages"],
  ];

  it("maps every aliasable shape to its SDK's inference path", () => {
    // Widened view: the table's literal value types would otherwise make the
    // comparison a tautology against itself rather than against these paths.
    const tabled: Readonly<Partial<Record<ModelApiShape, string>>> = ALIAS_INFERENCE_PATHS;
    expect(tabled).toEqual(Object.fromEntries(expectedPaths));
  });

  it("covers exactly the aliasable shapes — no more, no fewer", () => {
    const tabled = Object.keys(ALIAS_INFERENCE_PATHS).sort();
    const aliasable = [...ALIASABLE_API_SHAPES].sort();
    expect(tabled).toEqual(aliasable);
  });

  it("accepts POST on each shape's own inference path", () => {
    for (const [shape, path] of expectedPaths) {
      expect(isAliasInferenceCall(clientSwap(shape), "POST", path)).toBe(true);
    }
  });

  it("keys on the CLIENT protocol, never the backing's", () => {
    // The interaction that makes this predicate subtle. An aliased run's
    // container speaks `pi-messages` while the backing speaks whatever the
    // vendor does, so reading the backing's path would refuse EVERY aliased
    // run — and reading no path at all would re-open the passthrough the
    // allowlist exists to close.
    const aliasedRun: ModelSwap = {
      alias: "appstrate-medium",
      real: "deepseek-chat",
      clientApiShape: "pi-messages",
      backingApiShape: "openai-completions",
    };
    expect(isAliasInferenceCall(aliasedRun, "POST", "/messages")).toBe(true);
    expect(isAliasInferenceCall(aliasedRun, "POST", "/chat/completions")).toBe(false);
  });

  it("refuses another shape's inference path", () => {
    // The families overlap textually (`/v1/chat/completions` is Mistral's, not
    // OpenAI's), so the check is per shape, never "any known inference path".
    expect(
      isAliasInferenceCall(clientSwap("openai-completions"), "POST", "/v1/chat/completions"),
    ).toBe(false);
    expect(
      isAliasInferenceCall(clientSwap("anthropic-messages"), "POST", "/chat/completions"),
    ).toBe(false);
    expect(isAliasInferenceCall(clientSwap("openai-responses"), "POST", "/codex/responses")).toBe(
      false,
    );
  });

  it("refuses every non-POST method, including on the right path", () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(
        isAliasInferenceCall(clientSwap("openai-completions"), method, "/chat/completions"),
      ).toBe(false);
    }
  });

  it("accepts a lower-cased method (HTTP does not fix the casing a client sends)", () => {
    expect(
      isAliasInferenceCall(clientSwap("openai-completions"), "post", "/chat/completions"),
    ).toBe(true);
  });

  it("refuses the vendor catalogue read that motivated the allowlist", () => {
    for (const [shape] of expectedPaths) {
      expect(isAliasInferenceCall(clientSwap(shape), "GET", "/v1/models")).toBe(false);
      expect(isAliasInferenceCall(clientSwap(shape), "POST", "/v1/models")).toBe(false);
    }
  });

  it("matches the path exactly — no prefix, suffix or trailing-slash slack", () => {
    expect(
      isAliasInferenceCall(clientSwap("openai-completions"), "POST", "/chat/completions/"),
    ).toBe(false);
    expect(
      isAliasInferenceCall(clientSwap("openai-completions"), "POST", "/chat/completions/extra"),
    ).toBe(false);
    expect(isAliasInferenceCall(clientSwap("openai-completions"), "POST", "chat/completions")).toBe(
      false,
    );
    expect(
      isAliasInferenceCall(clientSwap("openai-completions"), "POST", "/v1/chat/completions"),
    ).toBe(false);
  });

  it("fails closed for a url-model shape (no entry ⇒ nothing is allowed)", () => {
    const urlModelShapes: ModelApiShape[] = [
      "google-generative-ai",
      "google-vertex",
      "azure-openai-responses",
      "bedrock-converse-stream",
    ];
    for (const shape of urlModelShapes) {
      expect(isAliasInferenceCall(clientSwap(shape), "POST", "/v1/messages")).toBe(false);
      expect(isAliasInferenceCall(clientSwap(shape), "POST", "/chat/completions")).toBe(false);
    }
  });
});

describe("maskAliasedTokenLimits", () => {
  // Real catalog pairs an alias might be backed by. `window` is what the org
  // would read off a public catalog if the exact number reached the container.
  const catalog: Array<{ window: number; max: number }> = [
    { window: 200_000, max: 8192 }, // Claude family
    { window: 200_000, max: 64_000 }, // Sonnet thinking
    { window: 131_072, max: 8192 }, // DeepSeek / many OSS models
    { window: 128_000, max: 16_384 }, // GPT-4o family
    { window: 1_047_576, max: 32_768 }, // GPT-4.1
    { window: 2_000_000, max: 8192 }, // Gemini-class
  ];

  it("never rounds UP — `maxTokens` reaches upstream as the response cap", () => {
    // Rounding the cap up risks an upstream 400 which, on an alias, is replaced
    // by the neutral synthesized envelope and becomes undiagnosable. Rounding
    // down only leaves capacity unused.
    for (const { window, max } of catalog) {
      const masked = maskAliasedTokenLimits({ contextWindow: window, maxTokens: max });
      expect(masked.contextWindow).toBeLessThanOrEqual(window);
      expect(masked.maxTokens).toBeLessThanOrEqual(max);
    }
  });

  it("keeps the loss under 6.25 % so compaction is not materially degraded", () => {
    // The ladder is 16 buckets per binary octave, so the worst case is strictly
    // under 1/16. An octave-wide ladder would round 200 000 down to 131 072 and
    // throw away a third of the window.
    for (let n = 1000; n <= 2_100_000; n += 997) {
      const masked = maskAliasedTokenLimits({ contextWindow: n });
      const loss = (n - (masked.contextWindow ?? 0)) / n;
      expect(loss).toBeLessThan(0.0625);
    }
    expect(maskAliasedTokenLimits({ contextWindow: 200_000 }).contextWindow).toBe(196_608);
  });

  it("narrows the candidate set — distinct catalog windows collapse onto one rung", () => {
    // The honest claim: rounding NARROWS, it does not close. What it removes is
    // the ability to look an exact pair up in a public catalog and read off one
    // row.
    const rungs = new Set(
      [128_000, 127_000, 126_976, 200_000, 199_000, 197_000].map(
        (w) => maskAliasedTokenLimits({ contextWindow: w }).contextWindow,
      ),
    );
    expect(rungs.size).toBe(2);
  });

  it("never yields `maxTokens >= contextWindow` for a pair that arrived usable", () => {
    // `deriveResponseReserveTokens` treats that as corrupt data and substitutes
    // a derived reserve, so masking must not manufacture the condition. The
    // close pair is the one that would: independently rounded, 197 000 and
    // 200 000 both land on 196 608.
    const close = maskAliasedTokenLimits({ contextWindow: 200_000, maxTokens: 197_000 });
    expect(close.contextWindow).toBe(196_608);
    expect(close.maxTokens).toBeLessThan(close.contextWindow ?? 0);
    // And the pair still reads as usable to the shared clamp, so the reserve
    // comes from the explicit cap (capped by the 80 % prompt-headroom ceiling,
    // exactly as the raw pair would have been) rather than the fallback.
    expect(isUsableMaxOutputTokens(close.maxTokens, close.contextWindow ?? 0)).toBe(true);

    for (const { window, max } of catalog) {
      const masked = maskAliasedTokenLimits({ contextWindow: window, maxTokens: max });
      expect(masked.maxTokens).toBeLessThan(masked.contextWindow ?? 0);
    }
  });

  it("leaves an ALREADY-impossible pair impossible (masking changes no verdict)", () => {
    // Devstral 2512's `256000 / 256000` from the LiteLLM catalog — the
    // run_b6e99890 case. It falls back to a derived reserve today and must keep
    // doing exactly that; the ladder is monotone, so it cannot turn an unusable
    // pair into a usable one either.
    const masked = maskAliasedTokenLimits({ contextWindow: 256_000, maxTokens: 256_000 });
    expect(masked.maxTokens).toBe(masked.contextWindow);
    expect(deriveResponseReserveTokens(masked.contextWindow ?? 0, masked.maxTokens)).toBe(
      Math.floor((masked.contextWindow ?? 0) * 0.2),
    );
  });

  it("passes through what it cannot round rather than inventing a number", () => {
    expect(maskAliasedTokenLimits({})).toEqual({ contextWindow: null, maxTokens: null });
    expect(maskAliasedTokenLimits({ contextWindow: null, maxTokens: null })).toEqual({
      contextWindow: null,
      maxTokens: null,
    });
    // Out of the roundable range — passed through, and the readers already
    // treat these as unusable.
    expect(maskAliasedTokenLimits({ contextWindow: 0 }).contextWindow).toBe(0);
    expect(maskAliasedTokenLimits({ contextWindow: -5 }).contextWindow).toBe(-5);
    expect(maskAliasedTokenLimits({ contextWindow: 1.5 }).contextWindow).toBe(1.5);
  });
});
