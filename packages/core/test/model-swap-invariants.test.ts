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
  ALIAS_COLLAPSED_TRANSIENT_UPSTREAM_STATUS,
  ALIAS_COLLAPSED_TERMINAL_UPSTREAM_STATUS,
  syntheticAliasClassifierMessage,
  syntheticAliasErrorBody,
} from "../src/model-swap.ts";
import { classifyModelError } from "../src/model-error.ts";
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
 * The status projection answers TWO questions per status, and an earlier draft
 * traded one for the other in each direction:
 *
 *   - may the number be disclosed? (VENDOR IDENTITY)
 *   - if not, what does the collapsed number MEAN to pi-ai's retry classifier?
 *     (RETRYABILITY — `RETRYABLE_PROVIDER_ERROR_PATTERN` matches the literal
 *     `"502"`, so collapsing everything to 502 makes permanent failures
 *     retryable, and the container burns its whole budget on a request that
 *     can never succeed.)
 *
 * Two collapse targets exist for exactly that reason:
 * {@link ALIAS_COLLAPSED_TERMINAL_UPSTREAM_STATUS} (400) for a 4xx and
 * {@link ALIAS_COLLAPSED_TRANSIENT_UPSTREAM_STATUS} (502) for anything else.
 * The retryability half is asserted against pi-ai's REAL classifier in
 * `runtime-pi/sidecar/test/pi-messages-backend.test.ts`; what is checked here
 * is the projection's own algebra.
 */
describe("projectAliasUpstreamStatus", () => {
  /**
   * Statuses only SOME candidate backings answer, so the number itself names
   * the backing — the same disclosure the scrubbed prose exists to prevent.
   * `402` is an aggregating gateway out of credit (Anthropic/OpenAI/Mistral
   * have no 402), `422` is Mistral's validation verdict where the others
   * answer 400, `431` and `520`–`526` are edge/CDN codes the model API never
   * emits, and `529` is Anthropic's own overload code.
   */
  const VENDOR_IDENTIFYING = [402, 422, 431, 520, 521, 522, 523, 524, 525, 526, 529];

  it("forwards the generic statuses the set was drawn for", () => {
    for (const status of [400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504]) {
      expect(projectAliasUpstreamStatus(status)).toBe(status);
    }
  });

  it("forwards the HTTP-framing verdicts, which single out no candidate", () => {
    // 405 (method), 413 (body too large), 415 (media type) are answered by the
    // HTTP layer of any server, not by a model API's error vocabulary — so
    // axis 1 is clean. Forwarded verbatim they are also terminal under pi-ai's
    // classifier, which is the right verdict for an oversized prompt, so
    // nothing has to be traded away to keep them.
    for (const status of [405, 413, 415]) {
      expect(projectAliasUpstreamStatus(status)).toBe(status);
    }
  });

  it("collapses every vendor-identifying status", () => {
    for (const fingerprint of VENDOR_IDENTIFYING) {
      expect(projectAliasUpstreamStatus(fingerprint)).not.toBe(fingerprint);
    }
  });

  it("collapses a vendor-identifying 4xx to the TERMINAL target", () => {
    // The half the widening got wrong in the other direction: 402/422/431 were
    // forwarded to keep them terminal, which disclosed the backing. Collapsing
    // them to 400 keeps them terminal AND opaque — 400 is a status every
    // candidate answers, and the one the non-Mistral candidates answer for the
    // very failure 422 describes.
    for (const fingerprint of [402, 422, 431]) {
      expect(projectAliasUpstreamStatus(fingerprint)).toBe(
        ALIAS_COLLAPSED_TERMINAL_UPSTREAM_STATUS,
      );
    }
  });

  it("collapses a vendor-identifying 5xx to the TRANSIENT target", () => {
    // The original axis, unchanged: 529 (Anthropic overload) and 520–526
    // (Cloudflare) are genuinely transient, so 502 hides the tell and keeps
    // the container's retry.
    for (const fingerprint of [529, 520, 521, 522, 523, 524, 525, 526]) {
      expect(projectAliasUpstreamStatus(fingerprint)).toBe(
        ALIAS_COLLAPSED_TRANSIENT_UPSTREAM_STATUS,
      );
    }
  });

  it("defaults an unenumerated status to opaque, by class", () => {
    // The set stays an allowlist: a code nobody has seen yet must default to
    // collapsed, not to disclosed. The CLASS picks the target, so the default
    // is right on the retry axis too — an unknown 4xx fails fast, an unknown
    // 5xx is retried.
    for (const unknown of [418, 451, 499]) {
      expect(projectAliasUpstreamStatus(unknown)).toBe(ALIAS_COLLAPSED_TERMINAL_UPSTREAM_STATUS);
    }
    for (const unknown of [507, 530, 599]) {
      expect(projectAliasUpstreamStatus(unknown)).toBe(ALIAS_COLLAPSED_TRANSIENT_UPSTREAM_STATUS);
    }
  });

  it("never emits a vendor-identifying status, for any input in 400–599", () => {
    // The whole-domain sweep the per-status cases cannot give: whatever an
    // upstream answers, what LEAVES this function is never one of the codes
    // that names a backing. A future widening that re-forwards one of them
    // fails here even if it forgets to touch the case above.
    const identifying = new Set(VENDOR_IDENTIFYING);
    for (let status = 400; status <= 599; status++) {
      expect(identifying.has(projectAliasUpstreamStatus(status))).toBe(false);
    }
  });

  it("is idempotent: a projected status is itself forwardable", () => {
    // Both boundaries project before disclosing, and the sidecar's status can
    // be re-projected by the gateway in front of it. A target that were not
    // itself in the allowlist would collapse a second time and lose the
    // terminal/transient partition on the way.
    for (let status = 400; status <= 599; status++) {
      const once = projectAliasUpstreamStatus(status);
      expect(projectAliasUpstreamStatus(once)).toBe(once);
    }
  });
});

/**
 * An alias is ORG-CONTROLLED text, and every classifier that reads an aliased
 * failure is a substring matcher: pi-ai's `isRetryableAssistantError`
 * alternates over `500`/`502`/`overloaded`/`rate.?limit`/…, and this package's
 * own {@link classifyModelError} reads a `\b[45]\d\d\b` out of the message.
 * Interpolating the alias into that sentence let the org decide the retry
 * verdict — an alias named `gpt-500-fast` turned the TERMINAL 400 that
 * `projectAliasUpstreamStatus` collapses a permanent failure to back into a
 * retryable outage, on both classifiers.
 *
 * The two sides of the boundary are separate functions now:
 * `syntheticAliasClassifierMessage` takes no `ModelSwap` (nothing to
 * interpolate), and the alias rides `error.model` in the wire body. The pi-ai
 * half is asserted against the real SDK in
 * `runtime-pi/sidecar/test/pi-messages-backend.test.ts`; this file owns the
 * half whose classifier lives in this package.
 */
describe("alias error text stays out of every classifier's reach", () => {
  const HOSTILE_ALIASES = [
    "gpt-500-fast",
    "turbo-502",
    "claude-overloaded-x",
    "model-524-preview",
    "billing-tier-model",
  ];

  const swapFor = (alias: string): ModelSwap => ({
    alias,
    real: "deepseek-SECRET",
    clientApiShape: "pi-messages",
    backingApiShape: "anthropic-messages",
  });

  it("keeps the alias out of the classified sentence and in a structured field", () => {
    for (const alias of HOSTILE_ALIASES) {
      const body = JSON.parse(syntheticAliasErrorBody(swapFor(alias), 400)) as {
        error: { message: string; model: string };
      };
      // The operator signal survives — just not as prose.
      expect(body.error.model).toBe(alias);
      expect(body.error.message).toBe("Upstream model error (status 400)");
      expect(body.error.message).not.toContain(alias);
    }
  });

  it("gives this package's own classifier the same verdict whatever the alias", () => {
    // The property: the alias cannot move the verdict, because it is not in
    // the string being classified. `gpt-500-fast` used to read as
    // `upstream_unavailable`/retryable on a terminal 400.
    const baseline = classifyModelError({
      message: JSON.parse(syntheticAliasErrorBody(swapFor("plain-alias"), 400)).error.message,
    });
    expect(baseline).toMatchObject({ category: "invalid_request", retryable: false });
    for (const alias of HOSTILE_ALIASES) {
      const message = JSON.parse(syntheticAliasErrorBody(swapFor(alias), 400)).error
        .message as string;
      expect(classifyModelError({ message })).toEqual(baseline);
    }
  });

  it("control: the STATUS still moves the verdict, so the message is not inert", () => {
    // Without this the case above passes on a message so neutral that nothing
    // classifies — which would cost the container its retry on a real 429.
    expect(
      classifyModelError({
        message: JSON.parse(syntheticAliasErrorBody(swapFor("plain-alias"), 429)).error.message,
      }),
    ).toMatchObject({ category: "rate_limited", retryable: true });
  });

  it("refuses to interpolate a status the projection could never emit", () => {
    // The integers that can appear in the classified sentence are the
    // forwardable set and nothing else, so the token space a future caller can
    // widen by accident is closed. 529 and 1500 are not in it.
    expect(syntheticAliasClassifierMessage(529)).toBe("Upstream model error");
    expect(syntheticAliasClassifierMessage(1500)).toBe("Upstream model error");
    expect(syntheticAliasClassifierMessage()).toBe("Upstream model error");
    expect(syntheticAliasClassifierMessage(429)).toBe("Upstream model error (status 429)");
  });
});
