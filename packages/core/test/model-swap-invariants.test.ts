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
  ALIAS_CLIENT_API_SHAPE,
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
 * `isAliasInferenceCall` — the allowlist the sidecar narrows an ALIASED run's
 * `/llm/*` surface to. The container speaks one dialect (pinned at sidecar boot),
 * so the surface is one method on one path; anything else re-opens the
 * passthrough, and a wrong path breaks every aliased run.
 */
describe("isAliasInferenceCall", () => {
  it("accepts the one inference call an aliased container makes", () => {
    expect(isAliasInferenceCall("POST", "/messages")).toBe(true);
  });

  it("accepts a lower-cased method (HTTP does not fix the casing a client sends)", () => {
    expect(isAliasInferenceCall("post", "/messages")).toBe(true);
  });

  it("refuses the vendor catalogue read that motivated the allowlist", () => {
    expect(isAliasInferenceCall("GET", "/v1/models")).toBe(false);
    expect(isAliasInferenceCall("POST", "/v1/models")).toBe(false);
  });

  it("refuses every other vendor inference path", () => {
    for (const path of [
      "/v1/messages",
      "/chat/completions",
      "/v1/chat/completions",
      "/responses",
      "/codex/responses",
    ]) {
      expect(isAliasInferenceCall("POST", path)).toBe(false);
    }
  });

  it("matches the path exactly — no prefix, suffix or trailing-slash slack", () => {
    expect(isAliasInferenceCall("POST", "/messages/")).toBe(false);
    expect(isAliasInferenceCall("POST", "/messages/extra")).toBe(false);
    expect(isAliasInferenceCall("POST", "messages")).toBe(false);
    expect(isAliasInferenceCall("POST", "/v1/messages")).toBe(false);
    expect(isAliasInferenceCall("POST", "/Messages")).toBe(false);
  });

  it("refuses every non-POST method, including on the right path", () => {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      expect(isAliasInferenceCall(method, "/messages")).toBe(false);
    }
  });
});
