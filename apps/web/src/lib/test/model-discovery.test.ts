// SPDX-License-Identifier: Apache-2.0

/**
 * What "ask this endpoint what it serves" puts on the wire.
 *
 * The route takes exactly one of two forms and answers 400 to both at once or
 * neither, so which one is emitted is the whole contract — and it is decided by
 * two facts the form holds: whether a saved credential is selected, and whether
 * the provider lets the operator move the base URL.
 */

import { describe, it, expect } from "bun:test";
import { buildDiscoverBody, discoveryFailureOutcome, parsesAsUrl } from "../model-discovery.ts";
import { ApiError } from "../../api/errors.ts";

const OPENAI_COMPATIBLE = {
  providerId: "openai-compatible",
  baseUrlOverridable: true,
};
const ANTHROPIC = { providerId: "anthropic", baseUrlOverridable: false };

describe("buildDiscoverBody — a saved credential", () => {
  it("names the credential and nothing else: it already carries key and endpoint", () => {
    expect(
      buildDiscoverBody({
        credentialId: "cred_1",
        provider: OPENAI_COMPATIBLE,
        inlineApiKey: "sk-typed",
        baseUrl: "http://localhost:11434/v1",
      }),
    ).toEqual({ credentialId: "cred_1" });
  });
});

describe("buildDiscoverBody — a key typed inline", () => {
  it("describes the endpoint the key opens, trimmed", () => {
    expect(
      buildDiscoverBody({
        credentialId: null,
        provider: OPENAI_COMPATIBLE,
        inlineApiKey: "  sk-test  ",
        baseUrl: "  http://localhost:11434/v1  ",
      }),
    ).toEqual({
      providerId: "openai-compatible",
      api_key: "sk-test",
      base_url_override: "http://localhost:11434/v1",
    });
  });

  it("omits the base URL for a provider that pins its own endpoint", () => {
    // The route accepts `base_url_override` only where `baseUrlOverridable` is
    // true; the form still holds the pinned default in the field.
    expect(
      buildDiscoverBody({
        credentialId: null,
        provider: ANTHROPIC,
        inlineApiKey: "sk-ant-test",
        baseUrl: "https://api.anthropic.com",
      }),
    ).toEqual({ providerId: "anthropic", api_key: "sk-ant-test" });
  });
});

describe("parsesAsUrl", () => {
  it("accepts only an HTTP(S) endpoint", () => {
    expect(parsesAsUrl(" http://localhost:11434/v1 ")).toBe(true);
    expect(parsesAsUrl("https://api.example.com")).toBe(true);
    expect(parsesAsUrl("ftp://example.com")).toBe(false);
    expect(parsesAsUrl("not a url")).toBe(false);
  });
});

describe("discoveryFailureOutcome", () => {
  it("names the platform's own rate limit apart from any other refusal", () => {
    expect(discoveryFailureOutcome(new ApiError("rate_limited", "Too many", 429))).toBe(
      "throttled",
    );
    expect(discoveryFailureOutcome(new ApiError("internal_error", "boom", 500))).toBe(
      "request_failed",
    );
    expect(discoveryFailureOutcome(new TypeError("fetch failed"))).toBe("request_failed");
  });
});
