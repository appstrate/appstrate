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
  projectAliasUpstreamStatus,
  ALIAS_CLIENT_API_SHAPE,
  ALIAS_COLLAPSED_UPSTREAM_STATUS,
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

/**
 * The status projection balances TWO axes, and the allowlist was drawn on only
 * one of them. Everything it does not enumerate collapses to
 * {@link ALIAS_COLLAPSED_UPSTREAM_STATUS} — 502 — which pi-ai's
 * `RETRYABLE_PROVIDER_ERROR_PATTERN` matches on the literal `"502"`. So a
 * status left out of the set is not merely opaque: it is RETRYABLE, and the
 * container burns its whole retry budget on a request that can never succeed.
 */
describe("projectAliasUpstreamStatus", () => {
  it("forwards the generic 4xx that carry no vendor identity", () => {
    // 413 (request too large — Anthropic/Vertex/Bedrock on an oversized
    // prompt) and 402 (OpenRouter on exhausted credits) are terminal by
    // construction. Collapsed to 502 they became retryable, and 402 lost the
    // only actionable word it had: the alias boundary already replaced
    // "billing" — the token `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN` keys
    // on — with "Upstream model error".
    for (const status of [402, 405, 413, 415, 422, 431]) {
      expect(projectAliasUpstreamStatus(status)).toBe(status);
    }
  });

  it("still forwards the generic statuses the set was drawn for", () => {
    for (const status of [400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504]) {
      expect(projectAliasUpstreamStatus(status)).toBe(status);
    }
  });

  it("still collapses the vendor-identifying ranges", () => {
    // The axis that DOES hold: 529 is Anthropic's own overload code and
    // 520–526 say the backing sits behind Cloudflare. Both name a vendor as
    // surely as the prose the boundary scrubbed, and both are genuinely
    // transient, so collapsing them to a retryable 502 costs nothing.
    for (const fingerprint of [529, 520, 524, 521, 522, 523, 525, 526]) {
      expect(projectAliasUpstreamStatus(fingerprint)).toBe(ALIAS_COLLAPSED_UPSTREAM_STATUS);
    }
  });

  it("defaults an unenumerated status to opaque", () => {
    // The set stays an allowlist: a code nobody has seen yet must default to
    // collapsed, not to disclosed.
    for (const unknown of [418, 451, 499, 599]) {
      expect(projectAliasUpstreamStatus(unknown)).toBe(ALIAS_COLLAPSED_UPSTREAM_STATUS);
    }
  });
});
