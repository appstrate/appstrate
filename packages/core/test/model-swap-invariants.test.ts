// SPDX-License-Identifier: Apache-2.0

/**
 * The shared alias-boundary predicates, kept in the always-on tier so a
 * regression fails every pre-merge run:
 *   - `checkAliasInvariants` — behind every surface that ACCEPTS an alias
 *     (env-seeded registry skip, POST/PUT /api/models 400). Route-level
 *     coverage lives in the label-gated integration suite.
 *   - `isAliasInferenceCall` — behind the sidecar's narrowed `/llm/*` surface
 *     for a run that already HAS an alias.
 */

import { describe, it, expect } from "bun:test";
import {
  checkAliasInvariants,
  isAliasableApiShape,
  isAliasInferenceCall,
  ALIAS_INFERENCE_PATHS,
  ALIASABLE_API_SHAPES,
} from "../src/model-swap.ts";
import type { ModelApiShape } from "../src/sidecar-types.ts";

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
      expect(isAliasInferenceCall(shape, "POST", path)).toBe(true);
    }
  });

  it("refuses another shape's inference path", () => {
    // The families overlap textually (`/v1/chat/completions` is Mistral's, not
    // OpenAI's), so the check is per shape, never "any known inference path".
    expect(isAliasInferenceCall("openai-completions", "POST", "/v1/chat/completions")).toBe(false);
    expect(isAliasInferenceCall("anthropic-messages", "POST", "/chat/completions")).toBe(false);
    expect(isAliasInferenceCall("openai-responses", "POST", "/codex/responses")).toBe(false);
  });

  it("refuses every non-POST method, including on the right path", () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(isAliasInferenceCall("openai-completions", method, "/chat/completions")).toBe(false);
    }
  });

  it("accepts a lower-cased method (HTTP does not fix the casing a client sends)", () => {
    expect(isAliasInferenceCall("openai-completions", "post", "/chat/completions")).toBe(true);
  });

  it("refuses the vendor catalogue read that motivated the allowlist", () => {
    for (const [shape] of expectedPaths) {
      expect(isAliasInferenceCall(shape, "GET", "/v1/models")).toBe(false);
      expect(isAliasInferenceCall(shape, "POST", "/v1/models")).toBe(false);
    }
  });

  it("matches the path exactly — no prefix, suffix or trailing-slash slack", () => {
    expect(isAliasInferenceCall("openai-completions", "POST", "/chat/completions/")).toBe(false);
    expect(isAliasInferenceCall("openai-completions", "POST", "/chat/completions/extra")).toBe(
      false,
    );
    expect(isAliasInferenceCall("openai-completions", "POST", "chat/completions")).toBe(false);
    expect(isAliasInferenceCall("openai-completions", "POST", "/v1/chat/completions")).toBe(false);
  });

  it("fails closed for a url-model shape (no entry ⇒ nothing is allowed)", () => {
    const urlModelShapes: ModelApiShape[] = [
      "google-generative-ai",
      "google-vertex",
      "azure-openai-responses",
      "bedrock-converse-stream",
    ];
    for (const shape of urlModelShapes) {
      expect(isAliasInferenceCall(shape, "POST", "/v1/messages")).toBe(false);
      expect(isAliasInferenceCall(shape, "POST", "/chat/completions")).toBe(false);
    }
  });
});
