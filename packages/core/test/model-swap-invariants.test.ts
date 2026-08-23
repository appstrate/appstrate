// SPDX-License-Identifier: Apache-2.0

/**
 * The shared alias-boundary predicates, in the always-on tier so a regression
 * fails every pre-merge run:
 *   - `checkAliasInvariants` — behind every surface that ACCEPTS an alias.
 *     Route-level coverage lives in the label-gated integration suite.
 *   - `isAliasInferenceCall` — behind the sidecar's narrowed `/llm/*` surface for
 *     a run that already HAS an alias.
 */

import { describe, it, expect } from "bun:test";
import {
  checkAliasInvariants,
  isAliasBackingShape,
  isAliasClientShape,
  isAliasInferenceCall,
  ALIAS_BACKING_INFERENCE_PATHS,
  ALIAS_BACKING_SHAPES,
  ALIAS_CLIENT_API_SHAPE,
  ALIAS_INFERENCE_PATHS,
} from "../src/model-swap.ts";
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

  it("rejects the client-only dialect as a backing", () => {
    // `pi-messages` is what an aliased CONTAINER speaks to the sidecar. It is
    // never something the sidecar re-originates against.
    expect(checkAliasInvariants({ ...wellFormed, apiShape: "pi-messages" })).toBe(
      "non_aliasable_shape",
    );
  });

  it("isAliasBackingShape matches the backing whitelist", () => {
    const backingShapes: ModelApiShape[] = [
      "anthropic-messages",
      "openai-completions",
      "openai-responses",
      "openai-codex-responses",
      "mistral-conversations",
    ];
    for (const shape of backingShapes) {
      expect(isAliasBackingShape(shape)).toBe(true);
    }
    expect(isAliasBackingShape("google-generative-ai")).toBe(false);
    expect(isAliasBackingShape("pi-messages")).toBe(false);
  });

  it("isAliasClientShape accepts only the canonical client dialect", () => {
    expect(isAliasClientShape(ALIAS_CLIENT_API_SHAPE)).toBe(true);
    expect(isAliasClientShape("pi-messages")).toBe(true);
    for (const shape of ["anthropic-messages", "openai-completions"] as ModelApiShape[]) {
      expect(isAliasClientShape(shape)).toBe(false);
    }
  });
});

/**
 * `ALIAS_INFERENCE_PATHS` / `isAliasInferenceCall` — the allowlist the sidecar
 * narrows an ALIASED run's `/llm/*` surface to. A wrong path breaks every real
 * run of that protocol family, and a missing entry silently re-opens the
 * passthrough, so both directions are pinned per shape. Each expected path is the
 * literal the in-container SDK appends to `MODEL_BASE_URL`.
 */
describe("isAliasInferenceCall", () => {
  /**
   * A swap whose CLIENT speaks `shape`. The predicate reads only that field, so
   * every case varies the client shape and pins the backing to something else.
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
    ["anthropic-messages", "/v1/messages"],
    ["openai-completions", "/chat/completions"],
    ["openai-responses", "/responses"],
    ["openai-codex-responses", "/codex/responses"],
    ["mistral-conversations", "/v1/chat/completions"],
    // The one an ALIASED container speaks — see `ALIAS_CLIENT_API_SHAPE`.
    ["pi-messages", "/messages"],
  ];

  it("maps every aliasable shape to its SDK's inference path", () => {
    // Widened view: the table's literal value types would otherwise make the
    // comparison a tautology against itself rather than against these paths.
    const tabled: Readonly<Partial<Record<ModelApiShape, string>>> = ALIAS_INFERENCE_PATHS;
    expect(tabled).toEqual(Object.fromEntries(expectedPaths));
  });

  it("is the backing table plus the client dialect — no more, no fewer", () => {
    const client = [...[...ALIAS_BACKING_SHAPES], ALIAS_CLIENT_API_SHAPE].sort();
    expect(Object.keys(ALIAS_INFERENCE_PATHS).sort()).toEqual(client);
    expect(Object.keys(ALIAS_BACKING_INFERENCE_PATHS).sort()).toEqual(
      [...ALIAS_BACKING_SHAPES].sort(),
    );
  });

  it("gives every backing the same path in both tables", () => {
    const client: Readonly<Partial<Record<ModelApiShape, string>>> = ALIAS_INFERENCE_PATHS;
    for (const [shape, path] of Object.entries(ALIAS_BACKING_INFERENCE_PATHS)) {
      expect(client[shape as ModelApiShape]).toBe(path);
    }
  });

  it("accepts POST on each shape's own inference path", () => {
    for (const [shape, path] of expectedPaths) {
      expect(isAliasInferenceCall(clientSwap(shape), "POST", path)).toBe(true);
    }
  });

  it("keys on the CLIENT protocol, never the backing's", () => {
    // An aliased run's container speaks `pi-messages` while the backing speaks
    // whatever the vendor does, so reading the backing's path would refuse EVERY
    // aliased run — and reading none would re-open the passthrough.
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
