// SPDX-License-Identifier: Apache-2.0

/**
 * `checkAliasInvariants` — the shared predicate behind every surface that
 * accepts a model alias (env-seeded registry skip, POST/PUT /api/models 400).
 * The route-level coverage lives in the label-gated integration suite; this
 * unit test keeps the predicate itself in the always-on tier so a regression
 * (e.g. dropping the `oauth2` arm) fails every pre-merge run.
 */

import { describe, it, expect } from "bun:test";
import { checkAliasInvariants, isAliasableApiShape } from "../src/model-swap.ts";
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
